import {
  createReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdkOptions,
} from './react-native.js';

// ExpoGoodVibesSdkOptions is intentionally identical to ReactNativeGoodVibesSdkOptions.
// A type alias avoids the empty-interface lint warning while preserving a
// distinct public name in the Expo entrypoint.
export type ExpoGoodVibesSdkOptions = ReactNativeGoodVibesSdkOptions;

export { forSession } from './_companion-realtime.js';

/**
 * Create a GoodVibes SDK instance from the Expo-specific entrypoint.
 */
export function createExpoGoodVibesSdk(options: ExpoGoodVibesSdkOptions): ReactNativeGoodVibesSdk {
  return createReactNativeGoodVibesSdk(options);
}

export {
  createExpoSecureTokenStore,
  type ExpoSecureTokenStore,
  type ExpoSecureTokenStoreOptions,
  type ExpoSecureStoreAccessible,
} from './client-auth/expo-secure-token-store.js';
