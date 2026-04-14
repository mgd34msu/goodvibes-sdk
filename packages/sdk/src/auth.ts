import { ConfigurationError } from '@pellux/goodvibes-errors';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
} from '@pellux/goodvibes-contracts';
import type { AuthTokenResolver } from '@pellux/goodvibes-transport-http';
import type { OperatorSdk } from '@pellux/goodvibes-operator-sdk';

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

export interface GoodVibesAuthClient {
  readonly writable: boolean;
  current(): Promise<GoodVibesCurrentAuth>;
  login(input: GoodVibesLoginInput, options?: GoodVibesAuthLoginOptions): Promise<GoodVibesLoginOutput>;
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
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
