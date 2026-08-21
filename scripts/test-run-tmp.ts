/**
 * The per-run test temp root, shared by every entry point that shells out to
 * `bun test` directly: `scripts/test.ts` (the normal way to run the suite)
 * and `scripts/leak-scan.ts` (the same suite, with the timer-leak detector
 * preloaded). Both spawn `bun test` as a child process rather than importing
 * it, so this lives as data + a pure sweep call, no top-level side effects,
 * and each caller does its own `mkdirSync`/env wiring/cleanup around the
 * `bun test` invocation it owns.
 *
 * See scripts/test.ts's original comment (preserved there) for the full
 * incident this fixes: `mkdtempSync(join(tmpdir(), …))` in hundreds of test
 * files resolves `tmpdir()` to whatever `TMPDIR` is set to for the process,
 * so redirecting it here to one per-run parent directory turns thousands of
 * unowned leftover directories (from runs killed before their own cleanup
 * could run) into one directory this run owns and removes with itself, plus
 * an age-based sweep for whatever a signal-killed run could not remove.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TMP_ROOT = tmpdir();
export const RUN_TMP_PREFIX = 'goodvibes-sdk-testrun-';
/**
 * Entries older than this are from a run that is long gone. Generous on
 * purpose relative to how long a single `bun test` invocation of this suite
 * actually takes (well under an hour, per-test ceiling of 60s notwithstanding
 *, see scripts/test.ts's resolveTimeoutMs): several checkouts of this
 * repository, and other projects, are routinely under test on the same host
 * at the same time, and a run that is still legitimately in flight must never
 * be swept out from under itself.
 */
export const STALE_RUN_MS = 60 * 60 * 1000;

/** A fresh, collision-safe directory name for this run under TEST_TMP_ROOT. */
export function makeRunTmpDirName(): string {
  return `${RUN_TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Create this run's parent directory under `tmpRoot`, hand it to `fn`, and
 * remove it afterwards.
 *
 * The removal is in a `finally`, so a suite that fails, or a callback that
 * throws before its own cleanup, still takes its temp tree with it. That is
 * the property that makes the containment hold on a RED run and not only a
 * green one, and it is what `test/test-tmp-containment.test.ts` drives.
 *
 * Both direct-`bun test` entry points (`scripts/test.ts`,
 * `scripts/leak-scan.ts`) call this rather than each keeping their own copy of
 * the mkdir/try/finally, so the guard test exercises the lifecycle those
 * scripts actually run instead of a re-implementation of it. Sweeping stale
 * siblings stays with the callers: that is per-tool policy (`prefix`,
 * `maxAgeMs`), not part of one run's lifecycle.
 */
export async function withRunTmpDir<T>(
  tmpRoot: string,
  fn: (runTmpDir: string) => T | Promise<T>,
  dirName: string = makeRunTmpDirName(),
): Promise<T> {
  const runTmpDir = join(tmpRoot, dirName);
  rmSync(runTmpDir, { recursive: true, force: true });
  mkdirSync(runTmpDir, { recursive: true });
  try {
    return await fn(runTmpDir);
  } finally {
    rmSync(runTmpDir, { recursive: true, force: true });
  }
}

/** The env overrides that redirect `tmpdir()` for a spawned `bun test` child. */
export function testTmpEnv(runTmpDir: string): Readonly<Record<string, string>> {
  return { TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir };
}

/**
 * Set in the child environment by every entry point that spawns `bun test`
 * with the redirection above (`scripts/test.ts`, `scripts/leak-scan.ts`).
 *
 * `test/test-tmp-containment.test.ts` reads it to assert the containment end
 * to end: when the suite is running under one of those runners, its
 * `tmpdir()` must already be a run parent. Without the flag that file cannot
 * tell a raw `bun test` (no containment, and none expected) from a runner
 * whose containment has been removed, both look like "TMPDIR is the system
 * temp dir", and the assertion would have to be skipped in the only case it
 * exists to catch.
 *
 * Deliberately NOT returned from `testTmpEnv()`. It is set as a sibling key
 * so that deleting the `...testTmpEnv(runTmpDir)` spread, the mutation that
 * removes the containment, leaves the flag behind and reddens the guard.
 * Folding it into that return value would make the guard go quiet on exactly
 * the change it is watching for.
 */
export const RUNNER_ENV_FLAG = 'GOODVIBES_SDK_TEST_RUNNER';
