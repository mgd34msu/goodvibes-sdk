/**
 * SessionManager — Focused responsibility: session lifecycle.
 *
 * Manages the login/logout lifecycle and ties token persistence to login
 * results. Decoupled from transport and token storage implementations.
 */

import type { OperatorSdk } from '@pellux/goodvibes-operator-sdk';
import type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
} from './types.js';
import { TokenStore } from './token-store.js';
import type { SDKObserver } from '../observer/index.js';

export class SessionManager {
  readonly #operator: OperatorSdk;
  readonly #tokenStore: TokenStore | null;
  readonly #observer: SDKObserver | undefined;

  constructor(operator: OperatorSdk, tokenStore: TokenStore | null, observer?: SDKObserver) {
    this.#operator = operator;
    this.#tokenStore = tokenStore;
    this.#observer = observer;
  }

  /**
   * Return the current auth state from the daemon control plane.
   * Does not require a writable token store.
   */
  async current(): Promise<GoodVibesCurrentAuth> {
    return this.#operator.control.auth.current();
  }

  /**
   * Perform a login and, when `persistToken` is not false, automatically
   * persist the returned token into the configured token store.
   * The `expiresAt` from the login response is also persisted when the store
   * supports `setTokenEntry`.
   */
  async login(
    input: GoodVibesLoginInput,
    options: GoodVibesAuthLoginOptions = {},
  ): Promise<GoodVibesLoginOutput> {
    const result = await this.#operator.control.auth.login(input);
    if ((options.persistToken ?? true) && this.#tokenStore) {
      // Prefer setTokenEntry to persist expiry alongside the token.
      if (result.expiresAt) {
        await this.#tokenStore.setTokenEntry(result.token, result.expiresAt);
      } else {
        await this.#tokenStore.setToken(result.token);
      }
    }
    // Note: observer notification is intentionally NOT emitted here. The
    // `createGoodVibesAuthClient` facade in `../auth.ts` owns the observer
    // wiring with full priorToken awareness (anonymous→token vs token→token);
    // emitting here would produce duplicate transitions. The `#observer` field
    // is retained for future use cases that bypass the facade.
    return result;
  }

  /**
   * Whether this session manager has a writable token store.
   * Read-only instances (using a raw `getAuthToken` resolver) return false.
   */
  get writable(): boolean {
    return this.#tokenStore !== null;
  }

  /** Access the underlying TokenStore (null when using a read-only resolver). */
  get tokenStore(): TokenStore | null {
    return this.#tokenStore;
  }
}
