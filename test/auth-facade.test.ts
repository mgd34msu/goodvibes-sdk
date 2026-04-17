/**
 * Integration test — exercises auth functionality through the public
 * `GoodVibesAuthClient` facade to verify that the split does not break
 * any existing consumer behaviour.
 */
import { describe, expect, test } from 'bun:test';
import {
  PermissionResolver,
  SessionManager,
  TokenStore,
  createGoodVibesAuthClient,
  createMemoryTokenStore,
} from '../packages/sdk/src/auth.js';
import type { ControlPlaneAuthSnapshot } from '../packages/sdk/src/_internal/platform/control-plane/auth-snapshot.js';
import type { OperatorSdk } from '../packages/sdk/src/_internal/operator/index.js';

function makeRawStore(initial: string | null = null) {
  let current = initial;
  return {
    async getToken() { return current; },
    async setToken(t: string | null) { current = t; },
    async clearToken() { current = null; },
  };
}

function makeOperator(token = 'facade-token') {
  return {
    control: {
      auth: {
        current: async () => ({ authenticated: true, authMode: 'session', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'user-1', principalKind: 'user', admin: false, scopes: ['read'], roles: ['viewer'] }),
        login: async (_input: unknown) => ({ token, authenticated: true, username: 'alice', expiresAt: Date.now() + 60_000 }),
      },
    },
  } as unknown as OperatorSdk;
}

describe('auth facade — backward-compatible GoodVibesAuthClient', () => {
  test('createGoodVibesAuthClient login persists token', async () => {
    const tokenStore = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore);
    const result = await client.login({ username: 'alice', password: 'secret' });
    expect(result.token).toBe('facade-token');
    expect(await client.getToken()).toBe('facade-token');
  });

  test('writable is true with a token store', () => {
    const client = createGoodVibesAuthClient(makeOperator(), createMemoryTokenStore());
    expect(client.writable).toBe(true);
  });

  test('writable is false without a token store', () => {
    const client = createGoodVibesAuthClient(makeOperator(), null);
    expect(client.writable).toBe(false);
  });

  test('clearToken removes stored token', async () => {
    const tokenStore = createMemoryTokenStore('initial');
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore);
    await client.clearToken();
    expect(await client.getToken()).toBeNull();
  });

  test('setToken updates stored token', async () => {
    const tokenStore = createMemoryTokenStore();
    const client = createGoodVibesAuthClient(makeOperator(), tokenStore);
    await client.setToken('manual-token');
    expect(await client.getToken()).toBe('manual-token');
  });
});

describe('auth facade — new split classes are re-exported', () => {
  test('TokenStore is accessible from auth module', async () => {
    const ts = new TokenStore(makeRawStore());
    await ts.setToken('tok');
    expect(await ts.getToken()).toBe('tok');
  });

  test('SessionManager is accessible from auth module', async () => {
    const ts = new TokenStore(makeRawStore());
    const sm = new SessionManager(makeOperator(), ts);
    expect(sm.writable).toBe(true);
  });

  test('PermissionResolver is accessible from auth module', () => {
    const snap: ControlPlaneAuthSnapshot = {
      authenticated: true,
      authMode: 'session',
      tokenPresent: true,
      authorizationHeaderPresent: true,
      sessionCookiePresent: false,
      principalId: 'user-1',
      principalKind: 'user',
      admin: false,
      scopes: ['read'],
      roles: ['viewer'],
    };
    const resolver = new PermissionResolver(snap);
    expect(resolver.hasRole('viewer')).toBe(true);
    expect(resolver.hasScope('read')).toBe(true);
    expect(resolver.hasRole('admin')).toBe(false);
  });
});
