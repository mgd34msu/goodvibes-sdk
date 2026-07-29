/**
 * Runs the full test suite with the timer-leak detector preloaded.
 *
 * The suite runs every test file in ONE bun process, so a poller a test forgets
 * to stop keeps firing inside every later test file. This script is how that
 * class of bug is measured: it reports the handles still live when the run ends
 * and attributes each to the test file that created it.
 *
 *   bun scripts/leak-scan.ts                    # whole suite
 *   bun scripts/leak-scan.ts test/foo.test.ts   # one file
 *
 * Takes the shared workspace lock, exactly like `scripts/test.ts`, so a scan
 * never runs concurrently with a build or another suite in a sibling worktree.
 *
 * Also invokes `bun test` directly, exactly like `scripts/test.ts` does — so it
 * redirects TMPDIR/TMP/TEMP to its own per-run directory under the real
 * `os.tmpdir()` the same way, via the same shared helpers (scripts/test-run-tmp.ts,
 * scripts/stale-tmp-sweep.ts). Without this, the suite's hundreds of
 * `mkdtempSync(join(tmpdir(), …))` call sites would resolve straight to the
 * real system temp dir when run through this entry point instead of
 * `scripts/test.ts`, leaking the same way a signal-killed run does.
 */
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOwnedTestChild } from './owned-test-child.ts';
import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import {
  makeRunTmpDirName,
  RUN_TMP_PREFIX,
  RUNNER_ENV_FLAG,
  STALE_RUN_MS,
  testTmpEnv,
  TEST_TMP_ROOT,
  withRunTmpDir,
} from './test-run-tmp.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
const RUN_TMP_DIR_NAME = makeRunTmpDirName();

function defaultTestArgs(): readonly string[] {
  const testRoot = resolve(SDK_ROOT, 'test');
  const rootTestFiles = readdirSync(testRoot)
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => `test/${entry}`);
  const extra: string[] = [];
  for (const sub of ['integration', 'toolchain']) {
    try {
      const entries = readdirSync(resolve(testRoot, sub), { withFileTypes: true });
      if (entries.some((e) => e.isFile() && /\.test\.(ts|tsx|mjs)$/.test(e.name))) {
        extra.push(`test/${sub}`);
      }
    } catch {
      // Optional in package-only checkouts.
    }
  }
  return [...rootTestFiles, ...extra];
}

const testArgs = args.length > 0 ? args : defaultTestArgs();
const reportPath = process.env.GOODVIBES_LEAK_REPORT ?? resolve(SDK_ROOT, '.tmp/leak-report.json');

await withWorkspaceLock('leak-scan', async () => {
  sweepStaleTmpDirs(TEST_TMP_ROOT, RUN_TMP_PREFIX, STALE_RUN_MS);
  // Removal is inside withRunTmpDir's `finally`, so every exit path — including
  // a failing suite — takes this run's temp tree with it, exactly like
  // scripts/test.ts. Both entry points share that one lifecycle rather than
  // each keeping a copy, so test/test-tmp-containment.test.ts drives the real
  // one.
  await withRunTmpDir(TEST_TMP_ROOT, async (runTmpDir) => {
    // Owned the same way scripts/test.ts owns its child: a signal that reaches
    // this script reaches the suite too, and the suite is reaped before this
    // callback returns into the temp-tree removal.
    const { exitCode } = await runOwnedTestChild({
      argv: ['--preload', './test/_helpers/leak-detector.ts', ...testArgs],
      cwd: SDK_ROOT,
      env: {
        ...process.env,
        ...testTmpEnv(runTmpDir),
        // Sibling of the spread, not part of it — see RUNNER_ENV_FLAG in
        // scripts/test-run-tmp.ts. This entry point contains temp the same
        // way scripts/test.ts does, so the guard test asserts it here too.
        [RUNNER_ENV_FLAG]: '1',
        GOODVIBES_LEAK_DETECT: '1',
        GOODVIBES_LEAK_REPORT: reportPath,
      },
    });
    console.log(`\nleak report written to ${reportPath}`);
    if (exitCode !== 0) {
      console.log(`(suite exited ${exitCode ?? 'null'} — leak data above is still valid)`);
    }
  }, RUN_TMP_DIR_NAME);
});
