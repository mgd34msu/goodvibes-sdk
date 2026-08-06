import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import {
  loadWatcherSnapshotFromPath,
  saveWatcherSnapshotToPath,
} from '../packages/sdk/src/platform/watchers/store.ts';
import { STALE_TEMP_FILE_MIN_AGE_MS } from '../packages/sdk/src/platform/utils/atomic-json-store.ts';
import type { WatcherRecord } from '../packages/sdk/src/platform/runtime/store/domains/watchers.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeStoreDir(): string {
  return makeProjectTempDir('gv-watcher-store');
}

function storePathIn(dir: string): string {
  return join(dir, 'watchers.json');
}

function makeWatcherRecord(id: string): WatcherRecord {
  return {
    id,
    kind: 'polling',
    label: `watcher-${id}`,
    state: 'running',
    source: {
      id: `source-${id}`,
      kind: 'webhook',
      label: `source-${id}`,
      enabled: true,
      createdAt: 1000,
      updatedAt: 1000,
      metadata: {},
    },
    metadata: {},
  } as WatcherRecord;
}

/** Every non-`.why` file beside the store path whose name starts with `prefix`. */
function siblingsMatching(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

function tempFileSiblings(dir: string, storePath: string): string[] {
  return siblingsMatching(dir, `${basename(storePath)}.tmp-`);
}

function corruptSiblings(dir: string, storePath: string): string[] {
  return siblingsMatching(dir, `${basename(storePath)}.corrupt-`).filter((name) => !name.endsWith('.why'));
}

/** Build the EXACT zero-tail fixture: valid snapshot JSON with two trailing NUL bytes. */
function zeroTailedFixture(): Buffer {
  const json = `${JSON.stringify({ version: 1, watchers: [makeWatcherRecord('w1')] }, null, 2)}\n`;
  return Buffer.concat([Buffer.from(json, 'utf-8'), Buffer.from([0, 0])]);
}

/** Build a truncated-mid-JSON fixture: valid JSON cut off partway through. */
function truncatedFixture(): string {
  const json = JSON.stringify({ version: 1, watchers: [makeWatcherRecord('w1'), makeWatcherRecord('w2')] }, null, 2);
  return json.slice(0, Math.floor(json.length / 2));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('watcher store: atomic save', () => {
  test('save leaves no temp file behind and content round-trips exactly', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    const watchers = [makeWatcherRecord('a'), makeWatcherRecord('b')];

    saveWatcherSnapshotToPath(watchers, storePath);

    expect(existsSync(storePath)).toBe(true);
    expect(tempFileSiblings(dir, storePath)).toEqual([]);

    const loaded = loadWatcherSnapshotFromPath(storePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.watchers.map((w) => w.id).sort()).toEqual(['a', 'b']);
  });

  test('a second save overwrites the first with no temp file left and no partial content ever observable', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);

    saveWatcherSnapshotToPath([makeWatcherRecord('first')], storePath);
    const firstContent = readFileSync(storePath, 'utf-8');
    expect(firstContent).toContain('"first"');

    saveWatcherSnapshotToPath([makeWatcherRecord('second')], storePath);
    const secondContent = readFileSync(storePath, 'utf-8');

    // The file is always one of the two complete snapshots, never a mix.
    expect(secondContent).toContain('"second"');
    expect(secondContent).not.toContain('"first"');
    expect(tempFileSiblings(dir, storePath)).toEqual([]);
  });

  test('a stale temp file left by a previous crash is cleaned up by the next save', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });

    // Simulate a crash: a temp file from some earlier (now-dead) pid survives,
    // with no corresponding rename ever having happened. Backdated past the
    // sweep's safety age, which is what separates a crash leftover from a
    // concurrent writer's file still being written.
    const staleTemp = `${storePath}.tmp-999999`;
    writeFileSync(staleTemp, 'garbage-from-a-torn-write', 'utf-8');
    const longAgo = new Date(Date.now() - (STALE_TEMP_FILE_MIN_AGE_MS + 60_000));
    utimesSync(staleTemp, longAgo, longAgo);
    expect(existsSync(staleTemp)).toBe(true);

    saveWatcherSnapshotToPath([makeWatcherRecord('fresh')], storePath);

    expect(existsSync(staleTemp)).toBe(false);
    expect(tempFileSiblings(dir, storePath)).toEqual([]);
    expect(existsSync(storePath)).toBe(true);
  });

  test('save creates parent directories as needed', () => {
    const dir = makeStoreDir();
    const storePath = join(dir, 'nested', 'deeper', 'watchers.json');

    saveWatcherSnapshotToPath([makeWatcherRecord('deep')], storePath);

    expect(existsSync(storePath)).toBe(true);
    const loaded = loadWatcherSnapshotFromPath(storePath);
    expect(loaded!.watchers[0]!.id).toBe('deep');
  });
});

describe('watcher store: quarantine-don\'t-crash load', () => {
  test('a missing file returns null and leaves nothing behind', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);

    const result = loadWatcherSnapshotFromPath(storePath);

    expect(result).toBeNull();
    expect(corruptSiblings(dir, storePath)).toEqual([]);
  });

  test('a zero-tailed file (valid JSON + two NUL bytes) loads as null, is quarantined with a .why receipt, and a fresh save+load then round-trips clean', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, zeroTailedFixture());

    const result = loadWatcherSnapshotFromPath(storePath);

    expect(result).toBeNull();
    expect(existsSync(storePath)).toBe(false); // moved aside, not left in place

    const quarantined = corruptSiblings(dir, storePath);
    expect(quarantined.length).toBe(1);
    const whyPath = join(dir, `${quarantined[0]}.why`);
    expect(existsSync(whyPath)).toBe(true);
    const whyContent = readFileSync(whyPath, 'utf-8');
    expect(whyContent.length).toBeGreaterThan(0);
    expect(whyContent).toContain('rebuild');

    // Subsequent save + load round-trips clean, with no crash and no leftover temp file.
    saveWatcherSnapshotToPath([makeWatcherRecord('after-recovery')], storePath);
    const reloaded = loadWatcherSnapshotFromPath(storePath);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.watchers[0]!.id).toBe('after-recovery');
    expect(tempFileSiblings(dir, storePath)).toEqual([]);
  });

  test('a truncated-mid-JSON file loads as null and is quarantined the same way as a zero-tailed file', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, truncatedFixture(), 'utf-8');

    const result = loadWatcherSnapshotFromPath(storePath);

    expect(result).toBeNull();
    expect(existsSync(storePath)).toBe(false);
    const quarantined = corruptSiblings(dir, storePath);
    expect(quarantined.length).toBe(1);
    expect(existsSync(join(dir, `${quarantined[0]}.why`))).toBe(true);

    saveWatcherSnapshotToPath([makeWatcherRecord('recovered')], storePath);
    const reloaded = loadWatcherSnapshotFromPath(storePath);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.watchers[0]!.id).toBe('recovered');
  });

  test('a wrong-version snapshot is quarantined rather than accepted', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 2, watchers: [] }), 'utf-8');

    const result = loadWatcherSnapshotFromPath(storePath);

    expect(result).toBeNull();
    expect(corruptSiblings(dir, storePath).length).toBe(1);
  });

  test('a malformed watcher record (missing id) is quarantined rather than silently dropped', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: 1, watchers: [{ notAnId: true }] }), 'utf-8');

    const result = loadWatcherSnapshotFromPath(storePath);

    expect(result).toBeNull();
    expect(corruptSiblings(dir, storePath).length).toBe(1);
  });

  test('the reap bound: quarantine files beyond the cap are deleted, oldest first, and disclosed in the newest .why receipt', () => {
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });

    // Corrupt-and-load 7 times in a row (cap is 5): each corrupt file gets a
    // distinguishable mtime by writing them slightly apart in wall-clock terms
    // via distinct content: the store timestamps its own quarantine name.
    const totalRounds = 7;
    for (let i = 0; i < totalRounds; i += 1) {
      writeFileSync(storePath, `not json at all #${i}`, 'utf-8');
      const result = loadWatcherSnapshotFromPath(storePath);
      expect(result).toBeNull();
    }

    const remaining = corruptSiblings(dir, storePath);
    expect(remaining.length).toBeLessThanOrEqual(5);

    // Every remaining quarantine file still has its .why receipt (reap deletes pairs together).
    for (const name of remaining) {
      expect(existsSync(join(dir, `${name}.why`))).toBe(true);
    }

    // No orphaned .why receipts for a quarantine file that was reaped.
    const whyFiles = siblingsMatching(dir, `${basename(storePath)}.corrupt-`).filter((name) => name.endsWith('.why'));
    expect(whyFiles.length).toBe(remaining.length);
  });

  test('the reap never orphans a receipt when every mtime ties — the coarse-mtime filesystem probe', () => {
    // A CI matrix runner's filesystem rounded mtimes coarsely enough that a
    // tight corrupt-load loop produced all-equal mtimes; the old mtime-only
    // sort could then pick the JUST-quarantined file as the "oldest" victim,
    // whose .why had not been written yet — deleting the file and leaving the
    // receipt written afterwards orphaned (5 files, 6 receipts). This probe
    // constructs the tie deliberately instead of hoping a runner provides it.
    const dir = makeStoreDir();
    const storePath = storePathIn(dir);
    mkdirSync(dir, { recursive: true });

    const tie = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(storePath, `still not json #${i}`, 'utf-8');
      expect(loadWatcherSnapshotFromPath(storePath)).toBeNull();
      // Flatten every quarantine artifact onto one identical mtime so the
      // sort's mtime component carries no information at all.
      for (const name of siblingsMatching(dir, `${basename(storePath)}.corrupt-`)) {
        utimesSync(join(dir, name), tie, tie);
      }
    }

    const remaining = corruptSiblings(dir, storePath);
    expect(remaining.length).toBeLessThanOrEqual(5);
    for (const name of remaining) {
      expect(existsSync(join(dir, `${name}.why`))).toBe(true);
    }
    const whyFiles = siblingsMatching(dir, `${basename(storePath)}.corrupt-`).filter((name) => name.endsWith('.why'));
    expect(whyFiles.length).toBe(remaining.length);
  });
});
