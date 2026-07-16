/**
 * Data safety with no discipline: every SQLite store the platform writes
 * carries PRAGMA user_version; migrations snapshot first and auto-restore
 * on failure; an older binary refuses a newer schema; restore is one
 * command; daily snapshots stay bounded through the retention engine.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bunSqliteVersionHandle,
  openVersionedSchema,
  StoreMigrationError,
  StoreSchemaDowngradeError,
} from '../packages/sdk/src/platform/state/store-versioning.js';
import {
  listStoreSnapshots,
  restoreStoreSnapshot,
  snapshotStoreFile,
  snapshotStoreFileAsync,
  StoreSnapshotScheduler,
  storeSnapshotDir,
} from '../packages/sdk/src/platform/state/store-snapshots.js';
import { RetentionPolicy } from '../packages/sdk/src/platform/runtime/retention/policy.js';
import { SnapshotPruner } from '../packages/sdk/src/platform/runtime/retention/pruner.js';
import { CodeIndexStore } from '../packages/sdk/src/platform/state/code-index-store.js';
import { SqliteVecMemoryIndex, resolveMemoryVectorDbPath } from '../packages/sdk/src/platform/state/memory-vector-store.js';
import { MemoryEmbeddingProviderRegistry } from '../packages/sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { SQLiteStore } from '../packages/sdk/src/platform/state/sqlite-store.js';
import { createSchema as createMemorySchema } from '../packages/sdk/src/platform/state/memory-store-helpers.js';

async function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'store-safety-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

describe('every store the platform writes carries PRAGMA user_version', () => {
  test('code index store stamps its schema version at open', () => withScratch((dir) => {
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const dbPath = join(dir, 'code-index.sqlite');
    const store = new CodeIndexStore(dir, dbPath, registry);
    store.init();
    const status = store.stats();
    store.close();
    expect(status.available).toBe(true);
    expect(readUserVersion(dbPath)).toBe(1);
  }));

  test('memory vector index stamps its schema version at open', () => withScratch((dir) => {
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const dbPath = resolveMemoryVectorDbPath(join(dir, 'memory.sqlite'));
    const index = new SqliteVecMemoryIndex(dbPath, undefined, registry);
    index.init();
    index.close();
    expect(readUserVersion(dbPath)).toBe(1);
  }));

  test('memory store (sql.js) stamps and persists its schema version', async () => withScratch(async (dir) => {
    const dbPath = join(dir, 'memory.sqlite');
    const store = new SQLiteStore(dbPath);
    await store.init(createMemorySchema as Parameters<SQLiteStore['init']>[0], { storeName: 'memory store', schemaVersion: 1 });
    // A brand-new store touches disk on first save (the long-standing
    // contract); the stamped version rides along in that export.
    await store.save();
    store.close();
    expect(readUserVersion(dbPath)).toBe(1);

    // Reopen: already-current stores migrate nothing and stay at version 1.
    const reopened = new SQLiteStore(dbPath);
    await reopened.init(createMemorySchema as Parameters<SQLiteStore['init']>[0], { storeName: 'memory store', schemaVersion: 1 });
    reopened.close();
    expect(readUserVersion(dbPath)).toBe(1);
  }));
});

describe('downgrade guard: an older binary refuses a newer schema honestly', () => {
  test('openVersionedSchema throws a named error and touches nothing', () => withScratch((dir) => {
    const dbPath = join(dir, 'future.sqlite');
    const db = new Database(dbPath);
    db.run('CREATE TABLE t (v TEXT)');
    db.run("INSERT INTO t VALUES ('data')");
    db.run('PRAGMA user_version = 7');
    expect(() => openVersionedSchema({
      storeName: 'future store',
      dbPath,
      handle: bunSqliteVersionHandle(db),
      targetVersion: 1,
      migrations: [{ toVersion: 1, migrate: () => {} }],
    })).toThrow(StoreSchemaDowngradeError);
    try {
      openVersionedSchema({
        storeName: 'future store',
        dbPath,
        handle: bunSqliteVersionHandle(db),
        targetVersion: 1,
        migrations: [{ toVersion: 1, migrate: () => {} }],
      });
    } catch (error) {
      expect(String(error)).toContain('uses schema v7');
      expect(String(error)).toContain('only understands up to v1');
      expect(String(error)).toContain('written by a newer version');
    }
    expect((db.query('SELECT v FROM t').get() as { v: string }).v).toBe('data');
    db.close();
  }));

  test('the code index store surfaces the downgrade refusal as an honest unavailable state', () => withScratch((dir) => {
    const dbPath = join(dir, 'code-index.sqlite');
    const seeded = new Database(dbPath);
    seeded.run('PRAGMA user_version = 9');
    seeded.close();

    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const store = new CodeIndexStore(dir, dbPath, registry);
    store.init();
    const status = store.stats();
    store.close();
    expect(status.available).toBe(false);
    expect(status.error ?? '').toContain('written by a newer version');
    // The newer store was refused, not rewritten.
    expect(readUserVersion(dbPath)).toBe(9);
  }));
});

describe('seeded failed migration auto-restores from its pre-migration snapshot', () => {
  test('the store file returns to its pre-migration bytes and the error says so', () => withScratch((dir) => {
    const dbPath = join(dir, 'store.sqlite');
    let db = new Database(dbPath);
    db.run('CREATE TABLE t (v TEXT)');
    db.run("INSERT INTO t VALUES ('v1-data')");
    db.run('PRAGMA user_version = 1');
    db.close();
    const preMigrationBytes = readFileSync(dbPath);

    db = new Database(dbPath);
    let caught: unknown;
    try {
      openVersionedSchema({
        storeName: 'seeded store',
        dbPath,
        handle: bunSqliteVersionHandle(db),
        targetVersion: 2,
        migrations: [{
          toVersion: 2,
          migrate: () => {
            // Half-applied damage, then failure.
            db.run("INSERT INTO t VALUES ('halfway')");
            throw new Error('seeded migration failure');
          },
        }],
        snapshot: (reason) => snapshotStoreFile(dbPath, reason),
        restore: (snapshotPath) => {
          db.close();
          restoreStoreSnapshot(dbPath, snapshotPath);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StoreMigrationError);
    const migrationError = caught as StoreMigrationError;
    expect(migrationError.restored).toBe(true);
    expect(migrationError.snapshotPath).not.toBeNull();
    expect(migrationError.message).toContain('seeded migration failure');
    expect(migrationError.message).toContain('restored from its pre-migration snapshot');
    expect(migrationError.message).toContain('no data was lost');

    // The store file is byte-identical to its pre-migration state.
    expect(readFileSync(dbPath).equals(preMigrationBytes)).toBe(true);
    expect(readUserVersion(dbPath)).toBe(1);
    const restored = new Database(dbPath, { readonly: true });
    expect(restored.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
    restored.close();
  }));
});

describe('restore is one command', () => {
  test('restoreStoreSnapshot picks the latest snapshot and parks the replaced file', () => withScratch((dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'good-state');
    const snapshotPath = snapshotStoreFile(dbPath, 'daily');
    expect(snapshotPath).not.toBeNull();
    writeFileSync(dbPath, 'corrupted-state');

    const result = restoreStoreSnapshot(dbPath);
    expect(result.restoredFrom).toBe(snapshotPath!);
    expect(readFileSync(dbPath, 'utf-8')).toBe('good-state');
    expect(readFileSync(`${dbPath}.pre-restore`, 'utf-8')).toBe('corrupted-state');
  }));

  test('restoring with no snapshots fails honestly', () => withScratch((dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'x');
    expect(() => restoreStoreSnapshot(dbPath)).toThrow(/no snapshots exist/);
  }));
});

// The memory-governor tripwire exit runs its store snapshots through the ASYNC
// twin so a stalled disk cannot block the event loop (which would defeat the
// governor's 10s shutdown ceiling). These pin that the async path produces the
// same snapshot the sync path does, including WAL/SHM sidecars.
describe('tripwire-path async snapshots (slice 4c)', () => {
  test('snapshotStoreFileAsync writes the store plus its -wal/-shm sidecars, mtime-stamped', async () => withScratch(async (dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'live-state');
    writeFileSync(`${dbPath}-wal`, 'wal-bytes');
    writeFileSync(`${dbPath}-shm`, 'shm-bytes');
    const at = Date.now() - 5000;
    const snapshotPath = await snapshotStoreFileAsync(dbPath, 'tripwire', { now: () => at });
    expect(snapshotPath).not.toBeNull();
    expect(readFileSync(snapshotPath!, 'utf-8')).toBe('live-state');
    expect(readFileSync(`${snapshotPath!}-wal`, 'utf-8')).toBe('wal-bytes');
    expect(readFileSync(`${snapshotPath!}-shm`, 'utf-8')).toBe('shm-bytes');
    // The snapshot is stamped with the LOGICAL time, matching the sync twin.
    const listed = listStoreSnapshots(dbPath).find((s) => s.reason === 'tripwire');
    expect(listed).toBeDefined();
    expect(Math.abs(listed!.createdAt - at)).toBeLessThan(1000);
  }));

  test('snapshotStoreFileAsync skips a non-existent or empty store (best-effort)', async () => withScratch(async (dir) => {
    expect(await snapshotStoreFileAsync(join(dir, 'missing.sqlite'), 'tripwire')).toBeNull();
    const empty = join(dir, 'empty.sqlite');
    writeFileSync(empty, '');
    expect(await snapshotStoreFileAsync(empty, 'tripwire')).toBeNull();
  }));

  test('scheduler.snapshotAllAsync snapshots every registered store and does not throw on a bad one', async () => withScratch(async (dir) => {
    const good = join(dir, 'good.sqlite');
    writeFileSync(good, 'good-bytes');
    const missing = join(dir, 'missing.sqlite'); // never created — must not throw
    const scheduler = new StoreSnapshotScheduler({
      stores: [{ name: 'good', dbPath: good }, { name: 'missing', dbPath: missing }],
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    await scheduler.snapshotAllAsync('tripwire');
    expect(listStoreSnapshots(good).filter((s) => s.reason === 'tripwire')).toHaveLength(1);
    expect(listStoreSnapshots(missing)).toHaveLength(0);
    scheduler.stop();
  }));
});

describe('daily snapshots with bounded retention', () => {
  test('the scheduler snapshots once per day per store', async () => withScratch(async (dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'state-bytes');
    const scheduler = new StoreSnapshotScheduler({
      stores: [{ name: 'store', dbPath }],
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(1);

    // Same day: no second snapshot.
    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(1);

    // Backdate the existing snapshot a day: the next sweep takes a fresh one.
    const existing = listStoreSnapshots(dbPath)[0]!;
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(existing.path, dayAgo, dayAgo);
    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(2);
    scheduler.stop();
  }));

  test('dedup runs on the LOGICAL clock: injected same-day times never double-snapshot, a logical day later does', async () => withScratch(async (dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'state-bytes');
    // An injected clock deliberately NOT the wall clock, anchored early on
    // the SAME real calendar day (the consumer's failing scenario): the
    // snapshot's mtime is stamped with the LOGICAL creation time, so the
    // day-boundary comparison sees the injected clock, never the real
    // filesystem time. (Kept near today so the default retention policy —
    // which runs on the real clock — never prunes the fresh snapshot.)
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 30, 0, 0);
    let logicalNow = startOfToday.getTime();
    const scheduler = new StoreSnapshotScheduler({
      stores: [{ name: 'store', dbPath }],
      now: () => logicalNow,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(1);
    // The persisted createdAt IS the logical time (stamped, not wall-clock).
    expect(Math.abs(listStoreSnapshots(dbPath)[0]!.createdAt - logicalNow)).toBeLessThan(1000);

    // Same logical day, hours later: no second snapshot.
    logicalNow += 6 * 60 * 60 * 1000;
    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(1);

    // A full logical day later: the sweep takes a fresh one.
    logicalNow += 24 * 60 * 60 * 1000;
    await scheduler.tick();
    expect(listStoreSnapshots(dbPath).filter((s) => s.reason === 'daily')).toHaveLength(2);
    scheduler.stop();
  }));

  test('retention stays bounded: old daily snapshots are pruned from disk', async () => withScratch(async (dir) => {
    const dbPath = join(dir, 'store.sqlite');
    writeFileSync(dbPath, 'state-bytes');
    // Seed eight daily snapshots with staggered ages.
    for (let i = 0; i < 8; i++) {
      const path = snapshotStoreFile(dbPath, 'daily', { now: () => Date.now() + i })!;
      const ageSeconds = (Date.now() - (8 - i) * 60 * 60 * 1000) / 1000;
      utimesSync(path, ageSeconds, ageSeconds);
    }
    expect(listStoreSnapshots(dbPath)).toHaveLength(8);

    const scheduler = new StoreSnapshotScheduler({
      stores: [{ name: 'store', dbPath }],
      retention: new RetentionPolicy(
        { standard: { maxAgeMs: 14 * 24 * 60 * 60 * 1000, maxCount: 3, maxSizeBytes: 512 * 1024 * 1024 } },
        Date.now,
        new SnapshotPruner(),
      ),
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    await scheduler.pruneRegisteredSnapshots();
    const remaining = listStoreSnapshots(dbPath);
    expect(remaining).toHaveLength(3);
    // The newest three survived.
    const survivors = remaining.map((s) => s.createdAt).sort((a, b) => a - b);
    expect(survivors[0]!).toBeGreaterThan(Date.now() - 4 * 60 * 60 * 1000);
    expect(existsSync(storeSnapshotDir(dbPath))).toBe(true);
    scheduler.stop();
  }));
});
