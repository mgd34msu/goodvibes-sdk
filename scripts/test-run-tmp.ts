/**
 * The per-run test temp root, shared by every entry point that shells out to
 * `bun test` directly: `scripts/test.ts` (the normal way to run the suite)
 * and `scripts/leak-scan.ts` (the same suite, with the timer-leak detector
 * preloaded). Both spawn `bun test` as a child process rather than importing
 * it, so this lives as data + a pure sweep call — no top-level side effects —
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TMP_ROOT = tmpdir();
export const RUN_TMP_PREFIX = 'goodvibes-sdk-testrun-';
/**
 * Entries older than this are from a run that is long gone. Generous on
 * purpose relative to how long a single `bun test` invocation of this suite
 * actually takes (well under an hour, per-test ceiling of 60s notwithstanding
 * — see scripts/test.ts's resolveTimeoutMs): several checkouts of this
 * repository, and other projects, are routinely under test on the same host
 * at the same time, and a run that is still legitimately in flight must never
 * be swept out from under itself.
 */
export const STALE_RUN_MS = 60 * 60 * 1000;

/** A fresh, collision-safe directory name for this run under TEST_TMP_ROOT. */
export function makeRunTmpDirName(): string {
  return `${RUN_TMP_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
}

/** The env overrides that redirect `tmpdir()` for a spawned `bun test` child. */
export function testTmpEnv(runTmpDir: string): Readonly<Record<string, string>> {
  return { TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir };
}
