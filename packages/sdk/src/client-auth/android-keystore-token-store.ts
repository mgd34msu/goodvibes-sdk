/**
 * android-keystore-token-store.ts
 *
 * Token store backed by `react-native-keychain` for bare React Native on Android.
 *
 * On Android, `react-native-keychain` routes to EncryptedSharedPreferences
 * backed by the Android Keystore system — hardware-backed AES-256-GCM
 * encryption where available (API 23+). This is the **recommended**
 * implementation for proper hardware-backed security.
 *
 * Alternative: `@react-native-async-storage/async-storage` can store the
 * token but is NOT hardware-backed. If you cannot use `react-native-keychain`,
 * wrap async-storage with an additional encryption layer (e.g.
 * `react-native-encrypted-storage`). The `react-native-keychain` path is
 * strongly preferred for production apps.
 *
 * `react-native-keychain` is an **optional peer dependency** — this module
 * does NOT import it at the top level.
 *
 * ## Installation
 *
 * ```sh
 * npm install react-native-keychain
 * # Android: auto-linked via Gradle; no manual step required
 * ```
 *
 * Error messages use the format: [what happened] · [why] · [what to do]
 */
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { GoodVibesTokenStore } from './types.js';

// ---------------------------------------------------------------------------
// Access control constant names
// ---------------------------------------------------------------------------

/**
 * String union of `Keychain.ACCESS_CONTROL` values relevant for Android.
 * `BIOMETRY_ANY` and `DEVICE_PASSCODE` are the two most useful options for
 * protecting Keystore-backed credentials with interactive auth prompts.
 */
export type AndroidAccessControl =
  | 'BIOMETRY_ANY'
  | 'BIOMETRY_ANY_OR_DEVICE_PASSCODE'
  | 'BIOMETRY_CURRENT_SET'
  | 'BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE'
  | 'DEVICE_PASSCODE'
  | 'APPLICATION_PASSWORD';

/**
 * String union of `Keychain.ACCESSIBLE` values (Android respects a subset).
 */
export type AndroidAccessible =
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

export interface AndroidKeystoreTokenStoreOptions {
  /**
   * The keychain service identifier (used as the SharedPreferences file name
   * prefix on Android).
   * @default 'com.pellux.goodvibes-sdk'
   */
  readonly service?: string | undefined;

  /**
   * Access control policy. Maps to `Keychain.ACCESS_CONTROL` constants.
   *
   * - `BIOMETRY_ANY` — require any enrolled biometric (fingerprint / face).
   * - `DEVICE_PASSCODE` — require the device passcode / PIN / pattern.
   *
   * Leave undefined to use the default Keystore protection without interactive
   * authentication prompts.
   */
  readonly accessControl?: AndroidAccessControl | undefined;

  /**
   * Controls when stored data is accessible.
   * Maps to `Keychain.ACCESSIBLE` constants (Android respects a subset).
   * @default 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
   */
  readonly accessible?: AndroidAccessible | undefined;
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
  accessControl?: string | undefined;
};

type KeychainUserCredentials = {
  username: string;
  password: string;
  service: string;
  storage: string;
};

type KeychainModule = {
  ACCESSIBLE: Partial<Record<AndroidAccessible, string>>;
  ACCESS_CONTROL: Partial<Record<AndroidAccessControl, string>>;
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
      'react-native-keychain is not installed — the Android Keystore token store cannot be initialised. ' +
        'This optional peer dependency is required to persist tokens in Android Keystore-backed storage. ' +
        'Run `npm install react-native-keychain` and rebuild your app.',
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

export interface AndroidKeystoreTokenStore extends GoodVibesTokenStore {
  /**
   * Persist a token together with an optional Unix-epoch expiry (ms).
   * Token and expiresAt are serialised as JSON in the Keystore password slot.
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
 * Create a `GoodVibesTokenStore` backed by the Android Keystore system via
 * `react-native-keychain`.
 *
 * On Android, `react-native-keychain` uses `EncryptedSharedPreferences` backed
 * by the Android Keystore — hardware-backed AES-256-GCM encryption where
 * supported (API 23+). This is strongly preferred over plain AsyncStorage.
 *
 * Pass `accessControl: 'BIOMETRY_ANY'` or `'DEVICE_PASSCODE'` to require
 * interactive user authentication before reading the stored credential.
 *
 * `react-native-keychain` is an **optional peer dependency** — install it with:
 *
 * ```sh
 * npm install react-native-keychain
 * # No manual Gradle/CocoaPods step required for Android
 * ```
 *
 * @example
 * ```ts
 * import { createAndroidKeystoreTokenStore, createReactNativeGoodVibesSdk } from '@pellux/goodvibes-sdk/react-native';
 *
 * const tokenStore = createAndroidKeystoreTokenStore({
 *   service: 'com.myapp.gv',
 *   accessControl: 'BIOMETRY_ANY',
 * });
 * const sdk = createReactNativeGoodVibesSdk({ baseUrl: 'https://daemon.example.com', tokenStore });
 * ```
 */
export function createAndroidKeystoreTokenStore(
  options: AndroidKeystoreTokenStoreOptions = {},
  __loadModule?: () => Promise<unknown>,
): AndroidKeystoreTokenStore {
  const service = options.service ?? 'com.pellux.goodvibes-sdk';
  const accessible: AndroidAccessible = options.accessible ?? 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
  const accessControl = options.accessControl;

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
    if (accessControl !== undefined) {
      const acValue = mod.ACCESS_CONTROL[accessControl];
      if (acValue !== undefined) {
        opts.accessControl = acValue;
      } else {
        throw new Error(
          `react-native-keychain does not expose ACCESS_CONTROL.${accessControl}; choose a supported keychain access-control constant.`,
        );
      }
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
      throw new GoodVibesSdkError('Android keystore token store payload is corrupt and was cleared.', {
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
