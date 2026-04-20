import { logger } from '../utils/logger.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEvent } from '../hooks/types.js';
import {
  authenticateOperatorRequest,
  buildOperatorSessionCookie,
} from '../security/http-auth.js';
import { UserAuthManager } from '../security/user-auth.js';
import { ConfigManager } from '../config/manager.js';
import { extractForwardedClientIp, resolveInboundTlsContext, type ResolvedInboundTlsContext } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { requirePortAvailable } from './port-check.js';
import { resolveHostBinding } from './host-resolver.js';
import { createHostModeRestartWatcher } from './host-mode-watcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  hookDispatcher?: HookDispatcher;
  configManager: ConfigManager;
  serveFactory?: typeof Bun.serve;
  /** Max requests per 60-second window per IP. Default: 60. */
  rateLimit?: number;
  /** Max POST /login attempts per 60-second window per IP. Default: 5. */
  loginRateLimit?: number;
  /**
   * When true, x-forwarded-for / x-real-ip headers are trusted for client IP
   * extraction (rate limiting, audit logging). Only enable behind a trusted
   * reverse proxy. Overrides the httpListener.trustProxy config value when set.
   */
  trustProxy?: boolean;
  /** Pre-configured UserAuthManager owned by the runtime service graph. */
  userAuth: UserAuthManager;
}

interface HttpDangerConfig {
  httpListener: boolean;
}

// ---------------------------------------------------------------------------
// Rate limiter (sliding window per IP, in-memory)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
/** Entries older than this are eligible for TTL eviction. Default: 10 minutes. */
const RATE_TTL_MS = 10 * 60_000;
/** Maximum number of IP entries kept in the limiter at any time (LRU eviction). */
const RATE_MAX_ENTRIES = 10_000;
/** How often the background sweep runs to evict expired entries (ms). */
const RATE_SWEEP_INTERVAL_MS = 60_000;

class RateLimiter {
  /** hits[ip] = sorted ascending array of request timestamps within the window */
  private counts = new Map<string, number[]>();
  /** Insertion-order LRU: tracks which IP was most recently active */
  private accessOrder: string[] = [];
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private limit: number) {
    // Periodic sweep to evict entries whose TTL has expired (C5 fix)
    this.sweepInterval = setInterval(() => this._sweep(), RATE_SWEEP_INTERVAL_MS);
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW_MS;
    const hits = (this.counts.get(ip) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    this.counts.set(ip, hits);

    // Maintain LRU access order
    const idx = this.accessOrder.indexOf(ip);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(ip);

    // Evict oldest entry when cap is exceeded
    if (this.accessOrder.length > RATE_MAX_ENTRIES) {
      const evict = this.accessOrder.shift()!;
      this.counts.delete(evict);
    }

    return hits.length <= this.limit;
  }

  /** Stop the background sweep interval. Call this when the listener stops. */
  stop(): void {
    if (this.sweepInterval !== null) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /** Evict entries whose last-seen timestamp is older than RATE_TTL_MS. */
  private _sweep(): void {
    const cutoff = Date.now() - RATE_TTL_MS;
    for (const [ip, hits] of this.counts) {
      // If the most recent hit is older than TTL, the entry is stale
      if (hits.length === 0 || hits[hits.length - 1] < cutoff) {
        this.counts.delete(ip);
        const idx = this.accessOrder.indexOf(ip);
        if (idx !== -1) this.accessOrder.splice(idx, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

/**
 * HttpListener — webhook listener, disabled by default.
 *
 * Enable via: danger.httpListener = true in config.
 * All routes require Bearer token auth (set via enable()).
 * POST /webhook — parse hook event, fire through HookDispatcher.
 * GET  /health  — liveness check.
 * Rate limited to 60 requests/minute per IP by default.
 */
export class HttpListener {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private allowedOrigins: string[];
  private hookDispatcher: HookDispatcher | null;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private rateLimiter: RateLimiter;
  /** Dedicated tight rate-limiter for POST /login (SEC-03). */
  private loginRateLimiter: RateLimiter;
  /** Whether to trust x-forwarded-for / x-real-ip for client IP resolution. */
  private trustProxy: boolean;
  private readonly configManager: ConfigManager;
  private readonly serveFactory: typeof Bun.serve;
  private tlsState: ResolvedInboundTlsContext | null = null;
  /** Unsubscribe from httpListener config key watchers; cleared on stop(). */
  private _configWatchUnsub: (() => void) | null = null;
  /** True while a config-driven restart is in progress — prevents re-entrancy. */
  private _restarting = false;
  /** Awaitable promise for the active restart cycle; null when idle. */
  private _restartingPromise: Promise<void> | null = null;
  /** True if a config change arrived while _restarting was set; triggers a second cycle. */
  private _restartDirty = false;

  constructor(private config: HttpListenerConfig) {
    this.configManager = config.configManager;
    const resolvedHttpBinding = resolveHostBinding(
      (this.configManager.get('httpListener.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
      String(this.configManager.get('httpListener.host') ?? '127.0.0.1'),
      Number(this.configManager.get('httpListener.port') ?? 3422),
      'httpListener',
    );
    this.port = config.port ?? resolvedHttpBinding.port;
    this.host = config.host ?? resolvedHttpBinding.host;
    this.allowedOrigins = config.allowedOrigins ?? [];

    // SEC-07: Refuse to construct when hostMode=network and allowedOrigins is not configured.
    // An empty allowedOrigins combined with a network-reachable bind is an open CSRF vector —
    // any browser-initiated cross-origin request will carry an Origin header and be accepted.
    const effectiveHostMode = (this.configManager.get('httpListener.hostMode') as string | undefined) ?? 'local';
    if (effectiveHostMode === 'network' && this.allowedOrigins.length === 0) {
      throw new Error(
        'SECURITY_UNSAFE_ORIGIN_CONFIG: hostMode=network requires non-empty allowedOrigins to prevent CSRF. '
        + 'Set config.httpListener.allowedOrigins to a list of trusted origins '
        + "(e.g. ['https://companion.example.com']).",
      );
    }
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.userAuth = config.userAuth;
    this.rateLimiter = new RateLimiter(config.rateLimit ?? 60);
    // SEC-03: /login gets its own tight budget (5 attempts/min per IP) to prevent
    // scrypt-cost-throttled online brute-force attacks.
    this.loginRateLimiter = new RateLimiter(config.loginRateLimit ?? 5);
    this.trustProxy = config.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy'));
    this.serveFactory = config.serveFactory ?? Bun.serve;
  }

  /**
   * Enable the listener. Requires danger.httpListener = true in config.
   * The provided token is used to authenticate all incoming requests.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: HttpDangerConfig, token?: string): boolean {
    if (!dangerConfig.httpListener) {
      logger.info('HttpListener.enable: danger.httpListener is false — not enabling');
      return false;
    }
    this.enabled = true;
    this.authToken = token ?? null;
    return true;
  }

  /**
   * Start listening. Refuses to start if not enabled.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('HTTP listener is disabled. Enable via danger.httpListener config.');
      return;
    }
    if (this.authToken === null) {
      logger.info('HttpListener: starting with session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('HttpListener: already running');
      return;
    }

    // Skip real OS port check when a mock serveFactory is injected (test-only path).
    if (this.serveFactory === Bun.serve) {
      await requirePortAvailable(this.port, this.host, 'HTTP listener');
    }
    const self = this;
    this.tlsState = resolveInboundTlsContext(this.configManager, 'httpListener');
    this.server = this.serveFactory({
      port: this.port,
      hostname: this.host,
      ...(this.tlsState.tls ? { tls: this.tlsState.tls } : {}),
      async fetch(req: Request): Promise<Response> {
        return self.handleRequest(req);
      },
    });

    this._attachHttpListenerConfigWatcher();
    logger.info('HttpListener started', {
      port: this.port,
      host: this.host,
      tlsMode: this.tlsState.mode,
      scheme: this.tlsState.scheme,
      trustProxy: this.tlsState.trustProxy,
    });
  }

  /**
   * Wait for any in-progress config-driven restart to settle.
   */
  async waitForRestart(): Promise<void> {
    // Loop to handle dirty-flag chained restarts: each cycle may spawn another.
    while (this._restartingPromise) await this._restartingPromise;
  }

  /**
   * Stop the listener.
   */
  async stop(): Promise<void> {
    if (this.server === null) return;

    // Tear down config watcher only on intentional stop, not mid-restart.
    // During a restart cycle (_restarting=true) the watcher must stay active so
    // config changes that arrive between stop() and the subsequent start() can be
    // captured by the dirty flag.
    if (!this._restarting) {
      this._configWatchUnsub?.();
      this._configWatchUnsub = null;
    }

    // Stop rate limiter sweep intervals before tearing down.
    this.rateLimiter.stop();
    this.loginRateLimiter.stop();
    this.server.stop(true);
    this.server = null;
    this.tlsState = null;
    logger.info('HttpListener stopped');
  }

  /**
   * Subscribe to httpListener binding keys and restart the server on change.
   * Called once from start() after the server is up. Clears itself on stop().
   */
  private _attachHttpListenerConfigWatcher(): void {
    if (this._configWatchUnsub) return; // idempotent

    const restart = (): void => {
      if (this._restarting) {
        // A change arrived mid-restart — queue a second cycle via dirty flag.
        // Check _restarting BEFORE isRunning: stop() runs synchronously inside the
        // restart IIFE, so isRunning may be false even while a restart is in progress.
        this._restartDirty = true;
        return;
      }
      if (!this.isRunning) return;
      this._restarting = true;
      this._restartingPromise = (async () => {
        try {
          logger.info('HttpListener: httpListener binding changed, restarting HTTP listener…');
          await this.stop();
          // Re-resolve host/port from updated config
          const newBinding = resolveHostBinding(
            (this.configManager.get('httpListener.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
            String(this.configManager.get('httpListener.host') ?? '127.0.0.1'),
            Number(this.configManager.get('httpListener.port') ?? 3422),
            'httpListener',
          );
          this.host = newBinding.host;
          this.port = newBinding.port;
          await this.start();
        } catch (err) {
          logger.error('HttpListener: restart after config change failed', { error: summarizeError(err) });
        } finally {
          this._restarting = false;
          // If a config change arrived while we were restarting, kick off a second
          // cycle BEFORE nulling _restartingPromise so waitForRestart() chains correctly.
          if (this._restartDirty) {
            this._restartDirty = false;
            restart(); // sets this._restartingPromise to the new cycle
          } else {
            this._restartingPromise = null;
          }
        }
      })();
    };

    // getIsRunning must also return true while a restart cycle is in progress
    // (_restarting=true) so that config changes arriving mid-restart reach the
    // dirty-flag path inside `restart`. When the server is intentionally stopped
    // (not mid-restart) isRunning and _restarting are both false.
    const watcher = createHostModeRestartWatcher({
      configManager: this.configManager,
      keys: ['httpListener.hostMode', 'httpListener.host', 'httpListener.port'],
      onRestart: restart,
      getIsRunning: () => this.isRunning || this._restarting,
    });
    this._configWatchUnsub = () => watcher.unsubscribe();
  }

  /**
   * Returns true if the listener is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private checkAuth(req: Request): boolean {
    return authenticateOperatorRequest(req, {
      sharedToken: this.authToken,
      userAuth: this.userAuth,
    }) !== null;
  }

  private async parseJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
    try {
      return await req.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const clientIp = extractForwardedClientIp(
      req,
      this.trustProxy || (this.tlsState?.trustProxy ?? false),
    ) ?? 'unknown';

    // SEC-07: CORS origin check applies to ALL paths (including /login).
    // Logic:
    //   - No Origin header → same-origin or non-browser request → allow.
    //   - Origin present + allowedOrigins empty → no allowlist configured; block to
    //     prevent CSRF even when hostMode is not 'network' (e.g. 'auto' with a
    //     network-reachable bind). Constructor already refuses hostMode=network with
    //     empty allowedOrigins at startup, but defence-in-depth covers the request path.
    //   - Origin present + allowedOrigins non-empty → check allowlist.
    const origin = req.headers.get('origin');
    if (origin !== null) {
      if (this.allowedOrigins.length === 0) {
        return Response.json({ error: 'CORS_NOT_CONFIGURED: no allowedOrigins set' }, { status: 403 });
      }
      if (!this.allowedOrigins.includes(origin)) {
        return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
      }
    }

    // SEC-03: /login route handled AFTER origin check and under its own tight
    // rate-limit budget (5/min per IP) to prevent online brute-force attacks.
    // x-forwarded-for is only trustworthy when running behind a trusted reverse proxy.
    if (url.pathname === '/login' && req.method === 'POST') {
      if (!this.loginRateLimiter.check(clientIp)) {
        return Response.json({ error: 'Too many requests' }, { status: 429 });
      }
      return this.handleLogin(req);
    }

    // General rate limiting for all other routes.
    if (!this.rateLimiter.check(clientIp)) {
      return Response.json({ error: 'Too many requests' }, { status: 429 });
    }

    // Auth check
    if (!this.checkAuth(req)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/webhook' && method === 'POST') {
      return this.handleWebhook(req);
    }

    if (pathname === '/health' && method === 'GET') {
      return Response.json({ status: 'ok' });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private async handleLogin(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.userAuth.authenticate(username, password);

    if (!user) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.userAuth.createSession(user.username);
    return Response.json({
      authenticated: true,
      token: session.token,
      username: session.username,
      expiresAt: session.expiresAt,
    }, {
      headers: {
        'Set-Cookie': buildOperatorSessionCookie(session.token, {
          req,
          expiresAt: session.expiresAt,
          trustProxy: this.tlsState?.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy')),
        }),
      },
    });
  }

  private async handleWebhook(req: Request): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    // Construct a HookEvent from the incoming payload
    const eventType = typeof body.event === 'string' ? body.event : 'webhook';
    const phase = typeof body.phase === 'string' ? body.phase : 'Post';

    const hookEvent: HookEvent = {
      path: `${phase}:webhook:${eventType}` as unknown as import('@pellux/goodvibes-sdk/platform/hooks/types').HookEventPath,
      phase: phase as HookEvent['phase'],
      category: 'workflow' as HookEvent['category'],
      specific: eventType,
      sessionId: '',
      timestamp: Date.now(),
      payload: body,
    };

    if (!this.hookDispatcher) {
      // No dispatcher wired — acknowledge without processing
      logger.info('HttpListener: no HookDispatcher wired, acknowledging without processing', {
        event: eventType,
      });
      return Response.json(
        { acknowledged: true, fired: false, reason: 'No HookDispatcher configured' },
        { status: 202 },
      );
    }

    try {
      const result = await this.hookDispatcher.fire(hookEvent);
      return Response.json(
        {
          acknowledged: true,
          fired: true,
          ok: result.ok,
          decision: result.decision ?? null,
          reason: result.reason ?? null,
          error: result.error ?? null,
        },
        { status: result.ok ? 200 : 422 },
      );
    } catch (err) {
      const message = summarizeError(err);
      logger.error('HttpListener: hook dispatch failed', { error: message });
      return Response.json({ error: `Hook dispatch failed: ${message}` }, { status: 500 });
    }
  }
}
