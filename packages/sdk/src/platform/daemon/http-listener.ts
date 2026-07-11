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
// Cloudflare IP ranges (maintained constant; do NOT fetch at runtime by default).
// Source: https://www.cloudflare.com/ips/
// Last reviewed: 2026-06-11
// ---------------------------------------------------------------------------

/** Cloudflare published IPv4 CIDR ranges (full list). */
const CLOUDFLARE_IPV4_CIDRS: ReadonlyArray<[string, number]> = [
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['108.162.192.0', 18],
  ['131.0.72.0', 22],
  ['141.101.64.0', 18],
  ['162.158.0.0', 15],
  ['172.64.0.0', 13],
  ['173.245.48.0', 20],
  ['188.114.96.0', 20],
  ['190.93.240.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
];

/** Cloudflare published IPv6 CIDR prefixes (prefix string, prefix-length pairs). */
const CLOUDFLARE_IPV6_PREFIXES: ReadonlyArray<[string, number]> = [
  ['2400:cb00::', 32],
  ['2606:4700::', 32],
  ['2803:f800::', 32],
  ['2405:b500::', 32],
  ['2405:8100::', 32],
  ['2a06:98c0::', 29],
  ['2c0f:f248::', 32],
];

function ipv4ToUint32(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return undefined;
    n = (n << 8) | v;
  }
  // Shift result to unsigned 32-bit
  return n >>> 0;
}

function isIpInCidr4(ip: string, cidrNet: string, prefixLen: number): boolean {
  const ipInt = ipv4ToUint32(ip);
  const netInt = ipv4ToUint32(cidrNet);
  if (ipInt === undefined || netInt === undefined) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

function isIpv6InPrefix(ip: string, prefix: string, prefixLen: number): boolean {
  try {
    // Normalize by expanding both to full 128-bit arrays
    const ipBytes = ipv6ToBytes(ip);
    const prefixBytes = ipv6ToBytes(prefix);
    if (!ipBytes || !prefixBytes) return false;
    const fullBytes = Math.floor(prefixLen / 8);
    const remainBits = prefixLen % 8;
    for (let i = 0; i < fullBytes; i++) {
      if (ipBytes[i] !== prefixBytes[i]) return false;
    }
    if (remainBits > 0 && fullBytes < 16) {
      const mask = (0xff << (8 - remainBits)) & 0xff;
      if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ipv6ToBytes(ip: string): Uint8Array | undefined {
  try {
    // Strip brackets if present (e.g. [::1])
    const clean = ip.replace(/^\[|\]$/g, '');
    // Reject zone IDs (e.g. fe80::1%eth0) — '%' is not valid in a routable address.
    if (clean.includes('%')) return undefined;
    const halves = clean.split('::');
    if (halves.length > 2) return undefined;
    const leftGroups = halves[0] ? halves[0].split(':') : [];
    const rightGroups = halves[1] ? halves[1].split(':') : [];
    const totalGroups = 8;
    const zeroGroups = totalGroups - leftGroups.length - rightGroups.length;
    if (zeroGroups < 0) return undefined;
    const groups = [
      ...leftGroups,
      ...Array(zeroGroups).fill('0'),
      ...rightGroups,
    ];
    if (groups.length !== 8) return undefined;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const g = groups[i]!;
      // Each group must be 1-4 hex characters — no leading garbage, no zone index fragments.
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      const v = parseInt(g, 16);
      // parseInt with a valid hex pattern never exceeds 0xffff, but guard defensively.
      if (v < 0 || v > 0xffff) return undefined;
      bytes[i * 2] = (v >> 8) & 0xff;
      bytes[i * 2 + 1] = v & 0xff;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the given IP address belongs to a Cloudflare-owned range.
 * Used to validate CF-Connecting-IP header trust: only trust it when the
 * connecting peer is actually a Cloudflare edge node.
 */
export function isCloudflareIp(ip: string): boolean {
  if (!ip) return false;
  // Strip IPv6-mapped IPv4 prefix (::ffff:a.b.c.d)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = v4mapped ? v4mapped[1]! : ip;
  // Try IPv4 ranges first
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    return CLOUDFLARE_IPV4_CIDRS.some(([net, len]) => isIpInCidr4(candidate, net, len));
  }
  // Try IPv6 prefixes
  return CLOUDFLARE_IPV6_PREFIXES.some(([prefix, len]) => isIpv6InPrefix(candidate, prefix, len));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number | undefined;
  host?: string | undefined;
  allowedOrigins?: string[] | undefined;
  hookDispatcher?: HookDispatcher | undefined;
  configManager: ConfigManager;
  serveFactory?: typeof Bun.serve | undefined;
  /** Max requests per 60-second window per IP. Default: 60. */
  rateLimit?: number | undefined;
  /** Max POST /login attempts per 60-second window per IP. Default: 5. */
  loginRateLimit?: number | undefined;
  /**
   * When true, x-forwarded-for / x-real-ip headers are trusted for client IP
   * extraction (rate limiting, audit logging). Only enable behind a trusted
   * reverse proxy. Overrides the httpListener.trustProxy config value when set.
   */
  trustProxy?: boolean | undefined;
  /**
   * When true, CORS enforcement is active:
   *   - Constructor refuses to start when hostMode=network and allowedOrigins is empty
   *   - Requests carrying an Origin header are validated against allowedOrigins
   * Default: false (permissive — no CORS enforcement). Opt-in for multi-user,
   * internet-exposed, or enterprise deployments where browser-based CSRF is a
   * concern. Home/single-user local deployments do not need this. When true,
   * allowedOrigins must be configured or hostMode must be local/loopback.
   */
  enforceCors?: boolean | undefined;
  /**
   * When true, extract the real client IP from CF-Connecting-IP ONLY when the
   * connecting peer address belongs to a Cloudflare-owned CIDR range.
   * Requires trustProxy=true. Prevents header-injection bypass: a peer that is
   * not a Cloudflare edge node cannot fake CF-Connecting-IP to manipulate rate
   * limiting. When trustProxy=false, CF-Connecting-IP is ignored regardless.
   * Default: false.
   */
  trustCloudflare?: boolean | undefined;
  /** Pre-configured UserAuthManager owned by the runtime service graph. */
  userAuth: UserAuthManager;
}

interface HttpDangerConfig {
  httpListener: boolean;
}

/**
 * Read the shared control-plane CORS allowlist (controlPlane.cors.allowedOrigins,
 * a comma-separated string) into a trimmed origin list. Reused by the webhook
 * HttpListener so it honors the same allowlist as the control-plane router.
 */
function readCorsAllowedOrigins(configManager: ConfigManager): string[] {
  return configManager
    .get('controlPlane.cors.allowedOrigins')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
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
  /** Opt-in strict CORS enforcement. Default false (permissive). */
  private enforceCors: boolean;
  private hookDispatcher: HookDispatcher | null;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  private rateLimiter: RateLimiter;
  /** Dedicated tight rate-limiter for POST /login. */
  private loginRateLimiter: RateLimiter;
  /** Whether to trust x-forwarded-for / x-real-ip for client IP resolution. */
  private trustProxy: boolean;
  /** When true, trust CF-Connecting-IP only from validated Cloudflare edge IPs. */
  private trustCloudflare: boolean;
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
    // CORS defaults come from the shared controlPlane.cors.* config (the same keys
    // the control-plane router honors) rather than a parallel httpListener.cors.*
    // surface. An explicit constructor config.allowedOrigins / config.enforceCors
    // still overrides. Default remains permissive because controlPlane.cors.enabled
    // defaults false.
    this.allowedOrigins = config.allowedOrigins ?? readCorsAllowedOrigins(this.configManager);
    this.enforceCors = config.enforceCors ?? (this.configManager.get('controlPlane.cors.enabled') === true);

    // When enforceCors is true, refuse to construct with hostMode=network + empty allowedOrigins.
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
    // /login gets its own tight budget (5 attempts/min per IP) to prevent
    // scrypt-cost-throttled online brute-force attacks.
    this.loginRateLimiter = new RateLimiter(config.loginRateLimit ?? 5);
    this.trustProxy = config.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy'));
    this.trustCloudflare = config.trustCloudflare ?? false;
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

    // Skip the OS port probe when the host injects a custom serve factory.
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
    // cap inbound JSON bodies at 1 MiB to prevent memory exhaustion.
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
    const effectiveTrustProxy = this.trustProxy || (this.tlsState?.trustProxy ?? false);
    let clientIp: string;
    if (this.trustCloudflare && effectiveTrustProxy) {
      // Extract peer IP via standard x-forwarded-for first to validate against CF ranges.
      const peerIp = extractForwardedClientIp(req, true) ?? 'unknown';
      const cfConnectingIp = req.headers.get('cf-connecting-ip')?.trim();
      if (cfConnectingIp && isCloudflareIp(peerIp)) {
        // Peer is a real Cloudflare edge node — trust the CF header.
        clientIp = cfConnectingIp;
      } else {
        // Not validated as a CF edge or no CF header — fall through without CF trust.
        // Use peerIp if available (x-forwarded-for from non-CF proxy), else 'unknown'.
        clientIp = peerIp;
      }
    } else {
      clientIp = extractForwardedClientIp(req, effectiveTrustProxy) ?? 'unknown';
    }
    let response: Response | null = null;
    try {
      response = await this._handleRequestInner(req, url, clientIp, requestId);
      return response;
    } finally {
      const status = response?.status ?? 500;
      const latencyMs = Date.now() - startMs;
      // structured HTTP access log — SIEM-ingestable
      logger.info('HTTP_ACCESS_LOG', {
        type: 'HTTP_ACCESS_LOG',
        requestId,
        method: req.method,
        path: url.pathname,
        status,
        latencyMs,
        clientIp,
      });
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

    // CORS origin check is opt-in via enforceCors. Default is permissive
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

    // /login route handled AFTER origin check and under its own tight
    // rate-limit budget (5/min per IP) to prevent online brute-force attacks.
    // x-forwarded-for is only trustworthy when running behind a trusted reverse proxy.
    if (url.pathname === '/login' && req.method === 'POST') {
      if (!this.loginRateLimiter.check(clientIp)) {
        return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      return this.handleLogin(req, clientIp, requestId);
    }

    // General rate limiting for all other routes.
    if (!this.rateLimiter.check(clientIp)) {
      return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
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
    const authResult = this.userAuth.authenticate(username, password);

    if (!authResult.ok) {
      // AUTH_FAILED — never log credential values
      const lockedUntilMs = authResult.lockedUntilMs;
      logger.warn('AUTH_FAILED', {
        type: 'AUTH_FAILED',
        requestId,
        clientIp,
        reason: lockedUntilMs ? 'account_locked' : 'invalid_credentials',
        // Never log usernameAttempted to avoid associating accounts with IPs in logs
      });
      authFailureTotal.add(1);
      if (lockedUntilMs) {
        const retryAfterSeconds = Math.ceil((lockedUntilMs - Date.now()) / 1_000);
        return Response.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': String(Math.max(1, retryAfterSeconds)) } },
        );
      }
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const { user } = authResult;
    const session = this.userAuth.createSession(user.username);
    // AUTH_SUCCEEDED — never log credential values
    authSuccessTotal.add(1);
    logger.info('AUTH_SUCCEEDED', {
      type: 'AUTH_SUCCEEDED',
      requestId,
      username: user.username,
      clientIp,
      method: 'password',
    });

    // Auto-retire the bootstrap credential file ONLY after the first
    // NON-bootstrap login. The bootstrap credential is a one-time convenience
    // artifact; retiring it immediately on a bootstrap login would prevent the
    // operator from logging in again if the session is lost before a real
    // account/password is established.
    if (!authResult.usedBootstrapCredential && this.userAuth.inspect().bootstrapCredentialPresent) {
      const retired = this.userAuth.clearBootstrapCredentialFile();
      if (retired) {
        logger.info('Bootstrap credential file retired after first non-bootstrap login', {
          username: user.username,
        });
      }
    }

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
