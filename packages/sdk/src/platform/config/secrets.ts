/**
 * SecretsManager, hierarchy-aware secret resolution and persistence.
 *
 * Resolution order:
 *   1. Environment variable (process.env[key])
 *   2. Daemon stores (~/.goodvibes/daemon/secrets.enc, then secrets.json)
 *   3. Project/ancestor secure stores (.goodvibes/<surface>/secrets.enc), nearest first
 *   4. Project/ancestor plaintext stores (.goodvibes/<surface>.secrets.json), nearest first
 *   5. User secure store (~/.goodvibes/<surface>/secrets.enc)
 *   6. User plaintext store (~/.goodvibes/<surface>.secrets.json)
 *   7. If a resolved value is a SecretRef, resolve through the referenced provider
 *
 * The three scopes and the files behind them are documented in
 * secrets-store-paths.ts. The daemon tier leads because a credential the daemon
 * executes with has one home and a surface silo can only hold a stale copy of
 * it; the tier is empty until something writes to it, so a store with no daemon
 * secrets resolves exactly as it did before the tier existed.
 *
 * The active policy decides whether plaintext stores are eligible:
 *   - plaintext_allowed  → read/write plaintext or secure
 *   - preferred_secure   → prefer secure, allow plaintext fallback with warning
 *   - require_secure     → never read/write plaintext
 *
 * Encryption keys come from a random keyfile (~/.goodvibes/secrets.key,
 * 0600 in a 0700 directory), generated on first need, never from host
 * identity, so stores survive hostname/username changes and machine moves.
 * Stores written by older SDKs (host-identity key, no version field) are
 * migrated to the keyfile format on first successful read. A store that
 * exists but cannot be decrypted is a distinct, surfaced error state, it is
 * never treated as empty and never overwritten.
 *
 * Secret values are never logged.
 */

import { dirname, isAbsolute, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { ConfigManager } from './manager.js';
import {
  SecretStoreUnreadableError,
  SECRETS_STORE_FORMAT_VERSION,
  assertCachedKeyIsCurrent,
  decryptStore as decrypt,
  deriveLegacyEncryptionKey,
  encryptStore as encrypt,
  keyFingerprint,
  loadOrCreateKeyfile,
  type EncryptedStoreEnvelope,
} from './secrets-keyfile.js';
export { SecretStoreUnreadableError } from './secrets-keyfile.js';
import { getSecretRefSource, isSecretRefInput, resolveSecretRef } from './secret-refs.js';
import { listMigratableSecrets, migratableStores } from './secrets-migration-view.js';
import { logger } from '../utils/logger.js';
import { requireSurfaceRoot, resolveSharedDirectory } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { describeCredentialScope, isDaemonNeededSecretKey } from './credential-scope-registry.js';
import {
  allSecretStores,
  defaultDaemonSecretHome,
  secretReadOrder,
  secretWriteTarget,
  type SecretStoreLayout,
  type SecretStorePath,
} from './secrets-store-paths.js';

export type SecretStorageMode = 'plaintext_allowed' | 'preferred_secure' | 'require_secure';
export type {
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorePath,
} from './secrets-store-paths.js';
import type { SecretScope, SecretSource, SecretStorageMedium } from './secrets-store-paths.js';

export interface SecretRecord {
  readonly key: string;
  readonly source: SecretSource;
  readonly scope: SecretScope | 'env';
  readonly secure: boolean;
  readonly path?: string | undefined;
  readonly overriddenByEnv: boolean;
  readonly refSource?: string | undefined;
}

export interface SecretWriteOptions {
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
}

export interface SecretDeleteOptions {
  readonly scope?: SecretScope | undefined;
  readonly medium?: SecretStorageMedium | undefined;
}

export interface SecretStorageReview {
  readonly policy: SecretStorageMode;
  readonly secureAvailable: boolean;
  readonly storedKeys: number;
  readonly envBackedKeys: number;
  readonly secureKeys: number;
  readonly plaintextKeys: number;
  readonly warnings: readonly string[];
  readonly locations: readonly {
    readonly source: Exclude<SecretSource, 'env'>;
    readonly path: string;
    readonly exists: boolean;
    readonly readable: boolean;
  }[];
}

type SecureStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Record<string, string> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

type PlaintextStoreReadResult =
  | { readonly status: 'ok'; readonly secrets: Record<string, string> }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable'; readonly reason: string };

interface PlaintextStore {
  readonly version: 1;
  readonly secrets: Record<string, string>;
}

/**
 * Identity used only to decrypt legacy stores (written before keyfile-derived
 * encryption existed). Overridable so tests can simulate stores written on a
 * machine with a different hostname/username.
 */
export interface LegacyStoreIdentity {
  readonly hostname: string;
  readonly username: string;
}

export interface SecretsManagerOptions {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly surfaceRoot: string;
  /**
   * The daemon's state root, holding the daemon-scoped stores. Defaults to
   * `<globalHome>/.goodvibes/daemon`; a caller that honors `--daemon-home` or
   * `GOODVIBES_DAEMON_HOME` resolves it first and passes it here, so the daemon
   * and its clients agree on one file.
   */
  readonly daemonHome?: string | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  readonly policy?: SecretStorageMode | undefined;
  readonly secureProjectFilePath?: string | undefined;
  readonly secureUserFilePath?: string | undefined;
  readonly secureDaemonFilePath?: string | undefined;
  readonly plaintextProjectFilePath?: string | undefined;
  readonly plaintextUserFilePath?: string | undefined;
  readonly plaintextDaemonFilePath?: string | undefined;
  /** Override the keyfile location (defaults to <globalHome>/.goodvibes/secrets.key). */
  readonly keyFilePath?: string | undefined;
  /** Override the host identity used to decrypt legacy stores (tests only). */
  readonly legacyIdentity?: LegacyStoreIdentity | undefined;
}

function requireAbsoluteOwnedPath(path: string, name: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error(`SecretsManager ${name} must be a non-empty absolute path.`);
  }
  if (!isAbsolute(trimmed)) {
    throw new Error(`SecretsManager ${name} must be an absolute path.`);
  }
  return resolve(trimmed);
}

function normalizeOptionalOwnedPath(path: string | undefined, name: string): string | undefined {
  return path === undefined ? undefined : requireAbsoluteOwnedPath(path, name);
}

function loadConfiguredSecretPolicy(configManager?: Pick<ConfigManager, 'get'>): SecretStorageMode {
  try {
    return (configManager?.get('storage.secretPolicy') as SecretStorageMode | undefined) ?? 'preferred_secure';
  } catch {
    return 'preferred_secure';
  }
}

/**
 * Where a write lands when the caller did not name a scope.
 *
 * A credential a daemon-owned config path names is one the daemon executes
 * with, so its home is the daemon tier, the same rule config-ownership.ts
 * applies to the setting that points at it. Getting this wrong is not cosmetic:
 * a replicated surface token written to the project store lands under whatever
 * directory the daemon happened to start in, and the next start from a
 * different directory reads a store that does not have it.
 *
 * Everything that is not daemon-owned keeps the historical default.
 */
function defaultScopeForKey(key: string): SecretScope {
  return isDaemonNeededSecretKey(key) ? 'daemon' : 'project';
}

/**
 * Where a write to `key` will actually go, given what the caller asked for.
 *
 * **Daemon ownership beats an explicit scope, deliberately.** It used to be the
 * other way round, an explicit `scope` won, and that made the routing above
 * defeatable by the ordinary path a person takes to store a credential:
 * `/secrets set` passes a scope on every call, so a daemon-owned password went
 * into a client silo the daemon never reads. The credential reported success
 * and did nothing, which is the exact failure the ownership rule exists to
 * prevent.
 *
 * The alternative, refusing the write and telling the caller to pick a
 * different scope, was rejected: it turns a storage bug into a wall in front
 * of the credentials people most need to set, and the caller's scope argument
 * is nearly always a default it never thought about rather than an intent.
 *
 * So the write is honoured and RELOCATED, never dropped, and the relocation is
 * disclosed rather than silent: `set()` logs it naming both scopes, and this
 * function is exported so a surface can tell the operator where a credential is
 * going BEFORE it asks for it.
 */
export function resolveSecretWriteScope(key: string, requested?: SecretScope | undefined): SecretScope {
  if (isDaemonNeededSecretKey(key)) return 'daemon';
  return requested ?? defaultScopeForKey(key);
}

/** True when `requested` would have sent a daemon-owned credential somewhere the daemon cannot read. */
export function secretWriteScopeWasOverridden(key: string, requested?: SecretScope | undefined): boolean {
  return requested !== undefined && requested !== 'daemon' && isDaemonNeededSecretKey(key);
}

/** Why `key` was filed where it was. Safe to display: names only, never values. */
export function describeSecretWriteScope(key: string): string {
  return describeCredentialScope(key);
}

export class SecretsManager {
  /** Change listeners, fired after a successful set() or delete() so credential consumers (e.g. the provider registry) re-resolve LIVE, no restart. */
  private readonly changeListeners = new Set<(key: string) => void>();

  /** Subscribe to secret writes/deletes. Returns an unsubscribe function. */
  onDidChange(listener: (key: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private notifyChanged(key: string): void {
    for (const listener of [...this.changeListeners]) {
      try { listener(key); } catch (error) {
        logger.warn('SecretsManager: change listener failed', { key, error: summarizeError(error) });
      }
    }
  }

  private encKey: Buffer | null = null;
  private readonly keyFilePath: string;
  private readonly options: SecretsManagerOptions;
  private readonly surfaceRoot: string;
  private readonly reportedUnreadableStores = new Set<string>();

  private readonly layout: SecretStoreLayout;

  constructor(options: SecretsManagerOptions) {
    this.surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'SecretsManager surfaceRoot');
    const globalHome = requireAbsoluteOwnedPath(options.globalHome, 'globalHome');
    this.options = {
      ...options,
      projectRoot: requireAbsoluteOwnedPath(options.projectRoot, 'projectRoot'),
      globalHome,
      daemonHome: normalizeOptionalOwnedPath(options.daemonHome, 'daemonHome')
        ?? defaultDaemonSecretHome(globalHome),
      secureProjectFilePath: normalizeOptionalOwnedPath(options.secureProjectFilePath, 'secureProjectFilePath'),
      secureUserFilePath: normalizeOptionalOwnedPath(options.secureUserFilePath, 'secureUserFilePath'),
      secureDaemonFilePath: normalizeOptionalOwnedPath(options.secureDaemonFilePath, 'secureDaemonFilePath'),
      plaintextProjectFilePath: normalizeOptionalOwnedPath(options.plaintextProjectFilePath, 'plaintextProjectFilePath'),
      plaintextUserFilePath: normalizeOptionalOwnedPath(options.plaintextUserFilePath, 'plaintextUserFilePath'),
      plaintextDaemonFilePath: normalizeOptionalOwnedPath(options.plaintextDaemonFilePath, 'plaintextDaemonFilePath'),
    };
    this.layout = {
      projectRoot: this.options.projectRoot,
      globalHome: this.options.globalHome,
      daemonHome: this.options.daemonHome ?? defaultDaemonSecretHome(globalHome),
      surfaceRoot: this.surfaceRoot,
      secureProjectFilePath: this.options.secureProjectFilePath,
      secureUserFilePath: this.options.secureUserFilePath,
      secureDaemonFilePath: this.options.secureDaemonFilePath,
      plaintextProjectFilePath: this.options.plaintextProjectFilePath,
      plaintextUserFilePath: this.options.plaintextUserFilePath,
      plaintextDaemonFilePath: this.options.plaintextDaemonFilePath,
    };
    this.keyFilePath = normalizeOptionalOwnedPath(options.keyFilePath, 'keyFilePath')
      ?? resolveSharedDirectory(this.options.globalHome, 'secrets.key');
  }

  /** Load the encryption key, generating a fresh one exclusively on first need, see secrets-keyfile.ts. */
  private getEncryptionKey(): Buffer {
    this.encKey ??= loadOrCreateKeyfile(this.keyFilePath);
    return this.encKey;
  }

  getGlobalHome(): string {
    return this.options.globalHome;
  }

  async get(key: string): Promise<string | null> {
    return this.getInternal(key, new Set([key]));
  }

  /**
   * Read `key` from ONE tier, ignoring the read order and the environment.
   *
   * `get()` answers "what value would be used", which is the right question
   * almost everywhere and the wrong one for migration: a surface copy read
   * through `get()` returns whatever the DAEMON tier holds, because the daemon
   * tier leads. Moving a credential needs to see each tier separately, read
   * the surface copy, write the daemon copy, read the daemon copy BACK and
   * compare, and a resolver that transparently prefers one tier makes that
   * comparison meaningless.
   *
   * Returns the value exactly as stored. A `goodvibes://` reference is NOT
   * followed: migration moves the stored bytes, and following a reference here
   * would copy the pointed-at value over the pointer.
   */
  async getFromScope(key: string, scope: SecretScope, storePath?: string): Promise<string | null> {
    for (const path of this.getMigratableStores()) {
      if (storePath !== undefined ? path.path !== storePath : path.scope !== scope) continue;
      const secrets = path.secure ? this.readEncryptedFile(path.path) : this.readPlaintextFile(path.path);
      if (secrets !== null && key in secrets) return secrets[key] ?? null;
    }
    return null;
  }

  private async getInternal(key: string, seen: Set<string>): Promise<string | null> {
    const envValue = process.env[key]!;
    if (envValue !== undefined) {
      logger.debug('SecretsManager: resolved from env', { key });
      return this.resolveMaybeReferencedValue(key, envValue, seen);
    }

    for (const path of this.getReadOrder()) {
      const secrets = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (secrets !== null && key in secrets) {
        logger.debug('SecretsManager: resolved from store', { key, source: path.source });
        const value = secrets[key]!;
        return value === undefined ? null : this.resolveMaybeReferencedValue(key, value, seen);
      }
    }

    return null;
  }

  private async resolveMaybeReferencedValue(key: string, value: string, seen: Set<string>): Promise<string | null> {
    if (!isSecretRefInput(value)) return value;

    try {
      const resolved = await resolveSecretRef(value, {
        resolveLocalSecret: async (nextKey) => {
          if (seen.has(nextKey)) {
            throw new Error(`Recursive GoodVibes secret reference for ${nextKey}`);
          }
          const nextSeen = new Set(seen);
          nextSeen.add(nextKey);
          return this.getInternal(nextKey, nextSeen);
        },
        homeDirectory: this.options.globalHome,
      });
      logger.debug('SecretsManager: resolved secret reference', { key, refSource: resolved.source });
      return resolved.value;
    } catch (error) {
      logger.warn('SecretsManager: failed to resolve secret reference', {
        key,
        refSource: getSecretRefSource(value) ?? 'unknown',
        error: summarizeError(error),
      });
      return null;
    }
  }

  async set(key: string, value: string, options: SecretWriteOptions = {}): Promise<void> {
    const policy = this.getPolicy();
    const medium = options.medium ?? this.getDefaultWriteMedium(policy);
    const scope = resolveSecretWriteScope(key, options.scope);
    if (secretWriteScopeWasOverridden(key, options.scope)) {
      // Disclosed, not silent: the caller asked for one home and the credential
      // went to another, and it did so because the other one is the only home
      // the daemon reads. See resolveSecretWriteScope.
      logger.info('SecretsManager: daemon-owned credential filed in the daemon tier', {
        key,
        requestedScope: options.scope,
        actualScope: scope,
        reason: describeCredentialScope(key),
      });
    }

    if (policy === 'require_secure' && medium === 'plaintext') {
      throw new Error('Secret policy require_secure forbids plaintext persistence');
    }

    const target = this.resolveWriteTarget(scope, medium);
    const existing = this.readStoreForWrite(target);
    existing[key] = value;

    try {
      if (target.secure) {
        this.writeEncryptedFile(target.path, existing);
      } else {
        this.writePlaintextFile(target.path, existing);
      }
      logger.debug('SecretsManager: stored secret', { key, source: target.source });
      this.notifyChanged(key);
      return;
    } catch (error) {
      if (policy === 'preferred_secure' && target.secure && !(error instanceof SecretStoreUnreadableError)) {
        const fallback = this.resolveWriteTarget(scope, 'plaintext');
        const fallbackExisting = this.readStoreForWrite(fallback);
        fallbackExisting[key] = value;
        this.writePlaintextFile(fallback.path, fallbackExisting);
        logger.warn('SecretsManager: secure write failed, fell back to plaintext', {
          key,
          path: fallback.path,
          error: summarizeError(error),
        });
        this.notifyChanged(key);
        return;
      }
      throw error;
    }
  }

  /**
   * Load a store's current contents ahead of a write. A missing file is a
   * legitimately empty store; a file that exists but cannot be read refuses
   * the write outright, overwriting it would destroy every secret it holds.
   */
  private readStoreForWrite(target: SecretStorePath): Record<string, string> {
    const result = target.secure
      ? this.readEncryptedStore(target.path)
      : this.readPlaintextStore(target.path);
    if (result.status === 'unreadable') {
      throw new SecretStoreUnreadableError(
        `Refusing to write to the secrets store at ${target.path}: the file exists but cannot be read (${result.reason}). Overwriting it would destroy its contents; restore or move the file first.`,
      );
    }
    return result.status === 'ok' ? { ...result.secrets } : {};
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>();
    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  async listDetailed(): Promise<SecretRecord[]> {
    const envKeys = new Set(Object.keys(process.env));
    const records: SecretRecord[] = [];

    for (const path of this.getReadOrder()) {
      const values = path.secure
        ? this.readEncryptedFile(path.path)
        : this.readPlaintextFile(path.path);
      if (!values) continue;
      for (const key of Object.keys(values)) {
        const refSource = getSecretRefSource(values[key]!);
        records.push({
          key,
          source: path.source,
          scope: path.scope,
          secure: path.secure,
          path: path.path,
          overriddenByEnv: envKeys.has(key),
          ...(refSource ? { refSource } : {}),
        });
      }
    }

    for (const key of envKeys) {
      records.push({
        key,
        source: 'env',
        scope: 'env',
        secure: false,
        overriddenByEnv: false,
      });
    }

    return records.sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source));
  }

  async inspect(): Promise<SecretStorageReview> {
    const policy = this.getPolicy();
    const records = await this.listDetailed();
    const storedRecords = records.filter((record) => record.source !== 'env');
    const storeStates = this.getAllCandidateStores().map((store) => ({
      store,
      result: store.secure ? this.readEncryptedStore(store.path) : this.readPlaintextStore(store.path),
    }));
    const locations = storeStates.map(({ store, result }) => ({
      source: store.source,
      path: store.path,
      exists: existsSync(store.path),
      readable: result.status === 'ok',
    }));
    const warnings: string[] = [];
    for (const { store, result } of storeStates) {
      if (result.status === 'unreadable') {
        warnings.push(`store at ${store.path} exists but cannot be read (${result.reason})`);
      }
    }
    if (policy === 'preferred_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext fallback secrets are present');
    }
    if (policy === 'require_secure' && storedRecords.some((record) => !record.secure)) {
      warnings.push('plaintext secrets exist but are ignored by current policy');
    }

    return {
      policy,
      secureAvailable: true,
      storedKeys: new Set(storedRecords.map((record) => record.key)).size,
      envBackedKeys: new Set(records.filter((record) => record.source === 'env').map((record) => record.key)).size,
      secureKeys: new Set(storedRecords.filter((record) => record.secure).map((record) => record.key)).size,
      plaintextKeys: new Set(storedRecords.filter((record) => !record.secure).map((record) => record.key)).size,
      warnings,
      locations,
    };
  }

  /**
   * REVOKE. Removes the credential everywhere it can be reached.
   *
   * For a daemon-needed key the caller's `scope` is deliberately DISCARDED and
   * every tier is swept, because a revoke narrowed to one tier reports success
   * while leaving a live copy behind, a credential the operator believes is
   * gone and is not.
   *
   * That makes this the wrong method for moving a credential between tiers, and
   * the difference is not visible at the call site: the migration's "remove the
   * surface copy now the daemon copy is verified" was spelled
   * `delete(key, { scope: source })`, the key was daemon-needed by definition,
   * so the sweep ran and destroyed the daemon copy it had just written and
   * read back. Both stores ended empty while the report said `migrated: 1,
   * failed: 0`. Use `deleteFromScope` to remove ONE physical copy.
   */
  async delete(key: string, options: SecretDeleteOptions = {}): Promise<void> {
    const scopeFilter = isDaemonNeededSecretKey(key) ? undefined : options.scope;
    const stores = this.getAllCandidateStores().filter((store) => {
      if (scopeFilter && store.scope !== scopeFilter) return false;
      if (options.medium && (options.medium === 'secure') !== store.secure) return false;
      return true;
    });

    let removed = false;
    for (const store of stores) {
      const values = store.secure
        ? this.readEncryptedFile(store.path)
        : this.readPlaintextFile(store.path);
      if (!values || !(key in values)) continue;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (values as Record<string, unknown>)[key];
      if (store.secure) this.writeEncryptedFile(store.path, values);
      else this.writePlaintextFile(store.path, values);
      logger.debug('SecretsManager: deleted secret', { key, source: store.source });
      removed = true;
    }
    if (removed) this.notifyChanged(key);
  }

  /**
   * Remove ONE tier's copy, and never any other. The narrow counterpart to
   * `delete`: that one means "this credential is revoked" and sweeps every
   * tier; this means "this copy is redundant, the real one is elsewhere".
   * A separate method because the two were indistinguishable at the call site,
   * and the migration reached for the wrong one. Migration is the only caller.
   */
  async deleteFromScope(key: string, scope: SecretScope, storePath?: string): Promise<void> {
    let removed = false;
    for (const store of this.getMigratableStores()) {
      if (storePath !== undefined ? store.path !== storePath : store.scope !== scope) continue;
      const values = store.secure ? this.readEncryptedFile(store.path) : this.readPlaintextFile(store.path);
      if (!values || !(key in values)) continue;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (values as Record<string, unknown>)[key];
      if (store.secure) this.writeEncryptedFile(store.path, values);
      else this.writePlaintextFile(store.path, values);
      logger.debug('SecretsManager: removed one tier copy', { key, source: store.source });
      removed = true;
    }
    if (removed) this.notifyChanged(key);
  }

  private getPolicy(): SecretStorageMode {
    return this.options.policy ?? loadConfiguredSecretPolicy(this.options.configManager);
  }

  private getReadOrder(): SecretStorePath[] {
    return secretReadOrder(this.layout, this.getPolicy() !== 'require_secure');
  }

  private getAllCandidateStores(): SecretStorePath[] {
    return allSecretStores(this.layout);
  }

  /** Every store a MIGRATION may look in, including other surfaces' silos. */
  private getMigratableStores(): SecretStorePath[] {
    return migratableStores(this.layout, this.getAllCandidateStores());
  }

  /** Every credential a migration could move, across every surface's silo. */
  async listDetailedForMigration(): Promise<SecretRecord[]> {
    return listMigratableSecrets(
      this.getMigratableStores(),
      (path, secure) => (secure ? this.readEncryptedFile(path) : this.readPlaintextFile(path)),
    );
  }

  private resolveWriteTarget(scope: SecretScope, medium: SecretStorageMedium): SecretStorePath {
    return secretWriteTarget(this.layout, scope, medium);
  }

  private getDefaultWriteMedium(policy: SecretStorageMode): SecretStorageMedium {
    return policy === 'plaintext_allowed' ? 'plaintext' : 'secure';
  }

  /**
   * Read an encrypted store with three distinct outcomes: `ok` (decrypted),
   * `missing` (no file, a legitimately empty store), and `unreadable` (a file
   * exists but cannot be decrypted or parsed). Unreadable is never collapsed
   * into empty: writes to an unreadable store are refused so its contents are
   * never destroyed.
   *
   * Legacy stores (no `version` field, host-identity key) are migrated in
   * place on first successful read: decrypted with the legacy key, then
   * re-encrypted under the keyfile.
   */
  private readEncryptedStore(filePath: string): SecureStoreReadResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    const envelope = parsed as Partial<EncryptedStoreEnvelope>;
    if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }

    if (envelope.version === undefined) {
      return this.migrateLegacyStore(filePath, envelope as EncryptedStoreEnvelope);
    }
    if (envelope.version !== SECRETS_STORE_FORMAT_VERSION) {
      return {
        status: 'unreadable',
        reason: `store format version ${envelope.version} is not supported by this SDK version`,
      };
    }

    // Fingerprint fast-path: when the store records which key wrote it, a
    // mismatch is reported precisely instead of surfacing later as a bare
    // GCM authentication failure. Stores without keyId decrypt as before.
    const currentKeyId = keyFingerprint(this.getEncryptionKey());
    if (typeof envelope.keyId === 'string' && envelope.keyId !== currentKeyId) {
      return {
        status: 'unreadable',
        reason: `store was written with encryption key ${envelope.keyId}, but the current keyfile is ${currentKeyId}, the keyfile changed after this store was written`,
      };
    }

    try {
      const secrets = JSON.parse(decrypt(envelope as EncryptedStoreEnvelope, this.getEncryptionKey())) as Record<string, string>;
      return { status: 'ok', secrets };
    } catch (err) {
      return {
        status: 'unreadable',
        reason: `cannot decrypt with the current keyfile (${summarizeError(err)})`,
      };
    }
  }

  private migrateLegacyStore(filePath: string, envelope: EncryptedStoreEnvelope): SecureStoreReadResult {
    let plaintext: string;
    try {
      plaintext = decrypt(envelope, deriveLegacyEncryptionKey(this.options.legacyIdentity));
    } catch {
      return {
        status: 'unreadable',
        reason: 'legacy store cannot be decrypted with this machine\'s hostname and username (they changed since the store was written)',
      };
    }
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(plaintext) as Record<string, string>;
    } catch {
      return { status: 'unreadable', reason: 'legacy store decrypted to malformed content' };
    }
    try {
      this.writeEncryptedFile(filePath, secrets);
      logger.info('SecretsManager: migrated legacy encrypted secrets store to keyfile encryption', { path: filePath });
    } catch (error) {
      logger.warn('SecretsManager: decrypted legacy store but could not rewrite it under the keyfile', {
        path: filePath,
        error: summarizeError(error),
      });
    }
    return { status: 'ok', secrets };
  }

  /**
   * Lookup-flavored read: returns the secrets when readable, null otherwise.
   * An unreadable store logs one honest error per file per process; it is
   * never mistaken for an empty store on the write path (see set/delete).
   */
  private readEncryptedFile(filePath: string): Record<string, string> | null {
    const result = this.readEncryptedStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private reportUnreadableStore(filePath: string, reason: string): void {
    if (this.reportedUnreadableStores.has(filePath)) return;
    this.reportedUnreadableStores.add(filePath);
    logger.error('SecretsManager: store exists but cannot be read; its secrets are unavailable and the file will not be overwritten', {
      path: filePath,
      reason,
    });
  }

  private writeEncryptedFile(filePath: string, secrets: Record<string, string>): void {
    const key = this.getEncryptionKey();
    // Never encrypt with a cached key the keyfile no longer backs, the
    // resulting store would be unreadable by every other process (and by this
    // one after restart). A missing keyfile is restored from the cached key.
    assertCachedKeyIsCurrent(this.keyFilePath, key);
    const store = encrypt(JSON.stringify(secrets), key);
    // The 0700 directory mode is this store's own; the helper only creates the
    // directory when it is missing, so establishing it here keeps the mode.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(filePath, store, { mode: 0o600 });
  }

  private readPlaintextStore(filePath: string): PlaintextStoreReadResult {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', reason: summarizeError(err) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { status: 'unreadable', reason: 'store file is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    if ('version' in parsed && 'secrets' in parsed) {
      const secrets = (parsed as PlaintextStore).secrets;
      return secrets && typeof secrets === 'object'
        ? { status: 'ok', secrets }
        : { status: 'unreadable', reason: 'store file has an unrecognized shape' };
    }
    return { status: 'ok', secrets: parsed as Record<string, string> };
  }

  private readPlaintextFile(filePath: string): Record<string, string> | null {
    const result = this.readPlaintextStore(filePath);
    if (result.status === 'ok') return result.secrets;
    if (result.status === 'unreadable') this.reportUnreadableStore(filePath, result.reason);
    return null;
  }

  private writePlaintextFile(filePath: string, secrets: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const payload: PlaintextStore = { version: 1, secrets };
    writeJsonFileAtomic(filePath, payload, { mode: 0o600 });
  }
}
