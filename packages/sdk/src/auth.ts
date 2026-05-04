import { ConfigurationError } from '@pellux/goodvibes-errors';
import type { SDKObserver } from './observer/index.js';
import { invokeObserver } from './observer/index.js';
import type { AuthTokenResolver } from '@pellux/goodvibes-transport-http';
import type { OperatorSdk } from '@pellux/goodvibes-operator-sdk';
import {
  AutoRefreshCoordinator,
  PermissionResolver,
  SessionManager,
  TokenStore,
} from './client-auth/index.js';
import type { AutoRefreshOptions } from './client-auth/index.js';
import type { ControlPlaneAuthSnapshot } from './client-auth/control-plane-auth-snapshot.js';
import type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './client-auth/types.js';

/**
 * @remarks
 * Re-export focused responsibility classes for consumers who prefer narrower,
 * single-concern APIs over the combined GoodVibesAuthClient facade.
 * OAuthClient is intentionally omitted from this client-side surface because it
 * depends on Node runtime facilities. Daemon OAuth flows belong on the server
 * side; clients receive acquired tokens via TokenStore.
 */
export { PermissionResolver, SessionManager, TokenStore } from './client-auth/index.js';
export type { OAuthStartState, OAuthTokenPayload } from './client-auth/oauth-types.js';
export type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './client-auth/types.js';

export interface BrowserTokenStoreOptions {
  readonly key?: string | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

/**
 * The combined auth client attached to an SDK instance.
 *
 * This interface aggregates token storage and session management behind a
 * single object for convenience. For focused single-responsibility access,
 * use the split classes exposed as readonly getters on this object:
 * - `sdk.auth.tokenStore` — Token persistence (`TokenStore`)
 * - `sdk.auth.sessionManager` — Login / session lifecycle (`SessionManager`)
 * - `sdk.auth.permissionResolver(snapshot)` — Role / scope checks (`PermissionResolver`)
 * - OAuth 2.0 flows: handle server-side (operator/daemon) and provide the acquired
 *   token to the client via TokenStore.
 */
export interface GoodVibesAuthClient {
  readonly writable: boolean;
  /** The underlying `TokenStore`, or null when using a read-only `getAuthToken` resolver. */
  readonly tokenStore: TokenStore | null;
  /** The underlying `SessionManager`, which owns login and current-auth delegation. */
  readonly sessionManager: SessionManager;
  /**
   * Build a `PermissionResolver` from a live auth snapshot.
   *
   * @example
   * const snap = await sdk.auth.current();
   * const perm = sdk.auth.permissionResolver(snap);
   * if (perm.hasRole('admin')) { ... }
   */
  permissionResolver(snapshot: GoodVibesCurrentAuth): PermissionResolver;
  current(): Promise<GoodVibesCurrentAuth>;
  login(input: GoodVibesLoginInput, options?: GoodVibesAuthLoginOptions): Promise<GoodVibesLoginOutput>;
  /** Retrieve the current token. Delegates to `TokenStore.getToken()`. */
  getToken(): Promise<string | null>;
  /** Persist a token. Delegates to `TokenStore.setToken()`. */
  setToken(token: string | null): Promise<void>;
  /** Clear the stored token. Delegates to `TokenStore.clearToken()`. */
  clearToken(): Promise<void>;
}

/**
 * Options for the auto-refresh feature on the auth client.
 *
 * @see AutoRefreshOptions
 */
export type { AutoRefreshOptions };
export type { AutoRefreshCoordinatorOptions } from './client-auth/index.js';

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
export function createMemoryTokenStore(initialToken: string | null = null, initialExpiresAt?: number): GoodVibesTokenStore {
  let token = initialToken;
  let expiresAt: number | undefined = initialExpiresAt;
  return {
    async getToken(): Promise<string | null> {
      return token;
    },
    async setToken(nextToken: string | null): Promise<void> {
      token = nextToken;
      // When setToken is called directly (not via setTokenEntry), clear expiry
      // to avoid stale expiry data attached to a manually-set token.
      expiresAt = undefined;
    },
    async clearToken(): Promise<void> {
      token = null;
      expiresAt = undefined;
    },
    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      return expiresAt !== undefined ? { token, expiresAt } : { token };
    },
    async setTokenEntry(nextToken: string | null, nextExpiresAt?: number): Promise<void> {
      token = nextToken;
      expiresAt = nextExpiresAt;
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
  const expiresAtKey = `${key}.expiresAt`;
  return {
    async getToken(): Promise<string | null> {
      const value = storage.getItem(key);
      return value && value.trim() ? value : null;
    },
    async setToken(token: string | null): Promise<void> {
      if (!token) {
        storage.removeItem(key);
        storage.removeItem(expiresAtKey);
        return;
      }
      storage.setItem(key, token);
      // Clear expiry when set via setToken (no expiry info provided).
      storage.removeItem(expiresAtKey);
    },
    async clearToken(): Promise<void> {
      storage.removeItem(key);
      storage.removeItem(expiresAtKey);
    },
    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      const value = storage.getItem(key);
      const token = value && value.trim() ? value : null;
      const expiresAtStr = storage.getItem(expiresAtKey);
      const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : undefined;
      const finalExpiresAt = Number.isFinite(expiresAt) ? expiresAt : undefined;
      return finalExpiresAt !== undefined ? { token, expiresAt: finalExpiresAt } : { token };
    },
    async setTokenEntry(token: string | null, expiresAt?: number): Promise<void> {
      if (!token) {
        storage.removeItem(key);
        storage.removeItem(expiresAtKey);
        return;
      }
      storage.setItem(key, token);
      if (expiresAt !== undefined) {
        storage.setItem(expiresAtKey, String(expiresAt));
      } else {
        storage.removeItem(expiresAtKey);
      }
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
  observer?: SDKObserver | undefined,
  autoRefreshOptions?: AutoRefreshOptions,
  /**
   * Optional pre-built `AutoRefreshCoordinator`. When provided, it is reused
   * directly (no new coordinator is constructed). This allows `createGoodVibesSdk`
   * to share a single coordinator instance between the transport middleware and
   * the auth client, avoiding duplicate refresh calls.
   */
  existingCoordinator?: AutoRefreshCoordinator | null,
): GoodVibesAuthClient {
  // Construct the split-class instances that own each concern.
  // The facade delegates to these rather than duplicating logic.
  const ts: TokenStore | null = tokenStore ? new TokenStore(tokenStore) : null;
  const sm: SessionManager = new SessionManager(operator, ts);

  // Use the provided coordinator if available; otherwise build one.
  const coordinator: AutoRefreshCoordinator | null = existingCoordinator !== undefined
    ? existingCoordinator
    : (() => {
        const autoRefresh = autoRefreshOptions?.autoRefresh ?? true;
        const refreshLeewayMs = autoRefreshOptions?.refreshLeewayMs ?? 60_000;
        return tokenStore && autoRefresh
          ? new AutoRefreshCoordinator({
              tokenStore,
              autoRefresh,
              refreshLeewayMs,
              ...(autoRefreshOptions?.refresh !== undefined ? { refresh: autoRefreshOptions.refresh } : {}),
              observer,
            })
          : null;
      })();

  return {
    get writable(): boolean {
      return sm.writable;
    },
    get tokenStore(): TokenStore | null {
      return ts;
    },
    get sessionManager(): SessionManager {
      return sm;
    },
    permissionResolver(snapshot: GoodVibesCurrentAuth): PermissionResolver {
      return new PermissionResolver(snapshot as unknown as ControlPlaneAuthSnapshot);
    },
    async current(): Promise<GoodVibesCurrentAuth> {
      if (coordinator) {
        await coordinator.ensureFreshToken();
        return coordinator.withRetryOn401(() => sm.current());
      }
      return sm.current();
    },
    async login(
      input: GoodVibesLoginInput,
      options: GoodVibesAuthLoginOptions = {},
    ): Promise<GoodVibesLoginOutput> {
      // Capture prior auth state BEFORE the login mutation so the observer's
      // `from` field reflects the actual pre-login state (anonymous vs token
      // refresh), not the post-login state.
      const priorToken = await ts?.getToken();
      const result = await sm.login(input, options);
      // Notify observer of the auth state transition. Observer errors are
      // swallowed so they never disrupt SDK logic.
      invokeObserver(() =>
        observer?.onAuthTransition?.({
          from: priorToken ? 'token' : 'anonymous',
          to: 'token',
          reason: 'login',
        }),
      );
      return result;
    },
    async getToken(): Promise<string | null> {
      if (ts) {
        return ts.getToken();
      }
      return await readToken(null, getAuthToken);
    },
    async setToken(token: string | null): Promise<void> {
      await assertWritableTokenStore(ts).setToken(token);
    },
    async clearToken(): Promise<void> {
      const currentToken = await ts?.getToken();
      await assertWritableTokenStore(ts).clearToken();
      // Notify observer of the logout transition. Observer errors are
      // swallowed so they never disrupt SDK logic.
      invokeObserver(() =>
        observer?.onAuthTransition?.({
          from: currentToken ? 'token' : 'anonymous',
          to: 'anonymous',
          reason: 'logout',
        }),
      );
    },
  };
}
