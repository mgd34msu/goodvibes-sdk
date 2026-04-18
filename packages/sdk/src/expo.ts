import {
  createReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdkOptions,
} from './react-native.js';

export interface ExpoGoodVibesSdkOptions extends ReactNativeGoodVibesSdkOptions {}

/**
 * Alias for `createReactNativeGoodVibesSdk`. Use this entry-point when
 * importing from `@pellux/goodvibes-sdk/expo`.
 *
 * @example
 * // Example only: uses expo-secure-store; replace with your own storage.
 * import { createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';
 * import * as SecureStore from 'expo-secure-store';
 *
 * const sdk = createExpoGoodVibesSdk({
 *   baseUrl: process.env.EXPO_PUBLIC_GV_URL!,
 *   authToken: await SecureStore.getItemAsync('gv-token'),
 * });
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
} from './_internal/platform/auth/expo-secure-token-store.js';
