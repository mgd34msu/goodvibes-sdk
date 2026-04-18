import { ConfigurationError } from './_internal/errors/index.js';
import {
  createOperatorSdk,
  type OperatorSdk,
  type OperatorSdkOptions,
} from './_internal/operator/index.js';
import {
  createPeerSdk,
  type PeerSdk,
  type PeerSdkOptions,
} from './_internal/peer/index.js';
import type {
  AuthTokenResolver,
  HeaderResolver,
  HttpRetryPolicy,
  StreamReconnectPolicy,
  TransportMiddleware,
} from './_internal/transport-http/index.js';
import { normalizeAuthToken } from './_internal/transport-http/index.js';
import {
  createEventSourceConnector,
  createRemoteRuntimeEvents,
  createWebSocketConnector,
  type RemoteRuntimeEvents,
} from './_internal/transport-realtime/index.js';
import type { AnyRuntimeEvent } from './_internal/platform/runtime/events/index.js';
import {
  createGoodVibesAuthClient,
  createMemoryTokenStore,
  type AutoRefreshOptions,
  type GoodVibesAuthClient,
  type GoodVibesTokenStore,
} from './auth.js';
import {
  AutoRefreshCoordinator,
  createAutoRefreshMiddleware,
} from './_internal/platform/auth/index.js';
import type { SDKObserver } from './observer/index.js';

/**
 * Discriminated union of all runtime events emitted by the GoodVibes daemon.
 *
 * TypeScript narrows the full event shape (including all payload fields) when
 * matching on the `type` discriminant — no `as` casts required.
 *
 * Each domain's events are accessible via the per-domain feed:
 * ```ts
 * sdk.realtime.viaSse().then(events => {
 *   events.agents.on('AGENT_SPAWNING', (payload) => {
 *     console.log(payload.agentId, payload.task); // fully typed
 *   });
 * });
 * ```
 *
 * @see AnyRuntimeEvent for the full discriminated union type.
 */
export type RuntimeEventRecord = AnyRuntimeEvent;

/**
 * Options for constructing a GoodVibes SDK instance.
 *
 * ### Auth token precedence (highest → lowest)
 * 1. **`tokenStore`** — when present, `getToken()` is called on every request.
 *    Mutations (`login`, `setToken`, `clearToken`) persist back to the store.
 * 2. **`getAuthToken`** — a read-only async resolver. No persistence; mutations
 *    throw `ConfigurationError`.
 * 3. **`authToken`** — a static string (or `null`). Wrapped in a
 *    `createMemoryTokenStore` internally so mutations work in-process.
 *
 * Only provide one of the three. If none are supplied the SDK operates without
 * credentials (useful for public endpoints).
 */
export interface GoodVibesSdkOptions {
  /**
   * Base URL of the GoodVibes daemon, e.g. `'https://my-daemon.example.com'`.
   * Must be a non-empty string. A trailing slash is trimmed automatically.
   */
  readonly baseUrl: string;

  /**
   * Static auth token string. Internally wrapped in an in-memory token store,
   * so `sdk.auth.setToken()` / `sdk.auth.clearToken()` work.
   *
   * Lowest-precedence auth option — ignored when `tokenStore` or `getAuthToken`
   * is also provided.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/authentication.md
   */
  readonly authToken?: string | null;

  /**
   * Async token resolver called before every authenticated request.
   * Use this when your token lives outside the SDK (e.g. retrieved from a
   * framework session or an external secret store).
   *
   * When this option is set, `sdk.auth.writable` is `false` — calling
   * `setToken` / `clearToken` throws a `ConfigurationError`.
   *
   * Takes precedence over `authToken`; ignored when `tokenStore` is provided.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/authentication.md
   */
  readonly getAuthToken?: AuthTokenResolver;

  /**
   * A mutable token store implementing `getToken / setToken / clearToken`.
   * The SDK calls `getToken()` before every request and writes back via
   * `setToken()` after a successful `sdk.auth.login()`.
   *
   * Highest-precedence auth option — overrides both `getAuthToken` and
   * `authToken`. Use `createBrowserTokenStore()` (localStorage) or
   * `createMemoryTokenStore()` for common cases.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/authentication.md
   */
  readonly tokenStore?: GoodVibesTokenStore;

  /**
   * Custom `fetch` implementation. Falls back to `globalThis.fetch`.
   * Required in environments without a native fetch (e.g. older Node.js).
   */
  readonly fetch?: typeof fetch;

  /**
   * Static extra headers sent on every request, e.g.
   * `{ 'X-Tenant-Id': 'acme' }`.
   */
  readonly headers?: HeadersInit;

  /**
   * Async resolver for per-request headers. Called on each request after the
   * auth header is set. Useful for adding request-scoped tracing headers.
   */
  readonly getHeaders?: HeaderResolver;

  /**
   * HTTP retry policy for transient failures (408, 429, 5xx).
   * Runtime-specific factories (e.g. `createBrowserGoodVibesSdk`,
   * `createReactNativeGoodVibesSdk`) apply sensible defaults; pass this to override.
   */
  readonly retry?: HttpRetryPolicy;

  /**
   * Custom `WebSocket` constructor. Falls back to `globalThis.WebSocket`.
   * Required in Node.js < 21 or when using a polyfill.
   */
  readonly WebSocketImpl?: typeof WebSocket;

  /**
   * Options that control realtime transport behaviour (SSE and WebSocket
   * reconnect policies, error callback).
   */
  readonly realtime?: GoodVibesRealtimeOptions;

  /**
   * Optional observer for SDK-level observability hooks.
   *
   * Pass a `SDKObserver` implementation (or one of the built-in adapters
   * like `createConsoleObserver` / `createOpenTelemetryObserver`) to receive
   * callbacks for auth transitions, transport activity, events, and errors.
   *
   * All observer methods are wrapped in a silent try/catch — observer
   * exceptions never propagate into SDK logic.
   */
  readonly observer?: SDKObserver;

  /**
   * Initial middleware chain applied to every HTTP request/response cycle.
   *
   * Middleware functions receive a mutable `TransportContext` and a `next()`
   * callback. They run in the order provided (outer-first, onion model).
   *
   * Additional middleware can be appended at any time via `sdk.use(mw)`.
   *
   * @example
   * const sdk = createGoodVibesSdk({
   *   baseUrl: 'https://daemon.example.com',
   *   middleware: [
   *     async (ctx, next) => {
   *       ctx.headers['X-Request-Id'] = crypto.randomUUID();
   *       await next();
   *     },
   *   ],
   * });
   */
  readonly middleware?: TransportMiddleware[];

  /**
   * Options for silent token auto-refresh.
   *
   * - `autoRefresh` — when `false`, disables silent refresh entirely and lets
   *   401 responses propagate to the caller immediately. Default: `true`.
   * - `refreshLeewayMs` — milliseconds before token expiry to trigger a
   *   pre-flight refresh. Default: 60_000 (1 minute).
   * - `refresh` — optional callback invoked to obtain a new token on pre-flight
   *   leeway trigger or reactive 401. When absent, pre-flight is a no-op and
   *   401 retry re-reads the token store (useful when an external party updates
   *   it). See `AutoRefreshOptions.refresh` for a full example.
   */
  readonly autoRefresh?: AutoRefreshOptions;
}

/**
 * Options controlling realtime transport behaviour.
 */
export interface GoodVibesRealtimeOptions {
  readonly sseReconnect?: StreamReconnectPolicy;
  readonly webSocketReconnect?: StreamReconnectPolicy;
  readonly onError?: (error: unknown) => void;
}

/**
 * Realtime event subscriptions for the GoodVibes daemon.
 * Choose SSE for read-only event streams or WebSocket for bidirectional use.
 *
 * ### Filtering by session
 *
 * When multiple sessions share one SSE/WebSocket connection, use
 * `forSession(events, sessionId)` to get a pre-filtered view instead of
 * manually guarding every callback with `if (e.sessionId !== mine) return`.
 *
 * @example
 * import { createGoodVibesSdk, forSession } from '@pellux/goodvibes-sdk';
 *
 * const sdk = createGoodVibesSdk({ baseUrl: 'http://127.0.0.1:3210' });
 * const session = await sdk.operator.sessions.create({ title: 'demo' });
 * const sessionId = session.session.id;
 *
 * const events = sdk.realtime.viaSse();
 * const sessionEvents = forSession(events, sessionId);
 *
 * sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   process.stdout.write(e.payload.content); // only fires for this session
 * });
 */
export interface GoodVibesRealtime {
  viaSse(): RemoteRuntimeEvents<RuntimeEventRecord>;
  viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord>;
}

/**
 * The GoodVibes SDK instance returned by `createGoodVibesSdk` (and its
 * runtime-specific wrappers).
 *
 * Three primary namespaces:
 * - **`operator`** — full control-plane API (daemon admin, agent management,
 *   session lifecycle, config). Requires an operator-level auth token.
 * - **`peer`** — peer-to-peer and collaboration APIs (pairing, channels,
 *   shared sessions). May be used with peer-scoped tokens.
 * - **`realtime`** — subscribe to live daemon events via SSE or WebSocket.
 * - **`auth`** — login, logout, and token management helpers.
 */
export interface GoodVibesSdk {
  /**
   * Full control-plane API: daemon admin, agent management, session lifecycle,
   * config. Requires an operator-level auth token.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/reference-operator.md
   */
  readonly operator: OperatorSdk;
  /**
   * Peer-to-peer and collaboration APIs: pairing, channels, shared sessions.
   * May be used with peer-scoped tokens.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/reference-peer.md
   */
  readonly peer: PeerSdk;
  /**
   * Login, logout, and token management helpers.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/authentication.md
   */
  readonly auth: GoodVibesAuthClient;
  /**
   * Subscribe to live daemon events via SSE or WebSocket.
   *
   * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/realtime-and-telemetry.md
   */
  readonly realtime: GoodVibesRealtime;
  /**
   * Append a middleware to the SDK's HTTP transport chain.
   *
   * Multiple `use()` calls compose in order (outer-first). The method is
   * idempotent in the sense that each call simply appends — call it once per
   * middleware to avoid double-registration.
   *
   * @example
   * sdk.use(async (ctx, next) => {
   *   ctx.headers['X-Tenant-Id'] = 'acme';
   *   await next();
   * });
   */
  use(middleware: TransportMiddleware): void;
}

function requireBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new ConfigurationError('GoodVibes baseUrl is required. Pass a non-empty baseUrl in your createGoodVibesSdk options (e.g. "https://my-daemon.example.com").');
  }
  return normalized;
}

function requireFetchImplementation(fetchImpl?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'Fetch implementation is required. Pass options.fetch or use a runtime that provides global fetch.',
    );
  }
  return resolved;
}

function requireWebSocketImplementation(webSocketImpl?: typeof WebSocket): typeof WebSocket {
  const resolved = webSocketImpl ?? globalThis.WebSocket;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'WebSocket implementation is required. Pass options.WebSocketImpl or use a runtime that provides global WebSocket.',
    );
  }
  return resolved;
}

function createClientOptions<T extends OperatorSdkOptions | PeerSdkOptions>(
  options: GoodVibesSdkOptions,
): T {
  const getAuthToken = options.tokenStore
    ? () => options.tokenStore!.getToken()
    : options.getAuthToken;
  return {
    baseUrl: requireBaseUrl(options.baseUrl),
    authToken: options.authToken ?? null,
    ...(getAuthToken ? { getAuthToken } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.getHeaders ? { getHeaders: options.getHeaders } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.middleware ? { middleware: options.middleware } : {}),
  } as T;
}

/**
 * Create a GoodVibes SDK instance.
 *
 * This is the runtime-agnostic constructor. For environments with sensible
 * defaults already configured, prefer the platform-specific wrappers:
 * `createBrowserGoodVibesSdk`, `createReactNativeGoodVibesSdk`.
 *
 * @see https://github.com/mgd34msu/goodvibes-sdk/blob/main/docs/getting-started.md
 *
 * @example
 * // Example only: replace baseUrl and authToken with your own values.
 * import { createGoodVibesSdk } from '@pellux/goodvibes-sdk';
 *
 * const sdk = createGoodVibesSdk({
 *   baseUrl: 'https://daemon.example.com',
 *   authToken: process.env.GV_TOKEN,
 * });
 *
 * const agents = await sdk.operator.agents.list();
 * console.log(agents);
 */
export function createGoodVibesSdk(
  options: GoodVibesSdkOptions,
): GoodVibesSdk {
  const baseUrl = requireBaseUrl(options.baseUrl);
  const tokenStore = options.tokenStore ?? (options.getAuthToken ? null : createMemoryTokenStore(options.authToken ?? null));
  const getAuthToken = tokenStore
    ? () => tokenStore.getToken()
    : options.getAuthToken;
  // Single normalized resolver used by realtime connectors.
  const tokenResolver = normalizeAuthToken(getAuthToken ?? options.authToken ?? undefined);
  const fetchImpl = () => requireFetchImplementation(options.fetch);

  const { observer } = options;

  // Build the auto-refresh coordinator when a writable token store is present
  // and autoRefresh is not explicitly disabled.
  const autoRefreshEnabled = (options.autoRefresh?.autoRefresh ?? true) && tokenStore !== null;
  const coordinator: AutoRefreshCoordinator | null = autoRefreshEnabled && tokenStore
    ? new AutoRefreshCoordinator({
        tokenStore,
        autoRefresh: true,
        refreshLeewayMs: options.autoRefresh?.refreshLeewayMs ?? 60_000,
        refresh: options.autoRefresh?.refresh,
        observer,
      })
    : null;

  // Build the merged middleware list: auto-refresh first (if enabled), then
  // consumer-provided middleware. This ensures the auto-refresh pre-flight runs
  // before any consumer middleware sees ctx.headers.Authorization, and that the
  // reactive 401 retry is transparent to consumer middleware.
  //
  // The transport reference for the retry callback is resolved lazily: we pass
  // a proxy object whose `requestJson` property is populated immediately after
  // createOperatorSdk / createPeerSdk returns. Because the middleware only calls
  // `transport.requestJson` on a reactive 401 (not at construction time), the
  // holder is always populated before it is accessed.
  // Lazy transport proxy: populated after createOperatorSdk / createPeerSdk.
  // The middleware only invokes requestJson on a reactive 401 — never at
  // construction time — so the proxy is always populated before first use.
  let operatorRequestJson: ((url: string, opts?: unknown) => Promise<unknown>) | null = null;
  let peerRequestJson: ((url: string, opts?: unknown) => Promise<unknown>) | null = null;

  const buildMiddleware = (
    getRequestJson: () => ((url: string, opts?: unknown) => Promise<unknown>) | null,
  ): TransportMiddleware[] => {
    const mws: TransportMiddleware[] = [];
    if (coordinator) {
      // Wrap the coordinator + lazy transport reference into a minimal proxy
      // that satisfies createAutoRefreshMiddleware's Pick<HttpJsonTransport, 'requestJson'>.
      const transportProxy = {
        requestJson<T>(url: string, opts?: unknown): Promise<T> {
          const rj = getRequestJson();
          if (!rj) throw new Error('Auto-refresh: transport not yet initialised');
          return rj(url, opts) as Promise<T>;
        },
      };
      mws.push(createAutoRefreshMiddleware(coordinator, transportProxy, tokenStore!));
    }
    if (options.middleware) {
      mws.push(...options.middleware);
    }
    return mws;
  };

  const operator = createOperatorSdk(createClientOptions<OperatorSdkOptions>({
    ...options,
    tokenStore: tokenStore ?? undefined,
    middleware: buildMiddleware(() => operatorRequestJson),
  }));
  // Populate the lazy reference now that the transport is fully constructed.
  operatorRequestJson = (url, opts) => operator.transport.requestJson(url, opts as never);

  const peer = createPeerSdk(createClientOptions<PeerSdkOptions>({
    ...options,
    tokenStore: tokenStore ?? undefined,
    middleware: buildMiddleware(() => peerRequestJson),
  }));
  // Populate the lazy reference now that the transport is fully constructed.
  peerRequestJson = (url, opts) => peer.transport.requestJson(url, opts as never);

  return {
    operator,
    peer,
    auth: createGoodVibesAuthClient(operator, tokenStore, getAuthToken, observer, options.autoRefresh, coordinator),
    use(middleware: TransportMiddleware): void {
      operator.transport.use(middleware);
      peer.transport.use(middleware);
    },
    realtime: {
      viaSse(): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createEventSourceConnector<AnyRuntimeEvent>(baseUrl, tokenResolver, fetchImpl(), {
            reconnect: options.realtime?.sseReconnect,
            onError: options.realtime?.onError,
            observer,
          }),
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector<AnyRuntimeEvent>(
            baseUrl,
            tokenResolver,
            requireWebSocketImplementation(webSocketImpl ?? options.WebSocketImpl),
            {
              reconnect: options.realtime?.webSocketReconnect,
              onError: options.realtime?.onError,
              observer,
            },
          ),
        );
      },
    },
  };
}
