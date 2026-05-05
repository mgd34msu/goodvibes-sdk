/**
 * ios-keychain-token-store.ts
 *
 * Token store backed by `react-native-keychain` for bare React Native on iOS.
 *
 * Uses `Keychain.setGenericPassword` / `getGenericPassword` /
 * `resetGenericPassword` to persist tokens in the iOS Keychain.
 *
 * `react-native-keychain` is an **optional peer dependency** — this module
 * does NOT import it at the top level.
 *
 * ## Installation
 *
 * ```sh
 * npm install react-native-keychain
 * npx pod-install   # iOS CocoaPods link
 * ```
 *
 * Error messages use the format: [what happened] · [why] · [what to do]
 */
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { GoodVibesTokenStore } from './types.js';

// ---------------------------------------------------------------------------
// Accessible constant names
// ---------------------------------------------------------------------------

/**
 * String union of the `Keychain.ACCESSIBLE` enum values.
 * Resolved by property lookup on `Keychain.ACCESSIBLE` at runtime.
 */
export type KeychainAccessible =
  | 'WHEN_UNLOCKED'
  | 'AFTER_FIRST_UNLOCK'
  | 'ALWAYS'
  | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY'
  | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
  | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  | 'ALWAYS_THIS_DEVICE_ONLY';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IOSKeychainTokenStoreOptions {
  /**
   * The keychain service identifier.
   * @default 'com.pellux.goodvibes-sdk'
   */
  readonly service?: string | undefined;

  /**
   * Controls when stored data is accessible.
   * Maps to `Keychain.ACCESSIBLE` constants.
   * @default 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
   */
  readonly accessible?: KeychainAccessible | undefined;

  /**
   * iOS Keychain access group for sharing credentials between apps.
   * Maps to `Keychain.Options.accessGroup`.
   */
  readonly accessGroup?: string | undefined;
}

// ---------------------------------------------------------------------------
// Stored payload
// ---------------------------------------------------------------------------

interface StoredPayload {
  token: string;
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Dynamic loader
// ---------------------------------------------------------------------------

type KeychainOptions = {
  service?: string | undefined;
  accessible?: string | undefined;
  accessGroup?: string | undefined;
};

type KeychainUserCredentials = {
  username: string;
  password: string;
  service: string;
  storage: string;
};

type KeychainModule = {
  ACCESSIBLE: Partial<Record<KeychainAccessible, string>>;
  setGenericPassword(
    username: string,
    password: string,
    options?: KeychainOptions,
  ): Promise<false | { service: string; storage: string }>;
  getGenericPassword(options?: KeychainOptions): Promise<false | KeychainUserCredentials>;
  resetGenericPassword(options?: KeychainOptions): Promise<boolean>;
};

const REACT_NATIVE_KEYCHAIN_MODULE: string = 'react-native-keychain';

let _mod: KeychainModule | null = null;

async function loadKeychain(): Promise<KeychainModule> {
  if (_mod !== null) return _mod;
  try {
    _mod = (await import(REACT_NATIVE_KEYCHAIN_MODULE)) as KeychainModule;
    return _mod;
  } catch {
    throw new GoodVibesSdkError(
      'react-native-keychain is not installed — the iOS Keychain token store cannot be initialised. ' +
        'This optional peer dependency is required to persist tokens in the iOS Keychain. ' +
        'Run `npm install react-native-keychain && npx pod-install` and rebuild your app.',
      {
        code: 'RN_KEYCHAIN_NOT_INSTALLED',
        category: 'config',
        source: 'config',
        recoverable: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Fixed username slot
// ---------------------------------------------------------------------------

const USERNAME_SLOT = 'goodvibes-sdk';

// ---------------------------------------------------------------------------
// Extended store interface (expiresAt support)
// ---------------------------------------------------------------------------

export interface IOSKeychainTokenStore extends GoodVibesTokenStore {
  /**
   * Persist a token together with an optional Unix-epoch expiry (ms).
   * Token and expiresAt are serialised as JSON in the keychain password slot.
   * Picked up automatically by the `TokenStore` wrapper via duck-typing.
   */
  setTokenEntry(token: string | null, expiresAt?: number): Promise<void>;

  /**
   * Return the stored token and optional expiry timestamp.
   * Picked up automatically by the `TokenStore` wrapper via duck-typing.
   */
  getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `GoodVibesTokenStore` backed by the iOS Keychain via
 * `react-native-keychain`.
 *
 * Suitable for **bare React Native** iOS apps. For Expo-managed workflow, use
 * `createExpoSecureTokenStore` instead.
 *
 * Both the `token` and `expiresAt` values are serialised as a single JSON
 * blob in the keychain password slot. The username slot is fixed to
 * `'goodvibes-sdk'`.
 *
 * `react-native-keychain` is an **optional peer dependency** — install it with:
 *
 * ```sh
 * npm install react-native-keychain
 * npx pod-install
 * ```
 *
 * @example
 * ```ts
 * import { createIOSKeychainTokenStore, createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
 *
 * const tokenStore = createIOSKeychainTokenStore({ service: 'com.myapp.gv' });
 * const sdk = createReactNativeGoodVibesSdk({ baseUrl: 'https://daemon.example.com', tokenStore });
 * ```
 */
export function createIOSKeychainTokenStore(
  options: IOSKeychainTokenStoreOptions = {},
  __loadModule?: () => Promise<unknown>,
): IOSKeychainTokenStore {
  const service = options.service ?? 'com.pellux.goodvibes-sdk';
  const accessible: KeychainAccessible = options.accessible ?? 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
  const accessGroup = options.accessGroup;

  async function resolveModule(): Promise<KeychainModule> {
    if (__loadModule !== undefined) {
      return __loadModule() as Promise<KeychainModule>;
    }
    return loadKeychain();
  }

  function buildOptions(mod: KeychainModule): KeychainOptions {
    const opts: KeychainOptions = { service };
    const accessibleValue = mod.ACCESSIBLE[accessible];
    if (accessibleValue !== undefined) {
      opts.accessible = accessibleValue;
    } else {
      throw new Error(
        `react-native-keychain does not expose ACCESSIBLE.${accessible}; choose a supported keychain accessibility constant.`,
      );
    }
    if (accessGroup !== undefined) {
      opts.accessGroup = accessGroup;
    }
    return opts;
  }

  async function readPayload(): Promise<StoredPayload | null> {
    const mod = await resolveModule();
    const result = await mod.getGenericPassword(buildOptions(mod));
    if (result === false) return null;
    try {
      return JSON.parse(result.password) as StoredPayload;
    } catch (err) {
      await mod.resetGenericPassword(buildOptions(mod));
      throw new GoodVibesSdkError('iOS keychain token store payload is corrupt and was cleared.', {
        code: 'SDK_TOKEN_STORE_CORRUPT',
        category: 'authentication',
        source: 'runtime',
        recoverable: true,
        cause: err,
      });
    }
  }

  async function writePayload(payload: StoredPayload | null): Promise<void> {
    const mod = await resolveModule();
    if (payload === null) {
      await mod.resetGenericPassword(buildOptions(mod));
      return;
    }
    await mod.setGenericPassword(USERNAME_SLOT, JSON.stringify(payload), buildOptions(mod));
  }

  return {
    async getToken(): Promise<string | null> {
      const payload = await readPayload();
      return payload?.token ?? null;
    },

    async setToken(token: string | null): Promise<void> {
      if (token === null) {
        await writePayload(null);
        return;
      }
      await writePayload({ token, expiresAt: null });
    },

    async clearToken(): Promise<void> {
      await writePayload(null);
    },

    async setTokenEntry(token: string | null, expiresAt?: number): Promise<void> {
      if (token === null) {
        await writePayload(null);
        return;
      }
      await writePayload({ token, expiresAt: expiresAt ?? null });
    },

    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      const payload = await readPayload();
      if (payload === null) return { token: null };
      const expiresAt = payload.expiresAt ?? undefined;
      return expiresAt !== undefined ? { token: payload.token, expiresAt } : { token: payload.token };
    },
  };
}
