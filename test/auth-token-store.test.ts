import { describe, expect, test } from 'bun:test';
import { TokenStore } from '../packages/sdk/src/client-auth/token-store.js';

function makeRawStore(initial: string | null = null) {
  let current = initial;
  return {
    async getToken() { return current; },
    async setToken(t: string | null) { current = t; },
    async clearToken() { current = null; },
  };
}

describe('TokenStore', () => {
  test('getToken returns null when store is empty', async () => {
    const ts = new TokenStore(makeRawStore());
    expect(await ts.getToken()).toBeNull();
  });

  test('setToken persists a token', async () => {
    const ts = new TokenStore(makeRawStore());
    await ts.setToken('tok-abc');
    expect(await ts.getToken()).toBe('tok-abc');
  });

  test('clearToken removes a set token', async () => {
    const ts = new TokenStore(makeRawStore('existing'));
    await ts.clearToken();
    expect(await ts.getToken()).toBeNull();
  });

  test('hasToken returns false when no token', async () => {
    const ts = new TokenStore(makeRawStore());
    expect(await ts.hasToken()).toBe(false);
  });

  test('hasToken returns true after setToken', async () => {
    const ts = new TokenStore(makeRawStore());
    await ts.setToken('tok-xyz');
    expect(await ts.hasToken()).toBe(true);
  });

  test('hasToken returns false after clearToken', async () => {
    const ts = new TokenStore(makeRawStore('tok'));
    await ts.clearToken();
    expect(await ts.hasToken()).toBe(false);
  });

  test('setToken(null) clears the token', async () => {
    const ts = new TokenStore(makeRawStore('tok'));
    await ts.setToken(null);
    expect(await ts.getToken()).toBeNull();
  });

  test('store accessor returns the underlying raw store', () => {
    const raw = makeRawStore();
    const ts = new TokenStore(raw);
    expect(ts.store).toBe(raw);
  });

  test('initializes with provided token', async () => {
    const ts = new TokenStore(makeRawStore('seed-token'));
    expect(await ts.getToken()).toBe('seed-token');
  });
});
