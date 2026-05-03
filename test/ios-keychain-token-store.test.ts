/**
 * ios-keychain-token-store.test.ts
 *
 * Unit tests for `createIOSKeychainTokenStore`.
 *
 * `react-native-keychain` is mocked via the `__loadModule` factory injection seam.
 * The real `createIOSKeychainTokenStore` factory runs end-to-end; only the
 * native module acquisition is replaced with an in-memory mock. Tests verify:
 *   - getToken/setToken/clearToken round-trip
 *   - expiresAt preserved via setTokenEntry/getTokenEntry
 *   - Graceful SDKError when native module is missing
 *   - Options (service, accessible, accessGroup) passed through correctly
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createIOSKeychainTokenStore } from '../packages/sdk/src/client-auth/ios-keychain-token-store.js';

// ---------------------------------------------------------------------------
// Mock react-native-keychain (in-memory)
// ---------------------------------------------------------------------------

interface KeychainEntry { username: string; password: string }

const keychainStore: Map<string, KeychainEntry> = new Map();

const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WUDT';
const WHEN_UNLOCKED = 'WU';

const mockKeychain = {
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    WHEN_UNLOCKED,
    AFTER_FIRST_UNLOCK: 'AFU',
    ALWAYS: 'ALWAYS',
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'WPSTDO',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFUTDO',
    ALWAYS_THIS_DEVICE_ONLY: 'ATDO',
  },
  ACCESS_CONTROL: {
    BIOMETRY_ANY: 'BIO_ANY',
    DEVICE_PASSCODE: 'DEV_PC',
  },
  setGenericPassword: mock(async (
    username: string,
    password: string,
    opts?: Record<string, unknown>,
  ): Promise<false | { service: string; storage: string }> => {
    const key = (opts?.['service'] as string | undefined) ?? 'default';
    keychainStore.set(key, { username, password });
    return { service: key, storage: 'keychain' };
  }),
  getGenericPassword: mock(async (
    opts?: Record<string, unknown>,
  ): Promise<false | { username: string; password: string; service: string; storage: string }> => {
    const key = (opts?.['service'] as string | undefined) ?? 'default';
    const entry = keychainStore.get(key);
    if (!entry) return false;
    return { ...entry, service: key, storage: 'keychain' };
  }),
  resetGenericPassword: mock(async (opts?: Record<string, unknown>): Promise<boolean> => {
    const key = (opts?.['service'] as string | undefined) ?? 'default';
    keychainStore.delete(key);
    return true;
  }),
};

// __loadModule seam: returns the mock module instead of dynamic import('react-native-keychain')
const mockLoader = () => Promise.resolve(mockKeychain);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createIOSKeychainTokenStore (real factory + mock module)', () => {
  beforeEach(() => {
    keychainStore.clear();
    mockKeychain.setGenericPassword.mockClear();
    mockKeychain.getGenericPassword.mockClear();
    mockKeychain.resetGenericPassword.mockClear();
  });

  it('returns null token when keychain is empty', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken/getToken round-trip', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-abc');
    const token = await ts.getToken();
    expect(token).toBe('ios-tok-abc');
  });

  it('clearToken removes the stored entry', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-abc');
    await ts.clearToken();
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken(null) removes the stored entry', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-xyz');
    await ts.setToken(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setTokenEntry/getTokenEntry preserves expiresAt', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const expiry = 1_900_000_000_000;
    await ts.setTokenEntry('ios-tok-exp', expiry);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('ios-tok-exp');
    expect(entry.expiresAt).toBe(expiry);
  });

  it('getTokenEntry returns undefined expiresAt when set via setToken', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-no-exp');
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('ios-tok-no-exp');
    expect(entry.expiresAt).toBeUndefined();
  });

  it('getTokenEntry returns null token when keychain is empty', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBeNull();
  });

  it('uses the provided service option', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.custom.svc', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-svc');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['service']).toBe('com.custom.svc');
  });

  it('passes accessGroup option through', async () => {
    const ts = createIOSKeychainTokenStore(
      { service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', accessGroup: 'group.com.myapp' },
      mockLoader,
    );
    await ts.setToken('ios-tok-grp');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['accessGroup']).toBe('group.com.myapp');
  });

  it('resolves accessible constant from module ACCESSIBLE map', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED' }, mockLoader);
    await ts.setToken('ios-tok-wu');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['accessible']).toBe(WHEN_UNLOCKED);
  });

  it('setTokenEntry with null token clears storage', async () => {
    const ts = createIOSKeychainTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('ios-tok-before');
    await ts.setTokenEntry(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('isolates entries by service key', async () => {
    const ts1 = createIOSKeychainTokenStore({ service: 'com.app1.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const ts2 = createIOSKeychainTokenStore({ service: 'com.app2.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts1.setToken('tok-app1');
    await ts2.setToken('tok-app2');
    expect(await ts1.getToken()).toBe('tok-app1');
    expect(await ts2.getToken()).toBe('tok-app2');
  });
});

// ---------------------------------------------------------------------------
// Error when react-native-keychain is absent
// ---------------------------------------------------------------------------

describe('createIOSKeychainTokenStore — missing peer dep', () => {
  it('throws SDKError with kind=config and install hint when module absent', async () => {
    // No __loadModule provided — factory will try real dynamic import('react-native-keychain')
    // which fails because react-native-keychain is not installed in this test environment
    const ts = createIOSKeychainTokenStore({ service: 'com.test.absent' });

    let thrown: unknown = null;
    try {
      await ts.getToken();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    const err = thrown as { kind?: string; message?: string; code?: string };
    expect(err.kind).toBe('config');
    expect(err.code).toBe('RN_KEYCHAIN_NOT_INSTALLED');
    expect(typeof err.message).toBe('string');
    expect((err.message as string).includes('react-native-keychain')).toBe(true);
  });
});
