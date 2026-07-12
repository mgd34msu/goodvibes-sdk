import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { openVersionedSchema, sqlJsVersionHandle } from './store-versioning.js';
import { restoreStoreSnapshot, snapshotStoreFile } from './store-snapshots.js';

export interface SqlDatabase {
  run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: Uint8Array | Buffer) => SqlDatabase;
}

function isEphemeralDbPath(path: string | null | undefined): boolean {
  if (!path) return true;
  if (path === ':memory:') return true;
  return /^file:.*(?:^|[?&])mode=memory(?:&|$)/.test(path);
}

export interface SqliteStoreInitOptions {
  /** Human store name for honest versioning messages. */
  readonly storeName?: string | undefined;
  /** Target `PRAGMA user_version` for this store (default 1). */
  readonly schemaVersion?: number | undefined;
  /**
   * Ordered migrations to the target version. When omitted, the base schema
   * function doubles as the single migration to the target version (safe
   * because every base schema here is IF NOT EXISTS-idempotent).
   */
  readonly migrations?: ReadonlyArray<{
    readonly toVersion: number;
    readonly migrate: (db: SqlDatabase) => void;
  }> | undefined;
}

export class SQLiteStore {
  private db: SqlDatabase | null = null;
  private readonly dbPath: string | null;
  private initPromise: Promise<void> | null = null;
  private saveBatchDepth = 0;
  private saveDirty = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? null;
  }

  get isReady(): boolean {
    return this.db !== null;
  }

  /** The on-disk database path, or null for an ephemeral/in-memory store. */
  get databasePath(): string | null {
    return this.dbPath;
  }

  async init(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions = {}): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(schema, options);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    this.getDb().run(sql, params);
  }

  exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }> {
    return this.getDb().exec(sql, params);
  }

  async batch<T>(operation: () => Promise<T>): Promise<T> {
    this.saveBatchDepth += 1;
    try {
      return await operation();
    } finally {
      this.saveBatchDepth -= 1;
      if (this.saveBatchDepth === 0 && this.saveDirty) {
        this.saveDirty = false;
        await this.save();
      }
    }
  }

  async save(): Promise<boolean> {
    const dbPath = this.dbPath;
    if (isEphemeralDbPath(dbPath) || !this.db || !dbPath) return false;
    if (this.saveBatchDepth > 0) {
      this.saveDirty = true;
      return false;
    }

    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      const data = this.db.export();
      writeFileSync(dbPath, Buffer.from(data));
      logger.debug('SQLiteStore: saved to disk', { path: dbPath });
      return true;
    } catch (err) {
      logger.error('SQLiteStore: failed to save', {
        error: summarizeError(err),
      });
      throw err;
    }
  }

  close(): void {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  private async initialize(schema: (db: SqlDatabase) => void, options: SqliteStoreInitOptions): Promise<void> {
    try {
      const initSqlJs = (await import('sql.js')).default;
      const SQL = await initSqlJs() as SqlJsStatic;
      const dbPath = this.dbPath;
      const persistent = Boolean(dbPath && !isEphemeralDbPath(dbPath));
      const existedOnDisk = persistent && existsSync(dbPath!);

      if (existedOnDisk) {
        this.db = new SQL.Database(readFileSync(dbPath!));
        logger.info('SQLiteStore: loaded from disk', { path: dbPath });
      } else {
        this.db = new SQL.Database();
        logger.info('SQLiteStore: initialized in-memory');
      }

      // Schema versioning: PRAGMA user_version + ordered migrations, with an
      // automatic pre-migration snapshot, auto-restore on failure, and a
      // downgrade guard (an older binary refuses a newer schema honestly).
      const result = openVersionedSchema({
        storeName: options.storeName ?? 'sqlite store',
        dbPath: persistent ? dbPath! : ':memory:',
        handle: sqlJsVersionHandle(this.db),
        targetVersion: options.schemaVersion ?? 1,
        migrations: options.migrations?.map((migration) => ({
          toVersion: migration.toVersion,
          migrate: () => migration.migrate(this.getDb()),
        })) ?? [{ toVersion: options.schemaVersion ?? 1, migrate: () => schema(this.getDb()) }],
        snapshot: persistent ? (reason) => snapshotStoreFile(dbPath!, reason) : undefined,
        restore: persistent
          ? (snapshotPath) => {
              restoreStoreSnapshot(dbPath!, snapshotPath);
              this.db = new SQL.Database(readFileSync(dbPath!));
            }
          : undefined,
      });
      // The base schema always runs (it is IF NOT EXISTS-idempotent) so a
      // store already at the target version still gets any session tables.
      schema(this.getDb());
      // Persist a freshly-stamped version so the next open skips migration —
      // but only for a store that already lived on disk: a brand-new store
      // keeps the long-standing contract of touching disk on first save().
      if (result.applied.length > 0 && existedOnDisk) {
        await this.save();
      }
    } catch (err) {
      this.db = null;
      logger.error('SQLiteStore: failed to initialize', {
        error: summarizeError(err),
      });
      throw err;
    }
  }

  private getDb(): SqlDatabase {
    if (!this.db) {
      throw new Error('SQLiteStore: not initialized — call init() first');
    }
    return this.db;
  }
}
