/**
 * Integration test, exercises auth functionality through the public
 * `GoodVibesAuthClient` facade to verify that public auth behavior flows
 * through the client-auth implementation.
 */
import { describe, expect, test } from 'bun:test';
import {
  createGoodVibesAuthClient,
  createMemoryTokenStore,
} from '../packages/sdk/src/auth.js';
import type { OperatorSdk } from '../packages/operator-sdk/src/index.js';

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

describe('auth facade: GoodVibesAuthClient delegates to client-auth', () => {
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
