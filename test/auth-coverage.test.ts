/**
 * Coverage backfill for packages/sdk/src/auth.ts
 *
 * Targets uncovered branches:
 * - requireStorage() throws ConfigurationError when no localStorage and no custom storage
 * - createBrowserTokenStore: setToken(null) removes key; whitespace-only value → null
 * - readToken: getAuthToken branch; both-null branch
 * - assertWritableTokenStore: throws ConfigurationError when no store
 * - createGoodVibesAuthClient: getToken via getAuthToken resolver; setToken/clearToken throws
 * - createGoodVibesAuthClient: observer onAuthTransition fires with priorToken context
 */
import { describe, expect, test } from 'bun:test';
import {
  createBrowserTokenStore,
  createGoodVibesAuthClient,
  createMemoryTokenStore,
} from '../packages/sdk/src/auth.js';
import { ConfigurationError } from '../packages/errors/src/index.js';
import type { OperatorSdk } from '../packages/operator-sdk/src/index.js';
import type { SDKObserver, AuthTransitionInfo } from '../packages/sdk/src/observer/index.js';

function makeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const store = { ...initial };
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
  };
}

function makeOperator(loginToken = 'auth-tok') {
  return {
    control: {
      auth: {
        current: async () => ({
          authenticated: true,
          authMode: 'session',
          tokenPresent: true,
          authorizationHeaderPresent: true,
          sessionCookiePresent: false,
          principalId: 'u1',
          principalKind: 'user',
          admin: false,
          scopes: [],
          roles: [],
        }),
        login: async (_input: unknown) => ({
          token: loginToken,
          authenticated: true,
          username: 'alice',
          expiresAt: Date.now() + 60_000,
        }),
      },
    },
  } as unknown as OperatorSdk;
}

// ---------------------------------------------------------------------------
// requireStorage / createBrowserTokenStore
// ---------------------------------------------------------------------------

describe('createBrowserTokenStore — storage edge cases', () => {
  test('throws ConfigurationError when no storage is available and globalThis.localStorage is absent', () => {
    // In bun/node there is no globalThis.localStorage, so requireStorage throws.
    expect(() => createBrowserTokenStore()).toThrow(ConfigurationError);
    expect(() => createBrowserTokenStore()).toThrow('Browser token storage is unavailable');
  });

  test('uses provided custom storage without throwing', () => {
    const storage = makeStorage();
    expect(() => createBrowserTokenStore({ storage })).not.toThrow();
  });

  test('setToken(null) removes the key instead of storing null', async () => {
    const storage = makeStorage({ 'goodvibes.token': 'existing' });
    const store = createBrowserTokenStore({ storage });
    await store.setToken(null);
    expect(await store.getToken()).toBeNull();
  });

  test('setToken("") removes the key (falsy string)', async () => {
    const storage = makeStorage({ 'goodvibes.token': 'existing' });
    const store = createBrowserTokenStore({ storage });
    // cast to bypass type — exercises the falsy branch
    await store.setToken('' as unknown as string);
    expect(await store.getToken()).toBeNull();
  });

  test('getToken returns null for whitespace-only stored value', async () => {
    const storage = makeStorage({ 'goodvibes.token': '   ' });
    const store = createBrowserTokenStore({ storage });
    expect(await store.getToken()).toBeNull();
  });

  test('respects custom key option', async () => {
    const storage = makeStorage();
    const store = createBrowserTokenStore({ key: 'my.custom.key', storage });
    await store.setToken('token-abc');
    expect(storage.getItem('my.custom.key')).toBe('token-abc');
    expect(await store.getToken()).toBe('token-abc');
  });

  test('clearToken removes stored token', async () => {
    const storage = makeStorage();
    const store = createBrowserTokenStore({ storage });
    await store.setToken('token-xyz');
    await store.clearToken();
    expect(await store.getToken()).toBeNull();
  });

  test('getToken returns non-whitespace value correctly', async () => {
    const storage = makeStorage({ 'goodvibes.token': 'valid-token' });
    const store = createBrowserTokenStore({ storage });
    expect(await store.getToken()).toBe('valid-token');
  });
});

// ---------------------------------------------------------------------------
// createMemoryTokenStore — initial token
// ---------------------------------------------------------------------------

describe('createMemoryTokenStore — initial token', () => {
  test('accepts an initial token', async () => {
    const store = createMemoryTokenStore('seed-token');
    expect(await store.getToken()).toBe('seed-token');
  });

  test('setToken(null) clears token', async () => {
    const store = createMemoryTokenStore('seed');
    await store.setToken(null);
    expect(await store.getToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createGoodVibesAuthClient — read-only resolver (getAuthToken)
// ---------------------------------------------------------------------------

describe('createGoodVibesAuthClient — read-only getAuthToken resolver', () => {
  test('getToken delegates to getAuthToken when no tokenStore', async () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, async () => 'readonly-token');
    expect(await client.getToken()).toBe('readonly-token');
  });

  test('getToken returns null when getAuthToken returns undefined', async () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, async () => undefined);
    expect(await client.getToken()).toBeNull();
  });

  test('getToken returns null when neither tokenStore nor getAuthToken', async () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, undefined);
    expect(await client.getToken()).toBeNull();
  });

  test('setToken throws ConfigurationError when no tokenStore', async () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, async () => 'tok');
    await expect(client.setToken('new-token')).rejects.toBeInstanceOf(ConfigurationError);
    await expect(client.setToken('new-token')).rejects.toThrow('read-only');
  });

  test('clearToken throws ConfigurationError when no tokenStore', async () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, async () => 'tok');
    await expect(client.clearToken()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(client.clearToken()).rejects.toThrow('read-only');
  });

  test('writable is false when no tokenStore', () => {
    const client = createGoodVibesAuthClient(makeOperator(), null, async () => 'tok');
    expect(client.writable).toBe(false);
  });

  test('tokenStore getter returns null when no tokenStore provided', () => {
    const client = createGoodVibesAuthClient(makeOperator(), null);
    expect(client.tokenStore).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createGoodVibesAuthClient — observer auth transition events
// ---------------------------------------------------------------------------

describe('createGoodVibesAuthClient — observer onAuthTransition', () => {
  test('login fires onAuthTransition from anonymous → token when no prior token', async () => {
    const transitions: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { transitions.push(t); },
    };
    const tokenStore = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await client.login({ username: 'alice', password: 'secret' });
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('anonymous');
    expect(transitions[0].to).toBe('token');
    expect(transitions[0].reason).toBe('login');
  });

  test('login fires onAuthTransition from token → token on re-login', async () => {
    const transitions: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { transitions.push(t); },
    };
    const tokenStore = createMemoryTokenStore('prior-token');
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await client.login({ username: 'alice', password: 'secret' });
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('token');
    expect(transitions[0].to).toBe('token');
  });

  test('clearToken fires onAuthTransition from token → anonymous', async () => {
    const transitions: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { transitions.push(t); },
    };
    const tokenStore = createMemoryTokenStore('existing-token');
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await client.clearToken();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('token');
    expect(transitions[0].to).toBe('anonymous');
    expect(transitions[0].reason).toBe('logout');
  });

  test('clearToken fires onAuthTransition from anonymous → anonymous when no token', async () => {
    const transitions: AuthTransitionInfo[] = [];
    const observer: SDKObserver = {
      onAuthTransition(t) { transitions.push(t); },
    };
    const tokenStore = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await client.clearToken();
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from).toBe('anonymous');
    expect(transitions[0].to).toBe('anonymous');
  });

  test('observer that throws on onAuthTransition does not propagate into login', async () => {
    const observer: SDKObserver = {
      onAuthTransition(_t) { throw new Error('observer exploded'); },
    };
    const tokenStore = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await expect(client.login({ username: 'alice', password: 'secret' })).resolves.toMatchObject({ token: 'auth-tok' });
  });

  test('observer that throws on onAuthTransition does not propagate into clearToken', async () => {
    const observer: SDKObserver = {
      onAuthTransition(_t) { throw new Error('observer exploded'); },
    };
    const tokenStore = createMemoryTokenStore('existing');
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore, undefined, observer);
    await expect(client.clearToken()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createGoodVibesAuthClient — tokenStore and sessionManager getters
// ---------------------------------------------------------------------------

describe('createGoodVibesAuthClient — getters', () => {
  test('tokenStore getter returns TokenStore instance when tokenStore provided', () => {
    const store = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), store);
    expect(client.tokenStore).not.toBeNull();
  });

  test('sessionManager getter is accessible', () => {
    const client = createGoodVibesAuthClient(makeOperator(), createMemoryTokenStore());
    expect(client.sessionManager).toBeDefined();
  });

  test('permissionResolver builds a resolver from a snapshot', () => {
    const client = createGoodVibesAuthClient(makeOperator(), createMemoryTokenStore());
    const resolver = client.permissionResolver({
      authenticated: true,
      authMode: 'session',
      tokenPresent: true,
      authorizationHeaderPresent: false,
      sessionCookiePresent: true,
      principalId: 'user-1',
      principalKind: 'user',
      admin: true,
      scopes: ['read', 'write'],
      roles: ['admin'],
    } as Parameters<typeof client.permissionResolver>[0]);
    expect(resolver.hasRole('admin')).toBe(true);
    expect(resolver.hasScope('read')).toBe(true);
    expect(resolver.hasScope('delete')).toBe(false);
  });
});
