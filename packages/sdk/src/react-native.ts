import { ConfigurationError } from '@pellux/goodvibes-errors';

export { forSession } from './_companion-realtime.js';
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

export interface ReactNativeGoodVibesSdkOptions extends GoodVibesSdkOptions {
  readonly WebSocketImpl?: typeof WebSocket | undefined;
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

/**
 * Create a GoodVibes SDK instance for React Native.
 *
 * Key differences from the browser factory:
 * - Realtime is WebSocket-only (`realtime.runtime()` / `realtime.viaWebSocket()`).
 *   SSE is not available in React Native.
 * - Requires a `WebSocket` implementation (e.g. the global provided by the
 *   React Native runtime or the `react-native` package). Pass
 *   `options.WebSocketImpl` when the global is not available.
 * - Returns `ReactNativeGoodVibesSdk` (extends `GoodVibesSdk` with a
 *   React-Native-specific `realtime` namespace).
 *
 * @example
 * // Example only: replace baseUrl and authToken with your own values.
 * import { createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
 *
 * const sdk = createReactNativeGoodVibesSdk({
 *   baseUrl: 'https://daemon.example.com',
 *   authToken: await SecureStore.getItemAsync('token'),
 * });
 *
 * const events = sdk.realtime.viaWebSocket();
 * events.agents.on('AGENT_SPAWNING', ({ agentId }) => console.log(agentId));
 */
export function createReactNativeGoodVibesSdk(
  options: ReactNativeGoodVibesSdkOptions,
): ReactNativeGoodVibesSdk {
  // Normalize baseUrl once — trimmed and validated — so both HTTP and WebSocket
  // connectors use the same value regardless of how the caller passed it.
  const baseUrl = options.baseUrl.trim();
  const base = createGoodVibesSdk({
    ...options,
    // Default retry: 3 attempts with exponential back-off capped at 2 s.
    // React Native links can be flaky (radio, background suspension) so a
    // conservative retry budget prevents cascading failures.
    retry: options.retry ?? {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    },
    realtime: {
      ...(options.realtime ?? {}),
      webSocketReconnect: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        ...(options.realtime?.webSocketReconnect ?? {}),
      },
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
            baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(options.WebSocketImpl),
            {
              reconnect: options.realtime?.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
          {
            onError: (error) => options.realtime?.onError?.(error),
          },
        );
      },
      viaWebSocket(webSocketImpl?: typeof WebSocket): RemoteRuntimeEvents<RuntimeEventRecord> {
        return createRemoteRuntimeEvents(
          createWebSocketConnector(
            baseUrl,
            getAuthToken,
            requireReactNativeWebSocket(webSocketImpl ?? options.WebSocketImpl),
            {
              reconnect: options.realtime?.webSocketReconnect,
              onError: options.realtime?.onError,
            },
          ),
          {
            onError: (error) => options.realtime?.onError?.(error),
          },
        );
      },
    },
  };
}

export {
  createIOSKeychainTokenStore,
  type IOSKeychainTokenStore,
  type IOSKeychainTokenStoreOptions,
  type KeychainAccessible,
} from './client-auth/ios-keychain-token-store.js';

export {
  createAndroidKeystoreTokenStore,
  type AndroidKeystoreTokenStore,
  type AndroidKeystoreTokenStoreOptions,
  type AndroidAccessControl,
  type AndroidAccessible,
} from './client-auth/android-keystore-token-store.js';
