/**
 * Store snapshots: point-in-time copies of the SQLite files the platform
 * writes, kept beside each store under `snapshots/<db-file-name>/`.
 *
 * Three jobs:
 * - `snapshotStoreFile` — one verified copy (plus -wal/-shm sidecars when
 *   present), used automatically before schema migrations and by the daily
 *   scheduler;
 * - `restoreStoreSnapshot` — ONE command back to a snapshot: parks the
 *   current file at `<path>.pre-restore`, then copies the snapshot into
 *   place (latest snapshot when none is named);
 * - `StoreSnapshotScheduler` — a daily snapshot of every registered store
 *   with bounded retention through the existing retention engine
 *   (RetentionPolicy + SnapshotPruner deleting real files).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { RetentionPolicy } from '../runtime/retention/policy.js';
import { SnapshotPruner } from '../runtime/retention/pruner.js';
import type { RetentionClass } from '../runtime/retention/types.js';

export const STORE_SNAPSHOT_DIR = 'snapshots';
const SNAPSHOT_SUFFIX = '.snapshot';
const DAY_MS = 24 * 60 * 60 * 1000;

function isRealDbPath(dbPath: string): boolean {
  return dbPath.length > 0 && dbPath !== ':memory:';
}

/** Directory a store's snapshots live in: `<db dir>/snapshots/<db file name>/`. */
export function storeSnapshotDir(dbPath: string): string {
  return join(dirname(dbPath), STORE_SNAPSHOT_DIR, basename(dbPath));
}

function timestampSlug(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy the store file (and any -wal/-shm sidecars) into the snapshot dir.
 * Returns the snapshot path, or null when there is nothing to snapshot
 * (in-memory store, missing file, or empty file).
 */
export function snapshotStoreFile(
  dbPath: string,
  reason: string,
  options: { now?: () => number } = {},
): string | null {
  if (!isRealDbPath(dbPath) || !existsSync(dbPath)) return null;
  if (statSync(dbPath).size === 0) return null;
  const at = (options.now ?? Date.now)();
  const dir = storeSnapshotDir(dbPath);
  mkdirSync(dir, { recursive: true });
  // Timestamp slugs are millisecond-granular: two snapshots requested within
  // the same millisecond (fast successive sweeps on tmpfs) must not silently
  // overwrite each other — uniquify instead of clobbering.
  let snapshotPath = join(dir, `${timestampSlug(at)}.${reason}${SNAPSHOT_SUFFIX}`);
  for (let counter = 1; existsSync(snapshotPath); counter += 1) {
    snapshotPath = join(dir, `${timestampSlug(at)}-${counter}.${reason}${SNAPSHOT_SUFFIX}`);
  }
  copyFileSync(dbPath, snapshotPath);
  for (const sidecar of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${sidecar}`)) {
      copyFileSync(`${dbPath}${sidecar}`, `${snapshotPath}${sidecar}`);
    }
  }
  logger.info('store snapshot written', { store: basename(dbPath), reason, snapshotPath });
  return snapshotPath;
}

export interface StoreSnapshotInfo {
  readonly path: string;
  readonly createdAt: number;
  readonly sizeBytes: number;
  readonly reason: string;
}

/** All snapshots for a store, newest first. */
export function listStoreSnapshots(dbPath: string): StoreSnapshotInfo[] {
  if (!isRealDbPath(dbPath)) return [];
  const dir = storeSnapshotDir(dbPath);
  if (!existsSync(dir)) return [];
  const entries: StoreSnapshotInfo[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    const reasonMatch = name.match(/\.([^.]+)\.snapshot$/);
    entries.push({
      path,
      createdAt: stat.mtimeMs,
      sizeBytes: stat.size,
      reason: reasonMatch?.[1] ?? 'unknown',
    });
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export interface RestoreStoreSnapshotResult {
  readonly restoredFrom: string;
  /** Where the replaced live file was parked (null when none existed). */
  readonly keptCurrentAt: string | null;
}

/**
 * ONE command back to a snapshot. The store must be closed by the caller.
 * With no snapshot named, the latest one is used; the replaced live file is
 * parked at `<path>.pre-restore` so even a wrong restore loses nothing.
 */
export function restoreStoreSnapshot(dbPath: string, snapshotPath?: string): RestoreStoreSnapshotResult {
  if (!isRealDbPath(dbPath)) {
    throw new Error(`cannot restore an in-memory store (${dbPath || 'empty path'})`);
  }
  const source = snapshotPath ?? listStoreSnapshots(dbPath)[0]?.path;
  if (!source) {
    throw new Error(`no snapshots exist for ${dbPath} under ${storeSnapshotDir(dbPath)} — nothing to restore`);
  }
  if (!existsSync(source)) {
    throw new Error(`snapshot not found: ${source}`);
  }
  let keptCurrentAt: string | null = null;
  if (existsSync(dbPath)) {
    keptCurrentAt = `${dbPath}.pre-restore`;
    copyFileSync(dbPath, keptCurrentAt);
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(source, dbPath);
  logger.info('store restored from snapshot', { store: basename(dbPath), restoredFrom: source, keptCurrentAt });
  return { restoredFrom: source, keptCurrentAt };
}

export interface SnapshotStoreTarget {
  readonly name: string;
  readonly dbPath: string;
}

export interface StoreSnapshotSchedulerOptions {
  readonly stores: readonly SnapshotStoreTarget[];
  /** Daily-snapshot retention class limits; bounded by default. */
  readonly retention?: RetentionPolicy | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** How often the scheduler wakes to check due-ness (hourly by default). */
  readonly checkIntervalMs?: number | undefined;
}

const DAILY_RETENTION_CLASS: RetentionClass = 'standard';
const PRE_MIGRATION_RETENTION_CLASS: RetentionClass = 'forensic';

/** Bounded defaults for store snapshots: 14 daily copies / 30 forensic days. */
export function defaultStoreSnapshotRetention(): RetentionPolicy {
  return new RetentionPolicy(
    {
      standard: { maxAgeMs: 14 * DAY_MS, maxCount: 14, maxSizeBytes: 512 * 1024 * 1024 },
      forensic: { maxAgeMs: 30 * DAY_MS, maxCount: 30, maxSizeBytes: 1024 * 1024 * 1024 },
    },
    undefined,
    new SnapshotPruner(),
  );
}

/**
 * Daily snapshots of every registered store, with bounded retention driven
 * through the retention engine after every sweep. Time and timers are
 * injectable; the loop never keeps the process alive.
 */
export class StoreSnapshotScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly retention: RetentionPolicy;

  constructor(private readonly options: StoreSnapshotSchedulerOptions) {
    this.retention = options.retention ?? defaultStoreSnapshotRetention();
  }

  private get checkIntervalMs(): number {
    return this.options.checkIntervalMs ?? 60 * 60 * 1000;
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      void this.tick();
    }, this.checkIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** One sweep: snapshot stores whose newest daily copy is a day old, then prune. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const now = (this.options.now ?? Date.now)();
      for (const store of this.options.stores) {
        try {
          const newestDaily = listStoreSnapshots(store.dbPath).find((snapshot) => snapshot.reason === 'daily');
          if (!newestDaily || now - newestDaily.createdAt >= DAY_MS) {
            snapshotStoreFile(store.dbPath, 'daily', { now: () => now });
          }
        } catch (error) {
          logger.warn('daily store snapshot failed', { store: store.name, error: summarizeError(error) });
        }
      }
      await this.pruneRegisteredSnapshots();
    } finally {
      this.scheduleNext();
    }
  }

  /** Register every snapshot on disk with the retention engine, then prune. */
  async pruneRegisteredSnapshots(): Promise<void> {
    for (const store of this.options.stores) {
      for (const snapshot of listStoreSnapshots(store.dbPath)) {
        this.retention.register({
          id: snapshot.path,
          createdAt: snapshot.createdAt,
          sizeBytes: snapshot.sizeBytes,
          retentionClass: snapshot.reason === 'daily' ? DAILY_RETENTION_CLASS : PRE_MIGRATION_RETENTION_CLASS,
          path: snapshot.path,
        });
      }
    }
    try {
      const result = await this.retention.prune();
      if (result.deletedIds.length > 0) {
        for (const id of result.deletedIds) this.retention.unregister(id);
        logger.info('store snapshot retention pruned', { deleted: result.deletedIds.length, reclaimedBytes: result.reclaimedBytes });
      }
    } catch (error) {
      logger.warn('store snapshot retention prune failed', { error: summarizeError(error) });
    }
  }
}
