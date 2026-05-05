/**
 * android-keystore-token-store.test.ts
 *
 * Unit tests for `createAndroidKeystoreTokenStore`.
 *
 * `react-native-keychain` is mocked via the `__loadModule` factory injection seam.
 * The real `createAndroidKeystoreTokenStore` factory runs end-to-end; only the
 * native module acquisition is replaced with an in-memory mock. Tests verify:
 *   - getToken/setToken/clearToken round-trip
 *   - expiresAt preserved via setTokenEntry/getTokenEntry
 *   - Graceful SDKError when native module is missing
 *   - Options (service, accessible, accessControl) passed through correctly
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createAndroidKeystoreTokenStore } from '../packages/sdk/src/client-auth/android-keystore-token-store.js';

// ---------------------------------------------------------------------------
// Mock react-native-keychain (in-memory, covers Android path)
// ---------------------------------------------------------------------------

interface KeychainEntry { username: string; password: string }

const keychainStore: Map<string, KeychainEntry> = new Map();

const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'WUDT';
const BIOMETRY_ANY = 'BIO_ANY';
const DEVICE_PASSCODE = 'DEV_PC';

const mockKeychain = {
  ACCESSIBLE: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    WHEN_UNLOCKED: 'WU',
    AFTER_FIRST_UNLOCK: 'AFU',
    ALWAYS: 'ALWAYS',
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'WPSTDO',
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFUTDO',
    ALWAYS_THIS_DEVICE_ONLY: 'ATDO',
  },
  ACCESS_CONTROL: {
    BIOMETRY_ANY,
    BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BIO_ANY_OR_PC',
    BIOMETRY_CURRENT_SET: 'BIO_CURRENT',
    BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'BIO_CURRENT_OR_PC',
    DEVICE_PASSCODE,
    APPLICATION_PASSWORD: 'APP_PW',
  },
  setGenericPassword: mock(async (
    username: string,
    password: string,
    opts?: Record<string, unknown>,
  ): Promise<false | { service: string; storage: string }> => {
    const key = (opts?.['service'] as string | undefined) ?? 'default';
    keychainStore.set(key, { username, password });
    return { service: key, storage: 'keystore' };
  }),
  getGenericPassword: mock(async (
    opts?: Record<string, unknown>,
  ): Promise<false | { username: string; password: string; service: string; storage: string }> => {
    const key = (opts?.['service'] as string | undefined) ?? 'default';
    const entry = keychainStore.get(key);
    if (!entry) return false;
    return { ...entry, service: key, storage: 'keystore' };
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

describe('createAndroidKeystoreTokenStore (real factory + mock module)', () => {
  beforeEach(() => {
    keychainStore.clear();
    mockKeychain.setGenericPassword.mockClear();
    mockKeychain.getGenericPassword.mockClear();
    mockKeychain.resetGenericPassword.mockClear();
  });

  it('returns null token when keystore is empty', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken/getToken round-trip', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-abc');
    const token = await ts.getToken();
    expect(token).toBe('and-tok-abc');
  });

  it('clearToken removes the stored entry', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-abc');
    await ts.clearToken();
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setToken(null) removes the stored entry', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-xyz');
    await ts.setToken(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('setTokenEntry/getTokenEntry preserves expiresAt', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const expiry = 1_950_000_000_000;
    await ts.setTokenEntry('and-tok-exp', expiry);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('and-tok-exp');
    expect(entry.expiresAt).toBe(expiry);
  });

  it('getTokenEntry returns undefined expiresAt when set via setToken', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-no-exp');
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBe('and-tok-no-exp');
    expect(entry.expiresAt).toBeUndefined();
  });

  it('getTokenEntry returns null token when keystore is empty', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const entry = await ts.getTokenEntry();
    expect(entry.token).toBeNull();
  });

  it('uses the provided service option', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.custom.and', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-svc');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['service']).toBe('com.custom.and');
  });

  it('passes accessControl:BIOMETRY_ANY through to options', async () => {
    const ts = createAndroidKeystoreTokenStore(
      { service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', accessControl: 'BIOMETRY_ANY' },
      mockLoader,
    );
    await ts.setToken('and-tok-bio');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['accessControl']).toBe(BIOMETRY_ANY);
  });

  it('passes accessControl:DEVICE_PASSCODE through to options', async () => {
    const ts = createAndroidKeystoreTokenStore(
      { service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', accessControl: 'DEVICE_PASSCODE' },
      mockLoader,
    );
    await ts.setToken('and-tok-pc');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['accessControl']).toBe(DEVICE_PASSCODE);
  });

  it('resolves accessible constant from module ACCESSIBLE map', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'AFTER_FIRST_UNLOCK' }, mockLoader);
    await ts.setToken('and-tok-afu');
    const opts = mockKeychain.setGenericPassword.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts['accessible']).toBe('AFU');
  });

  it('rejects unsupported accessible constants instead of using platform defaults', async () => {
    const loader = () => Promise.resolve({
      ...mockKeychain,
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    });
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'AFTER_FIRST_UNLOCK' }, loader);
    await expect(ts.setToken('and-tok-afu')).rejects.toThrow(/does not expose ACCESSIBLE.AFTER_FIRST_UNLOCK/);
  });

  it('rejects unsupported access-control constants instead of using platform defaults', async () => {
    const loader = () => Promise.resolve({
      ...mockKeychain,
      ACCESS_CONTROL: { BIOMETRY_ANY },
    });
    const ts = createAndroidKeystoreTokenStore(
      { service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY', accessControl: 'DEVICE_PASSCODE' },
      loader,
    );
    await expect(ts.setToken('and-tok-pc')).rejects.toThrow(/does not expose ACCESS_CONTROL.DEVICE_PASSCODE/);
  });

  it('setTokenEntry with null token clears storage', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts.setToken('and-tok-before');
    await ts.setTokenEntry(null);
    const token = await ts.getToken();
    expect(token).toBeNull();
  });

  it('isolates entries by service key', async () => {
    const ts1 = createAndroidKeystoreTokenStore({ service: 'com.app1.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    const ts2 = createAndroidKeystoreTokenStore({ service: 'com.app2.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    await ts1.setToken('tok-and-app1');
    await ts2.setToken('tok-and-app2');
    expect(await ts1.getToken()).toBe('tok-and-app1');
    expect(await ts2.getToken()).toBe('tok-and-app2');
  });

  it('clears and reports corrupt stored payloads', async () => {
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.gv', accessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }, mockLoader);
    keychainStore.set('com.test.gv', { username: 'goodvibes', password: '{not-json' });

    await expect(ts.getToken()).rejects.toMatchObject({
      code: 'SDK_TOKEN_STORE_CORRUPT',
      recoverable: true,
    });
    expect(keychainStore.has('com.test.gv')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error when react-native-keychain is absent
// ---------------------------------------------------------------------------

describe('createAndroidKeystoreTokenStore — missing peer dep', () => {
  it('throws SDKError with kind=config and install hint when module absent', async () => {
    // No __loadModule provided — factory will try real dynamic import('react-native-keychain')
    // which fails because react-native-keychain is not installed in this test environment
    const ts = createAndroidKeystoreTokenStore({ service: 'com.test.absent' });

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
