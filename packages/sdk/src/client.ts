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
  type GoodVibesAuthClient,
  type GoodVibesTokenStore,
} from './auth.js';

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
}

function requireBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim();
  if (!normalized) {
    throw new ConfigurationError('GoodVibes baseUrl is required');
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
  const authToken = options.authToken ?? null;
  const getAuthToken = tokenStore
    ? () => tokenStore.getToken()
    : options.getAuthToken;
  // Single normalized resolver used by realtime connectors.
  const tokenResolver = normalizeAuthToken(getAuthToken ?? options.authToken ?? undefined);
  const fetchImpl = () => requireFetchImplementation(options.fetch);
  const operator = createOperatorSdk(createClientOptions<OperatorSdkOptions>({
    ...options,
    tokenStore: tokenStore ?? undefined,
  }));
  const peer = createPeerSdk(createClientOptions<PeerSdkOptions>({
    ...options,
    tokenStore: tokenStore ?? undefined,
  }));

  return {
    operator,
    peer,
    auth: createGoodVibesAuthClient(operator, tokenStore, getAuthToken),
    realtime: {
      viaSse(): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createEventSourceConnector(baseUrl, tokenResolver, fetchImpl(), {
            reconnect: options.realtime?.sseReconnect,
            onError: options.realtime?.onError,
          }),
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            baseUrl,
            tokenResolver,
            requireWebSocketImplementation(webSocketImpl ?? options.WebSocketImpl),
            {
              reconnect: options.realtime?.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
        );
      },
    },
  };
}
