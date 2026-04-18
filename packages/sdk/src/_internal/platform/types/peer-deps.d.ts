/**
 * Minimal ambient type declarations for optional peer dependencies.
 *
 * These modules are NOT installed as SDK dependencies. They are resolved
 * dynamically at runtime and declared here only to satisfy TypeScript's
 * static import checker. The SDK throws a GoodVibesSdkError{kind:'config'}
 * at runtime if either module is absent.
 *
 * Install commands:
 *   - expo-secure-store:   `expo install expo-secure-store`
 *   - react-native-keychain: `npm install react-native-keychain && npx pod-install` (iOS)
 */

declare module 'expo-secure-store' {
  export const AFTER_FIRST_UNLOCK: string;
  export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: string;
  export const ALWAYS: string;
  export const ALWAYS_THIS_DEVICE_ONLY: string;
  export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: string;
  export const WHEN_UNLOCKED: string;
  export const WHEN_UNLOCKED_THIS_DEVICE_ONLY: string;
  export function setItemAsync(
    key: string,
    value: string,
    options?: Record<string, unknown>,
  ): Promise<void>;
  export function getItemAsync(
    key: string,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  export function deleteItemAsync(
    key: string,
    options?: Record<string, unknown>,
  ): Promise<void>;
}

declare module 'react-native-keychain' {
  export const ACCESSIBLE: {
    readonly WHEN_UNLOCKED: string;
    readonly AFTER_FIRST_UNLOCK: string;
    readonly ALWAYS: string;
    readonly WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: string;
    readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: string;
    readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: string;
    readonly ALWAYS_THIS_DEVICE_ONLY: string;
  };
  export const ACCESS_CONTROL: {
    readonly BIOMETRY_ANY: string;
    readonly BIOMETRY_ANY_OR_DEVICE_PASSCODE: string;
    readonly BIOMETRY_CURRENT_SET: string;
    readonly BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: string;
    readonly DEVICE_PASSCODE: string;
    readonly APPLICATION_PASSWORD: string;
  };
  export interface UserCredentials {
    username: string;
    password: string;
    service: string;
    storage: string;
  }
  export function setGenericPassword(
    username: string,
    password: string,
    options?: Record<string, unknown>,
  ): Promise<false | { service: string; storage: string }>;
  export function getGenericPassword(
    options?: Record<string, unknown>,
  ): Promise<false | UserCredentials>;
  export function resetGenericPassword(
    options?: Record<string, unknown>,
  ): Promise<boolean>;
}
