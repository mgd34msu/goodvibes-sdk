import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../packages/sdk/src/_internal/platform/auth/session-manager.js';
import { TokenStore } from '../packages/sdk/src/_internal/platform/auth/token-store.js';
import type { OperatorSdk } from '../packages/sdk/src/_internal/operator/index.js';

function makeRawStore(initial: string | null = null) {
  let current = initial;
  return {
    async getToken() { return current; },
    async setToken(t: string | null) { current = t; },
    async clearToken() { current = null; },
  };
}

function makeOperator(loginResult: Record<string, unknown> = { token: 'test-token', authenticated: true, username: 'alice', expiresAt: Date.now() + 60_000 }) {
  return {
    control: {
      auth: {
        current: async () => ({ authenticated: true, authMode: 'session', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'alice', principalKind: 'user', admin: false, scopes: [], roles: [] }),
        login: async (_input: unknown) => loginResult,
      },
    },
  } as unknown as OperatorSdk;
}

describe('SessionManager', () => {
  test('writable is true when tokenStore is provided', () => {
    const ts = new TokenStore(makeRawStore());
    const sm = new SessionManager(makeOperator(), ts);
    expect(sm.writable).toBe(true);
  });

  test('writable is false when tokenStore is null', () => {
    const sm = new SessionManager(makeOperator(), null);
    expect(sm.writable).toBe(false);
  });

  test('tokenStore accessor returns the provided TokenStore', () => {
    const ts = new TokenStore(makeRawStore());
    const sm = new SessionManager(makeOperator(), ts);
    expect(sm.tokenStore).toBe(ts);
  });

  test('tokenStore accessor returns null when no store', () => {
    const sm = new SessionManager(makeOperator(), null);
    expect(sm.tokenStore).toBeNull();
  });

  test('login persists token into store by default', async () => {
    const raw = makeRawStore();
    const ts = new TokenStore(raw);
    const sm = new SessionManager(makeOperator(), ts);
    await sm.login({ username: 'alice', password: 'secret' });
    expect(await ts.getToken()).toBe('test-token');
  });

  test('login does not persist token when persistToken is false', async () => {
    const raw = makeRawStore();
    const ts = new TokenStore(raw);
    const sm = new SessionManager(makeOperator(), ts);
    await sm.login({ username: 'alice', password: 'secret' }, { persistToken: false });
    expect(await ts.getToken()).toBeNull();
  });

  test('login does not throw when tokenStore is null and persistToken is not set', async () => {
    const sm = new SessionManager(makeOperator(), null);
    const result = await sm.login({ username: 'alice', password: 'secret' });
    expect(result.token).toBe('test-token');
  });

  test('current() returns auth snapshot from operator', async () => {
    const sm = new SessionManager(makeOperator(), null);
    const snap = await sm.current();
    expect(snap.authenticated).toBe(true);
  });
});
