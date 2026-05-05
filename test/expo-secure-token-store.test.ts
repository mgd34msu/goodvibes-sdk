/**
 * expo-secure-token-store.test.ts
 *
 * Unit tests for `createExpoSecureTokenStore`.
 *
 * `expo-secure-store` is mocked via the `__loadModule` factory injection seam.
 * The real `createExpoSecureTokenStore` factory runs end-to-end; only the
 * native module acquisition is replaced with an in-memory mock. Tests verify:
 *   - getToken/setToken/clearToken round-trip
 *   - expiresAt preserved via setTokenEntry/getTokenEntry
 *   - Graceful SDKError when native module is missing
 *   - Options (key, keychainService, keychainAccessible) passed through correctly
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createExpoSecureTokenStore } from '../packages/sdk/src/client-auth/expo-secure-token-store.js';

// ---------------------------------------------------------------------------
// Mock expo-secure-store (in-memory)
// ---------------------------------------------------------------------------

const store: Map<string, string> = new Map();

const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;
const AFTER_FIRST_UNLOCK = 2;

const mockSecureStore = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  AFTER_FIRST_UNLOCK,
  ALWAYS: 3,
  WHEN_UNLOCKED: 4,
  ALWAYS_THIS_DEVICE_ONLY: 5,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 6,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 7,
  setItemAsync: mock(async (key: string, value: string, _opts?: unknown) => {
    store.set(key, value);
  }),
  getItemAsync: mock(async (key: string, _opts?: unknown): Promise<string | null> => {
    return store.get(key) ?? null;
  }),
  deleteItemAsync: mock(async (key: string, _opts?: unknown) => {
    store.delete(key);
  }),
};

// __loadModule seam: returns the mock module instead of dynamic import('expo-secure-store')
const mockLoader = () => Promise.resolve(mockSecureStore);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createExpoSecureTokenStore (real factory + mock module)', () => {
  beforeEach(() => {
    store.clear();
    mockSecureStore.setItemAsync.mockClear();
    mockSecureStore.getItemAsync.mockClear();
    mockSecureStore.deleteItemAsync.mockClear();
  });

  it('returns null token when store is empty', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken/getToken round-trip', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-abc');
    const token = await ts.getToken();
    expect(token).toBe('tok-abc');
  });

  it('clearToken removes the stored entry', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-abc');
    await ts.clearToken();
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken(null) removes the stored entry', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-xyz');
    await ts.setToken(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setTokenEntry/getTokenEntry preserves expiresAt', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const expiry = 1_800_000_000_000;
    await ts.setTokenEntry('tok-exp', expiry);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('tok-exp');
    expect(entry.expiresAt).toBe(expiry);
  });

  it('getTokenEntry returns undefined expiresAt when set via setToken', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-no-exp');
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('tok-no-exp');
    expect(entry.expiresAt).toBeUndefined();
  });

  it('getTokenEntry returns null token when store is empty', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBeNull();
  });

  it('uses the provided key for storage', async () => {
    const ts = createExpoSecureTokenStore({ key: 'custom-key', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-custom');
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(mockSecureStore.setItemAsync.mock.calls[0]![0]).toBe('custom-key');
  });

  it('passes keychainService option through', async () => {
    const ts = createExpoSecureTokenStore(
      { key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', keychainService: 'com.myapp.auth' },
      mockLoader,
    );
    await ts.setToken('tok-svc');
    const opts = mockSecureStore.setItemAsync.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['keychainService']).toBe('com.myapp.auth');
  });

  it('resolves accessible constant from module property', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'AFTER_FIRST_UNLOCK' }, mockLoader);
    await ts.setToken('tok-afu');
    const opts = mockSecureStore.setItemAsync.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['keychainAccessible']).toBe(AFTER_FIRST_UNLOCK);
  });

  it('rejects unsupported accessible constants instead of using platform defaults', async () => {
    const { AFTER_FIRST_UNLOCK: _omitted, ...secureStoreWithoutAfterFirstUnlock } = mockSecureStore;
    const loader = () => Promise.resolve({
      ...secureStoreWithoutAfterFirstUnlock,
      WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'AFTER_FIRST_UNLOCK' }, loader);
    await expect(ts.setToken('tok-afu')).rejects.toThrow(/does not expose AFTER_FIRST_UNLOCK/);
  });

  it('setTokenEntry with null token clears storage', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('tok-before');
    await ts.setTokenEntry(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('clears and reports corrupt stored payloads', async () => {
    const ts = createExpoSecureTokenStore({ key: 'gv-token', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    store.set('gv-token', '{not-json');

    await expect(ts.getToken()).rejects.toMatchObject({
      code: 'SDK_TOKEN_STORE_CORRUPT',
      recoverable: true,
    });
    expect(store.has('gv-token')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error when expo-secure-store is absent
// ---------------------------------------------------------------------------

describe('createExpoSecureTokenStore — missing peer dep', () => {
  it('throws SDKError with kind=config and install hint when module absent', async () => {
    // No __loadModule provided — factory will try real dynamic import('expo-secure-store')
    // which fails because expo-secure-store is not installed in this test environment
    const ts = createExpoSecureTokenStore({ key: 'gv-test' });

    let thrown: unknown = null;
    try {
      await ts.getToken();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    const err = thrown as { kind?: string; message?: string; code?: string };
    expect(err.kind).toBe('config');
    expect(err.code).toBe('EXPO_SECURE_STORE_NOT_INSTALLED');
    expect(typeof err.message).toBe('string');
    expect((err.message as string).includes('expo install expo-secure-store')).toBe(true);
  });
});
