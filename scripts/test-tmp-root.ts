/**
 * test-tmp-root.ts — where a test run's temp directories go, and who removes them.
 *
 * ## The leak this contains
 *
 * The suite calls `mkdtempSync(join(tmpdir(), …))` in hundreds of places. Most
 * of those directories are never removed: cleanup registered with
 * `process.on('exit')` NEVER RUNS under `bun test` — the handler fires under
 * `bun run`, so it looks correct and has been dead code since it was written.
 * Measured on this repository: a GREEN run of 248 test files left 260
 * directories behind in the system temp dir. Not a killed run — a green one.
 *
 * On a host where /tmp is tmpfs that is an inode leak, and inodes run out
 * before bytes do: ~74 000 leaked directories from these suites had consumed
 * all 1 048 576 tmpfs inodes, after which every test failed with ENOSPC
 * regardless of what it asserted.
 *
 * ## The containment
 *
 * One per-run parent inside the system temp dir, exported to the child as
 * TMPDIR/TMP/TEMP. Every `tmpdir()`-rooted directory the suite creates lands
 * inside it, and the whole subtree goes when the run ends — on every exit path,
 * including a failing suite. Thousands of unowned siblings become one owned
 * subtree, and the per-test cleanup that does not run stops mattering.
 *
 * A run that is signal-killed cannot remove its own parent, so
 * `sweepStaleRunDirs` reclaims those. It is age-gated because several checkouts
 * of this repository are routinely under test at once and share this temp dir:
 * a sibling run's parent is seconds old and must never be touched.
 *
 * The parent deliberately does NOT live inside the checkout. Tests are entitled
 * to assume nothing is rooted above their temp directory; pointing it at
 * `<repo>/.test-tmp` put a tsconfig.json above every temp dir, and
 * post-edit-diagnostics.test.ts's "returns [] when no TS project context is
 * detectable" case then found one and reported 14 diagnostics where it expected
 * none.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Marks a directory as a run parent this tooling owns. */
export const RUN_TMP_PREFIX = 'goodvibes-sdk-testrun-';

/** Entries older than this are from a run that is long gone. */
export const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Set in the child environment by scripts/test.ts.
 *
 * `test/test-tmp-containment.test.ts` reads it to assert the containment end to
 * end: when the suite is running under the real runner, its `tmpdir()` must
 * already be a run parent. Without the flag the same file cannot tell a raw
 * `bun test` (no containment, and none expected) from a runner whose
 * containment has been removed.
 */
export const RUNNER_ENV_FLAG = 'GOODVIBES_SDK_TEST_RUNNER';

/** The per-run parent path for a given system temp root. Does not create it. */
export function runTmpDirPath(tmpRoot: string, pid: number = process.pid): string {
  return join(tmpRoot, `${RUN_TMP_PREFIX}${pid}-${randomBytes(4).toString('hex')}`);
}

/** True when `name` is a run parent this tooling owns. */
export function isRunTmpDirName(name: string): boolean {
  return name.startsWith(RUN_TMP_PREFIX);
}

/**
 * Reclaim run parents left behind by a run that could not clean up after
 * itself. Returns the names actually removed.
 *
 * Age-gated: a sibling run started moments ago owns a parent that is seconds
 * old and is never touched. Directories that are not run parents are never
 * touched at any age — this function shares the system temp dir with every
 * other program on the machine.
 */
export function sweepStaleRunDirs(
  tmpRoot: string,
  now: number = Date.now(),
  staleMs: number = STALE_RUN_MS,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!isRunTmpDirName(name)) continue;
    const path = join(tmpRoot, name);
    try {
      if (now - statSync(path).mtimeMs <= staleMs) continue;
    } catch {
      continue; // vanished between listing and stat
    }
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Best effort — another run may have reclaimed it first.
    }
  }
  return removed;
}

/**
 * Create this run's parent, hand it to `fn`, and remove it afterwards.
 *
 * The removal is in `finally`, so a suite that fails, or a callback that
 * throws, still takes its temp tree with it. That is the property the guard
 * test drives: a green run and a red run must both leave zero.
 */
export async function withRunTmpDir<T>(
  tmpRoot: string,
  fn: (runTmpDir: string) => T | Promise<T>,
  pid: number = process.pid,
): Promise<T> {
  const runTmpDir = runTmpDirPath(tmpRoot, pid);
  rmSync(runTmpDir, { recursive: true, force: true });
  mkdirSync(runTmpDir, { recursive: true });
  try {
    return await fn(runTmpDir);
  } finally {
    rmSync(runTmpDir, { recursive: true, force: true });
  }
}
