/**
 * TokenStore — Focused responsibility: token persistence.
 *
 * Owns all read/write/clear operations on a `GoodVibesTokenStore`. Consumers
 * that only need token storage can interact with this class directly rather
 * than going through the full auth client.
 */

import type { GoodVibesTokenStore } from '../../../auth.js';

export class TokenStore {
  readonly #store: GoodVibesTokenStore;

  constructor(store: GoodVibesTokenStore) {
    this.#store = store;
  }

  /** Return the current token, or null if none is stored. */
  async getToken(): Promise<string | null> {
    return this.#store.getToken();
  }

  /** Persist a new token, or clear storage when null. */
  async setToken(token: string | null): Promise<void> {
    return this.#store.setToken(token);
  }

  /**
   * Persist a new token alongside its expiry timestamp (unix ms).
   * Falls back to `setToken` when the store does not implement `setTokenEntry`.
   */
  async setTokenEntry(token: string | null, expiresAt?: number): Promise<void> {
    const store = this.#store as GoodVibesTokenStore & {
      setTokenEntry?: (token: string | null, expiresAt?: number) => Promise<void>;
    };
    if (typeof store.setTokenEntry === 'function') {
      return store.setTokenEntry(token, expiresAt);
    }
    return this.#store.setToken(token);
  }

  /**
   * Return the current token entry, including optional expiry.
   * Falls back to token-only when the store does not implement `getTokenEntry`.
   */
  async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
    const store = this.#store as GoodVibesTokenStore & {
      getTokenEntry?: () => Promise<{ token: string | null; expiresAt?: number }>;
    };
    if (typeof store.getTokenEntry === 'function') {
      return store.getTokenEntry();
    }
    const token = await this.#store.getToken();
    return { token };
  }

  /** Clear the stored token. */
  async clearToken(): Promise<void> {
    return this.#store.clearToken();
  }

  /** Return true when a non-empty token is currently stored. */
  async hasToken(): Promise<boolean> {
    const token = await this.#store.getToken();
    return typeof token === 'string' && token.length > 0;
  }

  /** Expose the underlying store for interop with existing consumers. */
  get store(): GoodVibesTokenStore {
    return this.#store;
  }
}
