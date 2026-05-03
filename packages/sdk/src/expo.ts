import {
  createReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdkOptions,
} from './react-native.js';

export interface ExpoGoodVibesSdkOptions extends ReactNativeGoodVibesSdkOptions {}

/**
 * Create a GoodVibes SDK instance from the Expo-specific entrypoint.
 */
export { forSession } from './transport-realtime.js';

export function createExpoGoodVibesSdk(options: ExpoGoodVibesSdkOptions): ReactNativeGoodVibesSdk {
  return createReactNativeGoodVibesSdk(options);
}

export {
  createExpoSecureTokenStore,
  type ExpoSecureTokenStore,
  type ExpoSecureTokenStoreOptions,
  type ExpoSecureStoreAccessible,
} from './client-auth/expo-secure-token-store.js';
