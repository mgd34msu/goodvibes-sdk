import { ConfigurationError } from '@pellux/goodvibes-errors';
import {
  createRemoteRuntimeEvents,
  createWebSocketConnector,
  type RemoteRuntimeEvents,
} from '@pellux/goodvibes-transport-realtime';
import {
  createGoodVibesSdk,
  type GoodVibesSdkOptions,
  type GoodVibesSdk,
  type RuntimeEventRecord,
} from './client.js';

export interface ReactNativeGoodVibesSdkOptions
  extends Omit<GoodVibesSdkOptions, 'WebSocketImpl'> {
  readonly WebSocketImpl?: typeof WebSocket;
}

export interface ReactNativeGoodVibesRealtime {
  runtime(): RemoteRuntimeEvents<RuntimeEventRecord>;
  viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord>;
}

export type ReactNativeGoodVibesSdk =
  Omit<GoodVibesSdk, 'realtime'> & {
    readonly realtime: ReactNativeGoodVibesRealtime;
  };

function requireReactNativeWebSocket(webSocketImpl?: typeof WebSocket): typeof WebSocket {
  const resolved = webSocketImpl ?? globalThis.WebSocket;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'React Native realtime requires a WebSocket implementation. Pass options.WebSocketImpl or use a runtime that provides global WebSocket.',
    );
  }
  return resolved;
}

export function createReactNativeGoodVibesSdk(
  options: ReactNativeGoodVibesSdkOptions,
): ReactNativeGoodVibesSdk {
  const base = createGoodVibesSdk({
    ...options,
    retry: options.retry ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    },
    realtime: {
      sseReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.sseReconnect ?? {}),
      },
      webSocketReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.webSocketReconnect ?? {}),
      },
      ...(options.realtime ?? {}),
    },
    WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
  });
  const getAuthToken = () => base.auth.getToken();

  return {
    ...base,
    realtime: {
      runtime(): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            options.baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(options.WebSocketImpl),
            {
              reconnect: options.realtime?.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            options.baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(webSocketImpl ?? options.WebSocketImpl),
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
