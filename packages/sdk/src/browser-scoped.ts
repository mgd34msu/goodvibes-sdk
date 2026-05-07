import { ConfigurationError, ContractError } from '@pellux/goodvibes-errors';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@pellux/goodvibes-contracts/generated/foundation-client-types';
import type {
  AuthTokenResolver,
  HttpRetryPolicy,
  StreamReconnectPolicy,
  TransportMiddleware,
} from './transport-http.js';
import {
  createHttpTransport,
  openRawServerSentEventStream,
} from './transport-http.js';
import type {
  GoodVibesAuthClient,
  GoodVibesTokenStore,
} from './auth.js';
import {
  createGoodVibesAuthClient,
} from './auth.js';
import type { SDKObserver } from './observer/index.js';

export type BrowserScopedRouteDefinition = {
  readonly method: string;
  readonly path: string;
};

type JsonRecord = Record<string, unknown>;

export interface ScopedBrowserSdkOptions {
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | null | undefined;
  readonly getAuthToken?: AuthTokenResolver | undefined;
  readonly tokenStore?: GoodVibesTokenStore | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly WebSocketImpl?: typeof WebSocket | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly getHeaders?: (() => HeadersInit | undefined | Promise<HeadersInit | undefined>) | undefined;
  readonly retry?: HttpRetryPolicy | undefined;
  readonly middleware?: readonly TransportMiddleware[] | undefined;
  readonly realtime?: {
    readonly sseReconnect?: StreamReconnectPolicy | undefined;
    readonly onError?: ((error: unknown) => void) | undefined;
  } | undefined;
  readonly observer?: SDKObserver | undefined;
}

export interface ScopedInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: HeadersInit | undefined;
}

type ScopedInput<TMethodId extends OperatorTypedMethodId> = OperatorMethodInput<TMethodId>;
type ScopedOutput<TMethodId extends OperatorTypedMethodId> = OperatorMethodOutput<TMethodId>;

export interface ScopedOperatorClient<TMethodId extends OperatorTypedMethodId> {
  invoke<TSelectedMethodId extends TMethodId>(
    methodId: TSelectedMethodId,
    input?: ScopedInput<TSelectedMethodId>,
    options?: ScopedInvokeOptions,
  ): Promise<ScopedOutput<TSelectedMethodId>>;
}

export interface ScopedRuntimeEventEnvelope<TPayload extends { readonly type: string } = { readonly type: string }> {
  readonly type: string;
  readonly ts: number;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly source?: string | undefined;
  readonly payload: TPayload;
}

export interface ScopedRuntimeEventFeed<TPayload extends { readonly type: string } = { readonly type: string }> {
  on<TType extends string>(
    type: TType,
    listener: (payload: TPayload & { readonly type: TType }) => void,
  ): () => void;
  onEnvelope<TType extends string>(
    type: TType,
    listener: (envelope: ScopedRuntimeEventEnvelope<TPayload & { readonly type: TType }>) => void,
  ): () => void;
}

export type ScopedRuntimeEvents<TDomain extends string> = {
  readonly domains: readonly TDomain[];
  domain(domain: TDomain): ScopedRuntimeEventFeed;
} & { readonly [K in TDomain]: ScopedRuntimeEventFeed };

export interface ScopedBrowserSdk<TMethodId extends OperatorTypedMethodId, TDomain extends string> {
  readonly operator: ScopedOperatorClient<TMethodId>;
  readonly auth: GoodVibesAuthClient;
  readonly realtime: {
    viaSse(): ScopedRuntimeEvents<TDomain>;
  };
  use(middleware: TransportMiddleware): void;
}

const SHARED_BROWSER_ROUTES = {
  'accounts.snapshot': { method: 'GET', path: '/api/accounts' },
  'control.auth.current': { method: 'GET', path: '/api/control-plane/auth' },
  'control.auth.login': { method: 'POST', path: '/login' },
  'control.snapshot': { method: 'GET', path: '/api/control-plane' },
  'control.status': { method: 'GET', path: '/status' },
  'providers.get': { method: 'GET', path: '/api/providers/{providerId}' },
  'providers.list': { method: 'GET', path: '/api/providers' },
  'providers.usage.get': { method: 'GET', path: '/api/providers/{providerId}/usage' },
  'sessions.create': { method: 'POST', path: '/api/sessions' },
  'sessions.followUp': { method: 'POST', path: '/api/sessions/{sessionId}/follow-up' },
  'sessions.get': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'sessions.inputs.cancel': { method: 'POST', path: '/api/sessions/{sessionId}/inputs/{inputId}/cancel' },
  'sessions.inputs.list': { method: 'GET', path: '/api/sessions/{sessionId}/inputs' },
  'sessions.list': { method: 'GET', path: '/api/sessions' },
  'sessions.messages.create': { method: 'POST', path: '/api/sessions/{sessionId}/messages' },
  'sessions.messages.list': { method: 'GET', path: '/api/sessions/{sessionId}/messages' },
  'sessions.steer': { method: 'POST', path: '/api/sessions/{sessionId}/steer' },
} as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;

export type SharedBrowserMethodId = Extract<keyof typeof SHARED_BROWSER_ROUTES, OperatorTypedMethodId>;

export function resolveBrowserBaseUrl(baseUrl?: string): string {
  const explicit = baseUrl?.trim();
  if (explicit) return explicit;
  if (typeof globalThis.location?.origin === 'string' && globalThis.location.origin.trim()) {
    return globalThis.location.origin.trim();
  }
  throw new ConfigurationError(
    'Browser baseUrl is required when location.origin is unavailable.',
  );
}

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'Fetch implementation is required. Pass options.fetch or use a browser/runtime that provides global fetch.',
    );
  }
  return resolved;
}

function buildRouteError(methodId: string): ContractError {
  return new ContractError(
    `Operator method "${methodId}" is not available from this scoped browser SDK entrypoint. Import the matching scoped entrypoint instead of the full browser client.`,
  );
}

function createScopedOperatorClient<TMethodId extends OperatorTypedMethodId>(
  routes: Record<TMethodId, BrowserScopedRouteDefinition>,
  options: ScopedBrowserSdkOptions,
): {
  readonly operator: ScopedOperatorClient<TMethodId>;
  readonly requestJson: <T>(pathOrUrl: string, requestOptions?: Parameters<ReturnType<typeof createHttpTransport>['requestJson']>[1]) => Promise<T>;
  readonly getAuthToken: () => Promise<string | null>;
  readonly use: (middleware: TransportMiddleware) => void;
} {
  const transport = createHttpTransport({
    baseUrl: resolveBrowserBaseUrl(options.baseUrl),
    authToken: options.authToken ?? null,
    getAuthToken: options.tokenStore
      ? () => options.tokenStore!.getToken()
      : options.getAuthToken,
    fetch: resolveFetch(options.fetch),
    headers: options.headers,
    getHeaders: options.getHeaders,
    retry: options.retry,
    middleware: options.middleware,
    observer: options.observer,
  });

  const operator: ScopedOperatorClient<TMethodId> = {
    async invoke<TSelectedMethodId extends TMethodId>(
      methodId: TSelectedMethodId,
      input?: ScopedInput<TSelectedMethodId>,
      invokeOptions: ScopedInvokeOptions = {},
    ): Promise<ScopedOutput<TSelectedMethodId>> {
      const route = routes[methodId];
      if (!route) throw buildRouteError(methodId);
      const resolved = transport.resolveContractRequest(
        route.method,
        route.path,
        input && typeof input === 'object' && !Array.isArray(input)
          ? input as JsonRecord
          : {},
      );
      return await transport.requestJson<ScopedOutput<TSelectedMethodId>>(resolved.url, {
        method: resolved.method,
        body: resolved.body,
        headers: invokeOptions.headers,
        signal: invokeOptions.signal,
        methodId,
        idempotent: false,
      });
    },
  };

  return {
    operator,
    requestJson: (pathOrUrl, requestOptions) => transport.requestJson(pathOrUrl, requestOptions),
    getAuthToken: () => transport.getAuthToken(),
    use: (middleware) => transport.use(middleware),
  };
}

function createAuthOperatorShim<TMethodId extends OperatorTypedMethodId>(
  operator: ScopedOperatorClient<TMethodId>,
): {
  readonly control: {
    readonly auth: {
      current(): Promise<unknown>;
      login(input: unknown): Promise<unknown>;
    };
  };
} {
  return {
    control: {
      auth: {
        current: () => operator.invoke('control.auth.current' as TMethodId, {} as ScopedInput<TMethodId>),
        login: (input) => operator.invoke('control.auth.login' as TMethodId, input as ScopedInput<TMethodId>),
      },
    },
  };
}

type Listener<T> = (value: T) => void;

function createFeed(
  subscribe: (type: string, listener: (envelope: ScopedRuntimeEventEnvelope) => void) => () => void,
): ScopedRuntimeEventFeed {
  return {
    on(type, listener) {
      return subscribe(type, (envelope) => {
        listener(envelope.payload as { readonly type: typeof type });
      });
    },
    onEnvelope(type, listener) {
      return subscribe(type, listener as Listener<ScopedRuntimeEventEnvelope>);
    },
  };
}

function normalizeEnvelope(value: unknown): ScopedRuntimeEventEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const envelope = value as Record<string, unknown>;
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object') return null;
  const payloadType = (payload as Record<string, unknown>).type;
  if (typeof payloadType !== 'string') return null;
  return {
    type: typeof envelope.type === 'string' ? envelope.type : payloadType,
    ts: typeof envelope.ts === 'number'
      ? envelope.ts
      : typeof envelope.timestamp === 'number'
        ? envelope.timestamp
        : Date.now(),
    traceId: typeof envelope.traceId === 'string' ? envelope.traceId : undefined,
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : undefined,
    source: typeof envelope.source === 'string' ? envelope.source : undefined,
    payload: payload as { readonly type: string },
  };
}

function buildEventUrl(baseUrl: string, domain: string): string {
  const url = new URL('/api/control-plane/events', baseUrl);
  url.searchParams.set('domains', domain);
  return url.toString();
}

function createScopedRealtime<TDomain extends string>(
  domains: readonly TDomain[],
  options: ScopedBrowserSdkOptions,
  getAuthToken: () => Promise<string | null>,
): { viaSse(): ScopedRuntimeEvents<TDomain> } {
  return {
    viaSse(): ScopedRuntimeEvents<TDomain> {
      const baseUrl = resolveBrowserBaseUrl(options.baseUrl);
      const fetchImpl = resolveFetch(options.fetch);
      const feeds = new Map<TDomain, ScopedRuntimeEventFeed>();
      const activeByDomain = new Map<TDomain, {
        listenersByType: Map<string, Set<Listener<ScopedRuntimeEventEnvelope>>>;
        closed: boolean;
        disconnect?: (() => void) | undefined;
      }>();

      const ensureDomain = (domain: TDomain) => {
        let active = activeByDomain.get(domain);
        if (active) return active;
        active = { listenersByType: new Map(), closed: false };
        activeByDomain.set(domain, active);
        void openRawServerSentEventStream(
          fetchImpl,
          buildEventUrl(baseUrl, domain),
          {
            onEvent: (eventName, payload) => {
              if (eventName !== domain) return;
              const envelope = normalizeEnvelope(payload);
              if (!envelope) return;
              for (const listener of [...(active!.listenersByType.get(envelope.payload.type) ?? [])]) {
                listener(envelope);
              }
            },
            onError: (error) => options.realtime?.onError?.(error),
          },
          {
            reconnect: options.realtime?.sseReconnect,
            getAuthToken,
          },
        ).then((disconnect) => {
          if (active!.closed || activeByDomain.get(domain) !== active) {
            disconnect();
            return;
          }
          active!.disconnect = disconnect;
        }).catch((error) => {
          options.realtime?.onError?.(error);
        });
        return active;
      };

      const getFeed = (domain: TDomain) => {
        let feed = feeds.get(domain);
        if (feed) return feed;
        feed = createFeed((type, listener) => {
          const active = ensureDomain(domain);
          const listeners = active.listenersByType.get(type) ?? new Set<Listener<ScopedRuntimeEventEnvelope>>();
          listeners.add(listener);
          active.listenersByType.set(type, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) active.listenersByType.delete(type);
            if (active.listenersByType.size === 0) {
              active.closed = true;
              active.disconnect?.();
              activeByDomain.delete(domain);
            }
          };
        });
        feeds.set(domain, feed);
        return feed;
      };

      return Object.freeze({
        domains,
        domain: getFeed,
        ...Object.fromEntries(domains.map((domain) => [domain, getFeed(domain)])),
      }) as ScopedRuntimeEvents<TDomain>;
    },
  };
}

export function forScopedBrowserSession<TDomain extends string>(
  events: ScopedRuntimeEvents<TDomain>,
  sessionId: string,
): ScopedRuntimeEvents<TDomain> {
  const feeds = new Map<TDomain, ScopedRuntimeEventFeed>();
  const getFeed = (domain: TDomain) => {
    let feed = feeds.get(domain);
    if (feed) return feed;
    const baseFeed = events.domain(domain);
    feed = {
      on(type, listener) {
        return baseFeed.onEnvelope(type, (envelope) => {
          if (envelope.sessionId !== sessionId) return;
          listener(envelope.payload as { readonly type: typeof type });
        });
      },
      onEnvelope(type, listener) {
        return baseFeed.onEnvelope(type, (envelope) => {
          if (envelope.sessionId !== sessionId) return;
          listener(envelope as ScopedRuntimeEventEnvelope<{ readonly type: typeof type }>);
        });
      },
    };
    feeds.set(domain, feed);
    return feed;
  };
  return Object.freeze({
    domains: events.domains,
    domain: getFeed,
    ...Object.fromEntries(events.domains.map((domain) => [domain, getFeed(domain)])),
  }) as ScopedRuntimeEvents<TDomain>;
}

export function createScopedBrowserSdk<TMethodId extends OperatorTypedMethodId, TDomain extends string>(
  routes: Record<TMethodId, BrowserScopedRouteDefinition>,
  domains: readonly TDomain[],
  options: ScopedBrowserSdkOptions = {},
): ScopedBrowserSdk<TMethodId, TDomain> {
  const scoped = createScopedOperatorClient(routes, options);
  const auth = createGoodVibesAuthClient(
    createAuthOperatorShim(scoped.operator) as never,
    options.tokenStore ?? null,
    options.getAuthToken,
    options.observer,
    undefined,
    null,
  );
  return {
    operator: scoped.operator,
    auth,
    realtime: createScopedRealtime(domains, options, scoped.getAuthToken),
    use: scoped.use,
  };
}

export { SHARED_BROWSER_ROUTES };
