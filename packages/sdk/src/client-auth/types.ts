import type {
  OperatorMethodInput,
  OperatorMethodOutput,
} from '@pellux/goodvibes-contracts';

/** Response shape returned by `sdk.auth.current()` — the daemon's view of the current principal. */
export type GoodVibesCurrentAuth = OperatorMethodOutput<'control.auth.current'>;
/** Input payload for `sdk.auth.login()` — typically `{ username, password }`. */
export type GoodVibesLoginInput = OperatorMethodInput<'control.auth.login'>;
/** Successful login response, including the issued token and optional `expiresAt` (Unix ms). */
export type GoodVibesLoginOutput = OperatorMethodOutput<'control.auth.login'>;

/**
 * Minimal token storage contract used by the GoodVibes SDK.
 *
 * Implement this interface when you need custom token persistence (e.g.
 * encrypted storage, platform keychains, or external secret stores).
 * For common use cases, use the built-in factories:
 * - `createMemoryTokenStore` — in-memory (default when `authToken` is provided)
 * - `createBrowserTokenStore` — `localStorage`-backed (browser)
 * - `createExpoSecureTokenStore` — Expo secure store (React Native Expo)
 * - `createIOSKeychainTokenStore` — iOS Keychain (bare React Native)
 * - `createAndroidKeystoreTokenStore` — Android Keystore (bare React Native)
 */
export interface GoodVibesTokenStore {
  /** Return the stored auth token, or `null` if none is present. */
  getToken(): Promise<string | null>;
  /** Persist a new token, or clear storage when `null` is passed. */
  setToken(token: string | null): Promise<void>;
  /** Equivalent to `setToken(null)` — removes the stored token. */
  clearToken(): Promise<void>;
}

/**
 * Extended token store that supports expiry-aware token retrieval and
 * storage. Implement this interface when your storage backend can persist
 * token metadata (e.g. expiry timestamps for proactive refresh).
 *
 * Compose with `GoodVibesTokenStore` by extending your implementation class
 * to implement both interfaces, or pass an object that satisfies both.
 */
export interface GoodVibesExpiringTokenStore extends GoodVibesTokenStore {
  getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }>;
  setTokenEntry(token: string | null, expiresAt?: number): Promise<void>;
}

/** Options for `sdk.auth.login()`. */
export interface GoodVibesAuthLoginOptions {
  /**
   * When `true` (default), automatically persist the token returned by the
   * login response into the configured token store. Set to `false` to handle
   * persistence manually.
   *
   * @defaultValue true
   */
  readonly persistToken?: boolean | undefined;
}
