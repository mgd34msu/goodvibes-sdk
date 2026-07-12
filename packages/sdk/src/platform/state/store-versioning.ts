/**
 * SQLite schema versioning for every store the platform writes.
 *
 * Each store carries its schema version in `PRAGMA user_version`:
 * - opening a store at the current version is a no-op;
 * - an older store runs ordered migrations up to the target, with an
 *   automatic snapshot of the store file taken BEFORE any migration runs;
 * - a failed migration auto-restores the store from that pre-migration
 *   snapshot and reports honestly what happened and where the snapshot is;
 * - an older binary refuses a newer schema with an honest message instead
 *   of corrupting data it does not understand (the downgrade guard).
 *
 * Engine-agnostic: bun:sqlite and sql.js handles both adapt to the same
 * two-method interface.
 */

import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';

export interface VersionedSqliteHandle {
  getUserVersion(): number;
  setUserVersion(version: number): void;
}

/** Adapt a bun:sqlite Database to the version handle. */
export function bunSqliteVersionHandle(db: {
  query(sql: string): { get(): unknown };
  run(sql: string): unknown;
}): VersionedSqliteHandle {
  return {
    getUserVersion: () => {
      const row = db.query('PRAGMA user_version').get() as { user_version?: number } | null;
      return typeof row?.user_version === 'number' ? row.user_version : 0;
    },
    setUserVersion: (version) => {
      db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
    },
  };
}

/** Adapt a sql.js Database to the version handle. */
export function sqlJsVersionHandle(db: {
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  run(sql: string): unknown;
}): VersionedSqliteHandle {
  return {
    getUserVersion: () => {
      const result = db.exec('PRAGMA user_version');
      const value = result[0]?.values[0]?.[0];
      return typeof value === 'number' ? value : 0;
    },
    setUserVersion: (version) => {
      db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
    },
  };
}

export interface StoreMigration {
  /** The schema version this migration produces. */
  readonly toVersion: number;
  readonly migrate: () => void;
}

/** An older binary refusing a newer store — data is left untouched. */
export class StoreSchemaDowngradeError extends Error {
  constructor(
    readonly storeName: string,
    readonly dbPath: string,
    readonly storeVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `${storeName} at ${dbPath} uses schema v${storeVersion}, but this build only understands up to v${supportedVersion} — `
      + 'it was written by a newer version. Refusing to open so nothing is corrupted; '
      + 'run the newer version, or restore a snapshot taken by it.',
    );
    this.name = 'StoreSchemaDowngradeError';
  }
}

/** A migration failed; the store was restored from its pre-migration snapshot. */
export class StoreMigrationError extends Error {
  constructor(
    readonly storeName: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    readonly snapshotPath: string | null,
    readonly restored: boolean,
    cause: unknown,
  ) {
    super(
      `${storeName} migration v${fromVersion} -> v${toVersion} failed: ${cause instanceof Error ? cause.message : String(cause)}. `
      + (restored && snapshotPath
        ? `The store was restored from its pre-migration snapshot (${snapshotPath}); no data was lost.`
        : snapshotPath
          ? `A pre-migration snapshot exists at ${snapshotPath} but automatic restore also failed — restore it manually.`
          : 'No pre-migration snapshot was available (the store had no on-disk file before this open).'),
    );
    this.name = 'StoreMigrationError';
    this.cause = cause;
  }
}

export interface OpenVersionedSchemaOptions {
  /** Human store name for honest messages ("memory store", "code index"). */
  readonly storeName: string;
  /** On-disk path for messages/snapshots; '' or ':memory:' skips snapshots. */
  readonly dbPath: string;
  readonly handle: VersionedSqliteHandle;
  readonly targetVersion: number;
  /** Ascending by toVersion; must reach exactly targetVersion. */
  readonly migrations: readonly StoreMigration[];
  /** Take a snapshot of the store file; returns its path or null when there is nothing to snapshot. */
  readonly snapshot?: ((reason: string) => string | null) | undefined;
  /** Restore the store file from a snapshot (the caller closes/reopens handles around it). */
  readonly restore?: ((snapshotPath: string) => void) | undefined;
}

export interface OpenVersionedSchemaResult {
  /** The version the store had before this open (equals target when current). */
  readonly fromVersion: number;
  /** Migrations that ran (empty when the store was already current). */
  readonly applied: readonly number[];
  /** Pre-migration snapshot path when one was taken. */
  readonly snapshotPath: string | null;
}

/**
 * The version contract for a bun:sqlite store, with snapshot/restore wired
 * to the store's on-disk file: pre-migration snapshot, auto-restore (the
 * live handle is closed first via `closeDb`), downgrade guard. In-memory
 * stores version without snapshots.
 */
export function openVersionedBunSqliteStore(input: {
  storeName: string;
  dbPath: string;
  db: { query(sql: string): { get(): unknown }; run(sql: string): unknown };
  targetVersion: number;
  migrations: readonly StoreMigration[];
  /** Close (and null out) the live handle before a restore rewrites the file. */
  closeDb: () => void;
}): OpenVersionedSchemaResult {
  const persistent = input.dbPath !== ':memory:' && input.dbPath.length > 0;
  return openVersionedSchema({
    storeName: input.storeName,
    dbPath: input.dbPath,
    handle: bunSqliteVersionHandle(input.db),
    targetVersion: input.targetVersion,
    migrations: input.migrations,
    snapshot: persistent ? (reason) => snapshotStoreFile(input.dbPath, reason) : undefined,
    restore: persistent
      ? (snapshotPath) => {
          input.closeDb();
          restoreStoreSnapshot(input.dbPath, snapshotPath);
        }
      : undefined,
  });
}

/**
 * Enforce the schema-version contract on an opened store: no-op when
 * current, migrate forward with a pre-migration snapshot, refuse downgrade,
 * auto-restore on migration failure.
 */
export function openVersionedSchema(options: OpenVersionedSchemaOptions): OpenVersionedSchemaResult {
  const current = options.handle.getUserVersion();
  if (current === options.targetVersion) {
    return { fromVersion: current, applied: [], snapshotPath: null };
  }
  if (current > options.targetVersion) {
    throw new StoreSchemaDowngradeError(options.storeName, options.dbPath, current, options.targetVersion);
  }

  const pending = [...options.migrations]
    .filter((migration) => migration.toVersion > current && migration.toVersion <= options.targetVersion)
    .sort((a, b) => a.toVersion - b.toVersion);
  const last = pending[pending.length - 1];
  if (!last || last.toVersion !== options.targetVersion) {
    throw new Error(
      `${options.storeName}: no migration path from schema v${current} to v${options.targetVersion} — this is a defect in the store's migration list`,
    );
  }

  // Automatic snapshot BEFORE any migration touches the store.
  const snapshotPath = options.snapshot ? options.snapshot(`pre-migration-v${current}-to-v${options.targetVersion}`) : null;

  const applied: number[] = [];
  let reached = current;
  for (const migration of pending) {
    try {
      migration.migrate();
      options.handle.setUserVersion(migration.toVersion);
      reached = migration.toVersion;
      applied.push(migration.toVersion);
    } catch (cause) {
      let restored = false;
      if (snapshotPath && options.restore) {
        try {
          options.restore(snapshotPath);
          restored = true;
        } catch {
          restored = false;
        }
      }
      throw new StoreMigrationError(options.storeName, reached, migration.toVersion, snapshotPath, restored, cause);
    }
  }
  return { fromVersion: current, applied, snapshotPath };
}
