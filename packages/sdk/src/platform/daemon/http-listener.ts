import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import {
  authFailureTotal,
  authSuccessTotal,
  httpRequestDurationMs,
  httpRequestsTotal,
} from '../runtime/metrics.js';
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
import { RateLimiter } from './http/rate-limiter.js';
import { readTextBodyWithinLimit } from '../utils/request-body.js';

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
  /**
   * When true, CORS enforcement is active:
   *   - Constructor refuses to start when hostMode=network and allowedOrigins is empty
   *   - Requests carrying an Origin header are validated against allowedOrigins
   * Default: false (permissive — no CORS enforcement). Opt-in for multi-user,
   * internet-exposed, or enterprise deployments where browser-based CSRF is a
   * concern. Home/single-user local deployments do not need this and the default
   * behavior matches pre-0.21.29 semantics. When true, allowedOrigins must be
   * configured (or hostMode must be local/loopback) — see SEC-07.
   */
  enforceCors?: boolean;
  /** Pre-configured UserAuthManager owned by the runtime service graph. */
  userAuth: UserAuthManager;
}

interface HttpDangerConfig {
  httpListener: boolean;
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
  /** SEC-07: opt-in strict CORS enforcement. Default false (permissive). */
  private enforceCors: boolean;
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
    this.enforceCors = config.enforceCors ?? false;

    // SEC-07: When enforceCors is true, refuse to construct with hostMode=network + empty allowedOrigins.
    // Off by default — home and single-user local deployments don't need CORS enforcement.
    // Enterprise / multi-user / internet-exposed deployments set enforceCors: true to gate against CSRF.
    if (this.enforceCors) {
      const effectiveHostMode = (this.configManager.get('httpListener.hostMode') as string | undefined) ?? 'local';
      if (effectiveHostMode === 'network' && this.allowedOrigins.length === 0) {
        throw new Error(
          'SECURITY_UNSAFE_ORIGIN_CONFIG: hostMode=network with enforceCors=true requires non-empty allowedOrigins. '
          + 'Set config.httpListener.allowedOrigins to a list of trusted origins '
          + "(e.g. ['https://companion.example.com']), or leave enforceCors unset for permissive mode.",
        );
      }
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
    // SEC-05: cap inbound JSON bodies at 1 MiB to prevent memory exhaustion.
    const MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB
    try {
      const text = await readTextBodyWithinLimit(req, MAX_JSON_BYTES);
      if (text instanceof Response) return text;
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const requestId = randomUUID();
    const startMs = Date.now();
    const url = new URL(req.url);
    const clientIp = extractForwardedClientIp(
      req,
      this.trustProxy || (this.tlsState?.trustProxy ?? false),
    ) ?? 'unknown';
    let response: Response | null = null;
    try {
      response = await this._handleRequestInner(req, url, clientIp, requestId);
      return response;
    } finally {
      const status = response?.status ?? 500;
      const latencyMs = Date.now() - startMs;
      // OBS-01: structured HTTP access log — SIEM-ingestable
      logger.info('HTTP_ACCESS_LOG', {
        type: 'HTTP_ACCESS_LOG',
        requestId,
        method: req.method,
        path: url.pathname,
        status,
        latencyMs,
        clientIp,
      });
      // C-1: record HTTP metric instruments
      const statusClass = status >= 500 ? '5xx' : status >= 400 ? '4xx' : '2xx';
      const pathPattern = url.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, '/:id');
      httpRequestsTotal.add(1, { method: req.method, status_class: statusClass });
      httpRequestDurationMs.record(latencyMs, { method: req.method, path_pattern: pathPattern, status_class: statusClass });
    }
  }

  private async _handleRequestInner(
    req: Request,
    url: URL,
    clientIp: string,
    requestId: string,
  ): Promise<Response> {

    // SEC-07: CORS origin check is OPT-IN via enforceCors. Default is permissive
    // for home and single-user deployments. When
    // enforceCors is true:
    //   - No Origin header → same-origin or non-browser request → allow.
    //   - Origin present + allowedOrigins empty → no allowlist configured; 403 CORS_NOT_CONFIGURED.
    //     (Constructor already refuses hostMode=network + empty allowlist at startup; this is
    //     defence-in-depth for non-network modes configured with enforceCors.)
    //   - Origin present + allowedOrigins non-empty → check allowlist.
    if (this.enforceCors) {
      const origin = req.headers.get('origin');
      if (origin !== null) {
        if (this.allowedOrigins.length === 0) {
          return Response.json({ error: 'CORS_NOT_CONFIGURED: no allowedOrigins set' }, { status: 403 });
        }
        if (!this.allowedOrigins.includes(origin)) {
          return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
        }
      }
    }

    // SEC-03: /login route handled AFTER origin check and under its own tight
    // rate-limit budget (5/min per IP) to prevent online brute-force attacks.
    // x-forwarded-for is only trustworthy when running behind a trusted reverse proxy.
    if (url.pathname === '/login' && req.method === 'POST') {
      if (!this.loginRateLimiter.check(clientIp)) {
        return Response.json({ error: 'Too many requests' }, { status: 429 });
      }
      return this.handleLogin(req, clientIp, requestId);
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

  private async handleLogin(req: Request, clientIp: string, requestId: string): Promise<Response> {
    const body = await this.parseJsonBody(req);
    if (body instanceof Response) return body;

    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = this.userAuth.authenticate(username, password);

    if (!user) {
      // OBS-02: AUTH_FAILED — never log credential values
      logger.warn('AUTH_FAILED', {
        type: 'AUTH_FAILED',
        requestId,
        usernameAttempted: username,
        clientIp,
        reason: 'invalid_credentials',
      });
      // C-1: record auth failure metric
      authFailureTotal.add(1);
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = this.userAuth.createSession(user.username);
    // OBS-02: AUTH_SUCCEEDED — never log credential values
    // C-1: record auth success metric
    authSuccessTotal.add(1);
    logger.info('AUTH_SUCCEEDED', {
      type: 'AUTH_SUCCEEDED',
      requestId,
      username: user.username,
      clientIp,
      method: 'password',
    });
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
      path: `${phase}:webhook:${eventType}` as unknown as import('../hooks/types.js').HookEventPath,
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
