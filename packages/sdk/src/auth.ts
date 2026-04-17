import { ConfigurationError } from './_internal/errors/index.js';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
} from './_internal/contracts/index.js';
import type { AuthTokenResolver } from './_internal/transport-http/index.js';
import type { OperatorSdk } from './_internal/operator/index.js';

// Re-export focused responsibility classes for consumers who prefer
// narrower, single-concern APIs over the combined GoodVibesAuthClient facade.
export {
  OAuthClient,
  PermissionResolver,
  SessionManager,
  TokenStore,
} from './_internal/platform/auth/index.js';
export type { OAuthStartState, OAuthTokenPayload } from './_internal/platform/auth/index.js';

export type GoodVibesCurrentAuth = OperatorMethodOutput<'control.auth.current'>;
export type GoodVibesLoginInput = OperatorMethodInput<'control.auth.login'>;
export type GoodVibesLoginOutput = OperatorMethodOutput<'control.auth.login'>;

export interface GoodVibesTokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
  clearToken(): Promise<void>;
}

export interface BrowserTokenStoreOptions {
  readonly key?: string;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export interface GoodVibesAuthLoginOptions {
  readonly persistToken?: boolean;
}

/**
 * The combined auth client attached to an SDK instance.
 *
 * This interface aggregates token storage and session management behind a
 * single object for convenience. For focused single-responsibility access,
 * use the split classes exported from this module:
 * - Token persistence: `TokenStore`
 * - Login / session lifecycle: `SessionManager`
 * - OAuth 2.0 flows: `OAuthClient`
 * - Role / scope checks: `PermissionResolver`
 */
export interface GoodVibesAuthClient {
  readonly writable: boolean;
  current(): Promise<GoodVibesCurrentAuth>;
  login(input: GoodVibesLoginInput, options?: GoodVibesAuthLoginOptions): Promise<GoodVibesLoginOutput>;
  /**
   * @deprecated Prefer `TokenStore.getToken()` for direct token access.
   * `GoodVibesAuthClient.getToken()` remains supported and delegates to the
   * same underlying store.
   */
  getToken(): Promise<string | null>;
  /**
   * @deprecated Prefer `TokenStore.setToken()` for direct token mutation.
   * `GoodVibesAuthClient.setToken()` remains supported and delegates to the
   * same underlying store.
   */
  setToken(token: string | null): Promise<void>;
  /**
   * @deprecated Prefer `TokenStore.clearToken()` for direct token mutation.
   * `GoodVibesAuthClient.clearToken()` remains supported and delegates to the
   * same underlying store.
   */
  clearToken(): Promise<void>;
}

function requireStorage(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const resolved = storage ?? globalThis.localStorage;
  if (!resolved) {
    throw new ConfigurationError(
      'Browser token storage is unavailable. Pass BrowserTokenStoreOptions.storage or use createMemoryTokenStore().',
    );
  }
  return resolved;
}

/**
 * Create a simple in-memory token store.
 *
 * The token is held in a closure variable — it does not survive page
 * refreshes or process restarts. Suitable for server-side scripts and tests.
 *
 * @example
 * import { createMemoryTokenStore } from '@pellux/goodvibes-sdk';
 *
 * const store = createMemoryTokenStore('initial-token');
 * const sdk = createGoodVibesSdk({ baseUrl: '...', tokenStore: store });
 * await sdk.auth.clearToken(); // clears only in-memory
 */
export function createMemoryTokenStore(initialToken: string | null = null): GoodVibesTokenStore {
  let token = initialToken;
  return {
    async getToken(): Promise<string | null> {
      return token;
    },
    async setToken(nextToken: string | null): Promise<void> {
      token = nextToken;
    },
    async clearToken(): Promise<void> {
      token = null;
    },
  };
}

/**
 * Create a token store backed by `localStorage` (or a custom `Storage`).
 *
 * The token is persisted across page refreshes under the key
 * `'goodvibes.token'` (overridable via `options.key`).
 * Pass `options.storage` to use `sessionStorage` or a custom adapter.
 *
 * @example
 * import { createBrowserTokenStore, createBrowserGoodVibesSdk } from '@pellux/goodvibes-sdk/browser';
 *
 * const tokenStore = createBrowserTokenStore({ storage: sessionStorage });
 * const sdk = createBrowserGoodVibesSdk({ tokenStore });
 * await sdk.auth.login({ username: 'alice', password: 's3cr3t' });
 * // token is now stored in sessionStorage
 */
export function createBrowserTokenStore(options: BrowserTokenStoreOptions = {}): GoodVibesTokenStore {
  const storage = requireStorage(options.storage);
  const key = options.key?.trim() || 'goodvibes.token';
  return {
    async getToken(): Promise<string | null> {
      const value = storage.getItem(key);
      return value && value.trim() ? value : null;
    },
    async setToken(token: string | null): Promise<void> {
      if (!token) {
        storage.removeItem(key);
        return;
      }
      storage.setItem(key, token);
    },
    async clearToken(): Promise<void> {
      storage.removeItem(key);
    },
  };
}

async function readToken(
  tokenStore: GoodVibesTokenStore | null,
  getAuthToken?: AuthTokenResolver,
): Promise<string | null> {
  if (tokenStore) {
    return await tokenStore.getToken();
  }
  if (getAuthToken) {
    return (await getAuthToken()) ?? null;
  }
  return null;
}

function assertWritableTokenStore(tokenStore: GoodVibesTokenStore | null): GoodVibesTokenStore {
  if (!tokenStore) {
    throw new ConfigurationError(
      'This SDK instance uses a read-only auth token resolver. Pass tokenStore to enable token persistence and mutation.',
    );
  }
  return tokenStore;
}

/**
 * Create the auth client attached to an SDK instance.
 *
 * Normally called internally by `createGoodVibesSdk`. Access the result via
 * `sdk.auth`.
 *
 * @example
 * import { createGoodVibesSdk, createBrowserTokenStore } from '@pellux/goodvibes-sdk';
 *
 * const sdk = createGoodVibesSdk({
 *   baseUrl: 'https://daemon.example.com',
 *   tokenStore: createBrowserTokenStore(),
 * });
 *
 * // Login and persist the token automatically:
 * const { token } = await sdk.auth.login({ username: 'alice', password: 's3cr3t' });
 * console.log('logged in, token stored:', token.slice(0, 8) + '...');
 *
 * // Later: clear the session
 * await sdk.auth.clearToken();
 */
export function createGoodVibesAuthClient(
  operator: OperatorSdk,
  tokenStore: GoodVibesTokenStore | null,
  getAuthToken?: AuthTokenResolver,
): GoodVibesAuthClient {
  return {
    writable: tokenStore !== null,
    async current(): Promise<GoodVibesCurrentAuth> {
      return await operator.control.auth.current();
    },
    async login(
      input: GoodVibesLoginInput,
      options: GoodVibesAuthLoginOptions = {},
    ): Promise<GoodVibesLoginOutput> {
      const result = await operator.control.auth.login(input);
      if ((options.persistToken ?? true) && tokenStore) {
        await tokenStore.setToken(result.token);
      }
      return result;
    },
    async getToken(): Promise<string | null> {
      return await readToken(tokenStore, getAuthToken);
    },
    async setToken(token: string | null): Promise<void> {
      await assertWritableTokenStore(tokenStore).setToken(token);
    },
    async clearToken(): Promise<void> {
      await assertWritableTokenStore(tokenStore).clearToken();
    },
  };
}
