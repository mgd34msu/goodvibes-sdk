import {
  createReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdk,
  type ReactNativeGoodVibesSdkOptions,
} from './react-native.js';

export interface ExpoGoodVibesSdkOptions extends ReactNativeGoodVibesSdkOptions {}

export function createExpoGoodVibesSdk(options: ExpoGoodVibesSdkOptions): ReactNativeGoodVibesSdk {
  return createReactNativeGoodVibesSdk(options);
}
