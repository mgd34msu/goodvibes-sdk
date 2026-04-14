import { ConfigurationError } from '@pellux/goodvibes-errors';
import {
  createOperatorSdk,
  type OperatorSdk,
  type OperatorSdkOptions,
} from '@pellux/goodvibes-operator-sdk';
import {
  createPeerSdk,
  type PeerSdk,
  type PeerSdkOptions,
} from '@pellux/goodvibes-peer-sdk';
import type {
  AuthTokenResolver,
  HeaderResolver,
  HttpRetryPolicy,
  StreamReconnectPolicy,
} from '@pellux/goodvibes-transport-http';
import {
  createEventSourceConnector,
  createRemoteRuntimeEvents,
  createWebSocketConnector,
  type RemoteRuntimeEvents,
} from '@pellux/goodvibes-transport-realtime';
import {
  createGoodVibesAuthClient,
  createMemoryTokenStore,
  type GoodVibesAuthClient,
  type GoodVibesTokenStore,
} from './auth.js';

export interface RuntimeEventRecord {
  readonly type: string;
}

export interface GoodVibesSdkOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null;
  readonly getAuthToken?: AuthTokenResolver;
  readonly tokenStore?: GoodVibesTokenStore;
  readonly fetch?: typeof fetch;
  readonly headers?: HeadersInit;
  readonly getHeaders?: HeaderResolver;
  readonly retry?: HttpRetryPolicy;
  readonly WebSocketImpl?: typeof WebSocket;
  readonly realtime?: GoodVibesRealtimeOptions;
}

export interface GoodVibesRealtimeOptions {
  readonly sseReconnect?: StreamReconnectPolicy;
  readonly webSocketReconnect?: StreamReconnectPolicy;
  readonly onError?: (error: unknown) => void;
}

export interface GoodVibesRealtime {
  viaSse(): RemoteRuntimeEvents<RuntimeEventRecord>;
  viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord>;
}

export interface GoodVibesSdk {
  readonly operator: OperatorSdk;
  readonly peer: PeerSdk;
  readonly auth: GoodVibesAuthClient;
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

function createOperatorOptions(options: GoodVibesSdkOptions): OperatorSdkOptions {
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
  };
}

function createPeerOptions(options: GoodVibesSdkOptions): PeerSdkOptions {
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
  };
}

export function createGoodVibesSdk(
  options: GoodVibesSdkOptions,
): GoodVibesSdk {
  const baseUrl = requireBaseUrl(options.baseUrl);
  const tokenStore = options.tokenStore ?? (options.getAuthToken ? null : createMemoryTokenStore(options.authToken ?? null));
  const authToken = options.authToken ?? null;
  const getAuthToken = tokenStore
    ? () => tokenStore.getToken()
    : options.getAuthToken;
  const fetchImpl = () => requireFetchImplementation(options.fetch);
  const operator = createOperatorSdk(createOperatorOptions({
    ...options,
    tokenStore: tokenStore ?? undefined,
  }));
  const peer = createPeerSdk(createPeerOptions({
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
          createEventSourceConnector(baseUrl, getAuthToken ?? authToken, fetchImpl(), {
            reconnect: options.realtime?.sseReconnect,
            onError: options.realtime?.onError,
          }),
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            baseUrl,
            getAuthToken ?? authToken,
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
