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
