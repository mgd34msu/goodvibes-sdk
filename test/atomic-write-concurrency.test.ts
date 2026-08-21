/**
 * atomic-write-concurrency.test.ts, the crash that killed a running agent
 * process, reproduced and then held shut.
 *
 * The observed failure, from the live machine:
 *
 *   error: ENOENT: no such file or directory,
 *   chmod '/home/…/.goodvibes/agent/watchers.json.tmp-905081'
 *     at writeFileAtomic → writeJsonFileAtomic → saveWatcherSnapshotToPath
 *     → persist → list → assemble → query → tick
 *
 * `.tmp-905081` is a process id. Naming the temp file after the process rather
 * than after the write, and then sweeping every `<name>.tmp-*` found beside the
 * target as "a leftover from a previous crash", left two ways for one writer to
 * destroy another's work in progress on the same store:
 *
 *   - Same process, same store, no unique suffix → both writers use one path,
 *     so A's rename carries the temp file away and B's chmod finds nothing (or,
 *     worse, B's rename publishes A's bytes under B's write).
 *   - Different processes → different names, but the sweep deletes by prefix,
 *     so B's sweep unlinks A's live temp file and A's chmod finds nothing.
 *
 * Both end at the same syscall on the same missing path. The fixes are a temp
 * name unique per write and a sweep that only reaps temp files older than
 * STALE_TEMP_FILE_MIN_AGE_MS, and the tests below pin each one.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import {
  createAtomicTempPath,
  STALE_TEMP_FILE_MIN_AGE_MS,
  writeJsonFileAtomic,
  writeJsonFileAtomicSafe,
} from '../packages/sdk/src/platform/utils/atomic-json-store.ts';

const STORE_MODULE = resolve(import.meta.dir, '../packages/sdk/src/platform/utils/atomic-json-store.ts');

function tempFiles(dir: string, storePath: string): string[] {
  const prefix = `${basename(storePath)}.tmp-`;
  return readdirSync(dir).filter((name) => name.startsWith(prefix));
}

/** Backdate a file so the sweep sees it as older than the safety age. */
function ageOut(path: string): void {
  const old = new Date(Date.now() - (STALE_TEMP_FILE_MIN_AGE_MS + 60_000));
  utimesSync(path, old, old);
}

describe('atomic write under a concurrent writer of the same store', () => {
  test('a second writer never takes the temp file of a write still in progress — the ENOENT-at-chmod crash', () => {
    const dir = makeProjectTempDir('gv-atomic-race');
    const storePath = join(dir, 'watchers.json');
    mkdirSync(dir, { recursive: true });

    // Writer A reaches the point the crashing process reached: its temp file
    // exists with its bytes in it, and chmod + rename are still to come.
    const tempA = createAtomicTempPath(storePath);
    writeFileSync(tempA, JSON.stringify({ version: 1, watchers: ['from-writer-a'] }), 'utf-8');

    // Writer B now runs a complete write of the SAME store: sweep, temp file,
    // chmod, rename. Under the old naming this both collided with A's path and
    // swept A's file away.
    writeJsonFileAtomic(storePath, { version: 1, watchers: ['from-writer-b'] });

    // A's temp file must still be there, untouched, with A's bytes.
    expect(existsSync(tempA)).toBe(true);
    expect(readFileSync(tempA, 'utf-8')).toContain('from-writer-a');

    // A resumes exactly where the crash happened. Neither call may throw.
    chmodSync(tempA, 0o600);
    renameSync(tempA, storePath);

    // Both writes landed whole and the later rename won, nothing mixed.
    const landed = JSON.parse(readFileSync(storePath, 'utf-8')) as { watchers: string[] };
    expect(landed.watchers).toEqual(['from-writer-a']);
    expect(tempFiles(dir, storePath)).toEqual([]);
  });

  test('two writes of one store never share a temp path, whatever the order they run in', () => {
    const dir = makeProjectTempDir('gv-atomic-race');
    const storePath = join(dir, 'watchers.json');

    const paths = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      paths.add(createAtomicTempPath(storePath));
    }

    expect(paths.size).toBe(500);
    for (const path of paths) {
      // Still recognisable as this store's temp file, so an older build's
      // leftovers stay sweepable and a human can tell what wrote it.
      expect(basename(path).startsWith(`${basename(storePath)}.tmp-${process.pid}-`)).toBe(true);
    }
  });

  test('the stale sweep spares a temp file young enough to be a live write', () => {
    const dir = makeProjectTempDir('gv-atomic-race');
    const storePath = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });

    // A temp file from another live writer of this store, written just now.
    const liveTemp = `${storePath}.tmp-424242-1-abcdef01`;
    writeFileSync(liveTemp, 'bytes another writer is about to rename into place', 'utf-8');

    writeJsonFileAtomic(storePath, { version: 1, items: ['mine'] });

    expect(existsSync(liveTemp)).toBe(true);
    expect(readFileSync(liveTemp, 'utf-8')).toContain('another writer');
  });

  test('the stale sweep still reaps a temp file left behind by a process that died', () => {
    const dir = makeProjectTempDir('gv-atomic-race');
    const storePath = join(dir, 'store.json');
    mkdirSync(dir, { recursive: true });

    // Crash leftovers in both the current naming and the pid-only naming an
    // older build wrote, aged past the safety window.
    const crashedNew = `${storePath}.tmp-905081-3-deadbeef`;
    const crashedOld = `${storePath}.tmp-905081`;
    writeFileSync(crashedNew, 'half a write from a process that died', 'utf-8');
    writeFileSync(crashedOld, 'half a write from an older build that died', 'utf-8');
    ageOut(crashedNew);
    ageOut(crashedOld);

    writeJsonFileAtomic(storePath, { version: 1, items: ['fresh'] });

    expect(existsSync(crashedNew)).toBe(false);
    expect(existsSync(crashedOld)).toBe(false);
    expect(tempFiles(dir, storePath)).toEqual([]);
    expect(JSON.parse(readFileSync(storePath, 'utf-8'))).toEqual({ version: 1, items: ['fresh'] });
  });

  test('two processes hammering one store both finish clean and never leave a partial file', async () => {
    const dir = makeProjectTempDir('gv-atomic-race');
    const storePath = join(dir, 'watchers.json');
    mkdirSync(dir, { recursive: true });

    const script = join(dir, 'writer.ts');
    writeFileSync(script, [
      `import { writeJsonFileAtomic } from ${JSON.stringify(STORE_MODULE)};`,
      'const [, , storePath, tag] = process.argv;',
      // A payload big enough that the write takes real time, so the two
      // processes genuinely overlap inside writeFileAtomic.
      "const filler = Array.from({ length: 400 }, (_, i) => `${tag}-record-${i}`);",
      'for (let round = 0; round < 150; round += 1) {',
      '  writeJsonFileAtomic(storePath!, { version: 1, writer: tag, round, watchers: filler });',
      '}',
      'process.exit(0);',
    ].join('\n'), 'utf-8');

    const first = Bun.spawn(['bun', script, storePath, 'alpha'], { stdout: 'pipe', stderr: 'pipe' });
    const second = Bun.spawn(['bun', script, storePath, 'beta'], { stdout: 'pipe', stderr: 'pipe' });
    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
    const [firstErr, secondErr] = await Promise.all([
      new Response(first.stderr).text(),
      new Response(second.stderr).text(),
    ]);

    expect(firstErr).not.toContain('ENOENT');
    expect(secondErr).not.toContain('ENOENT');
    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);

    // Whoever renamed last owns the file, and it is one writer's whole
    // snapshot, never a mixture and never a truncated one.
    const landed = JSON.parse(readFileSync(storePath, 'utf-8')) as { writer: string; watchers: string[] };
    expect(['alpha', 'beta']).toContain(landed.writer);
    expect(landed.watchers.length).toBe(400);
    for (const entry of landed.watchers) expect(entry.startsWith(landed.writer)).toBe(true);
    expect(tempFiles(dir, storePath)).toEqual([]);
  }, 60_000);
});

describe('writeJsonFileAtomicSafe', () => {
  test('a successful write reports ok and lands the bytes', () => {
    const dir = makeProjectTempDir('gv-atomic-safe');
    const storePath = join(dir, 'store.json');

    const outcome = writeJsonFileAtomicSafe(storePath, { version: 1, items: ['a'] }, { label: 'test/store' });

    expect(outcome.ok).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(JSON.parse(readFileSync(storePath, 'utf-8'))).toEqual({ version: 1, items: ['a'] });
  });

  test('an unwritable store returns the failure with its path and errno instead of throwing', () => {
    const dir = makeProjectTempDir('gv-atomic-safe');
    mkdirSync(dir, { recursive: true });
    // A regular file partway down the store's path: creating the parent
    // directory has to traverse through it, which fails with ENOTDIR.
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'this is a file, not a directory', 'utf-8');
    const storePath = join(blocked, 'nested', 'store.json');

    const outcome = writeJsonFileAtomicSafe(storePath, { version: 1 }, { label: 'test/store' });

    expect(outcome.ok).toBe(false);
    expect(outcome.filePath).toBe(storePath);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.code).toBe('ENOTDIR');
    expect(existsSync(storePath)).toBe(false);
    // The blocking file is untouched, a failed write destroys nothing.
    expect(statSync(blocked).isFile()).toBe(true);
  });
});
