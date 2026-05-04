/**
 * expo-secure-token-store.ts
 *
 * Token store backed by `expo-secure-store` — Expo's hardware-backed secure
 * storage layer (iOS Keychain / Android Keystore behind the scenes).
 *
 * `expo-secure-store` is an **optional peer dependency** — this module does
 * NOT eagerly import it. The module is loaded lazily so the SDK remains
 * loadable in environments where the native module is absent.
 *
 * ## Installation
 *
 * ```sh
 * expo install expo-secure-store
 * ```
 *
 * Wave 6 three-part error messages: [what happened] · [why] · [what to do]
 */
import { logger } from '../platform/utils/logger.js';

import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { GoodVibesTokenStore } from './types.js';

// ---------------------------------------------------------------------------
// Accessible constant names
// ---------------------------------------------------------------------------

/**
 * String union of the `SecureStore.ACCESSIBLE_*` constant names.
 * Resolved by property lookup on the dynamically-imported module so that
 * numeric values never need to be hard-coded here.
 */
export type ExpoSecureStoreAccessible =
  | 'AFTER_FIRST_UNLOCK'
  | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
  | 'ALWAYS'
  | 'ALWAYS_THIS_DEVICE_ONLY'
  | 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY'
  | 'WHEN_UNLOCKED'
  | 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExpoSecureTokenStoreOptions {
  /**
   * The key used for the secure-store entry.
   * @default 'goodvibes-sdk-token'
   */
  readonly key?: string | undefined;

  /**
   * iOS Keychain service name. Passed through to `SecureStore.setItemAsync`
   * as `keychainService`. Has no effect on Android.
   */
  readonly keychainService?: string | undefined;

  /**
   * Controls when the stored data is accessible. Maps to the
   * `SecureStore.ACCESSIBLE_*` constants.
   *
   * @default 'WHEN_UNLOCKED_THIS_DEVICE_ONLY'
   */
  readonly accessible?: ExpoSecureStoreAccessible | undefined;
}

// ---------------------------------------------------------------------------
// Stored payload (token + expiresAt in one secure-store entry)
// ---------------------------------------------------------------------------

interface StoredPayload {
  token: string;
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// Dynamic loader (cached per process)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type ExpoSecureStoreModule = typeof import('expo-secure-store');

let _mod: ExpoSecureStoreModule | null = null;

async function loadExpoSecureStore(): Promise<ExpoSecureStoreModule> {
  if (_mod !== null) return _mod;
  try {
    _mod = await import('expo-secure-store');
    return _mod;
  } catch {
    throw new GoodVibesSdkError(
      'expo-secure-store is not installed — the Expo secure token store cannot be initialised. ' +
        'This optional peer dependency is required to persist tokens in native hardware-backed storage. ' +
        'Run `expo install expo-secure-store` and rebuild your app.',
      {
        code: 'EXPO_SECURE_STORE_NOT_INSTALLED',
        category: 'config',
        source: 'config',
        recoverable: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Extended store interface (expiresAt support)
// ---------------------------------------------------------------------------

export interface ExpoSecureTokenStore extends GoodVibesTokenStore {
  /**
   * Persist a token together with an optional Unix-epoch expiry (ms).
   * Both values are serialised into a single secure-store entry.
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
 * Create a `GoodVibesTokenStore` backed by `expo-secure-store`.
 *
 * Both the `token` and `expiresAt` values are serialised as a single JSON
 * blob into one secure-store entry, keeping the keychain tidy.
 *
 * `expo-secure-store` is an **optional peer dependency** — install it with:
 *
 * ```sh
 * expo install expo-secure-store
 * ```
 *
 * @example
 * ```ts
 * import { createExpoSecureTokenStore, createExpoGoodVibesSdk } from '@pellux/goodvibes-sdk/expo';
 *
 * const tokenStore = createExpoSecureTokenStore({ key: 'gv-token' });
 * const sdk = createExpoGoodVibesSdk({ baseUrl: 'https://daemon.example.com', tokenStore });
 * ```
 */
export function createExpoSecureTokenStore(
  options: ExpoSecureTokenStoreOptions = {},
  __loadModule?: () => Promise<unknown>,
): ExpoSecureTokenStore {
  const key = options.key?.trim() || 'goodvibes-sdk-token';
  const accessible: ExpoSecureStoreAccessible =
    options.accessible ?? 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';
  const keychainService = options.keychainService;

  async function resolveModule(): Promise<ExpoSecureStoreModule> {
    if (__loadModule !== undefined) {
      return __loadModule() as Promise<ExpoSecureStoreModule>;
    }
    return loadExpoSecureStore();
  }

  function buildStoreOptions(mod: ExpoSecureStoreModule): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    const accessibleValue: string | undefined = mod[accessible];
    if (accessibleValue !== undefined) {
      opts['accessible'] = accessibleValue;
    } else if (options.accessible !== undefined) {
      console.warn(
        `[pellux/goodvibes-sdk] expo-secure-store does not expose ${accessible}; falling back to default`,
      );
    }
    if (keychainService !== undefined) {
      opts['keychainService'] = keychainService;
    }
    return opts;
  }

  async function readPayload(): Promise<StoredPayload | null> {
    const mod = await resolveModule();
    const raw = await mod.getItemAsync(key, buildStoreOptions(mod));
    if (raw === null || raw === '') return null;
    try {
      return JSON.parse(raw) as StoredPayload;
    } catch (err) {
      logger.debug('ExpoSecureTokenStore: failed to parse stored payload (clearing corrupt entry)', { error: String(err) });
      return null;
    }
  }

  async function writePayload(payload: StoredPayload | null): Promise<void> {
    const mod = await resolveModule();
    if (payload === null) {
      await mod.deleteItemAsync(key, buildStoreOptions(mod));
      return;
    }
    await mod.setItemAsync(key, JSON.stringify(payload), buildStoreOptions(mod));
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
