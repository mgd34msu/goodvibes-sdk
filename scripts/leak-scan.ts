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
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import { makeRunTmpDirName, RUN_TMP_PREFIX, STALE_RUN_MS, testTmpEnv, TEST_TMP_ROOT } from './test-run-tmp.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);
const RUN_TMP_DIR = join(TEST_TMP_ROOT, makeRunTmpDirName());

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

await withWorkspaceLock('leak-scan', () => {
  sweepStaleTmpDirs(TEST_TMP_ROOT, RUN_TMP_PREFIX, STALE_RUN_MS);
  rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  mkdirSync(RUN_TMP_DIR, { recursive: true });
  try {
    const result = spawnSync(
      'bun',
      ['test', '--preload', './test/_helpers/leak-detector.ts', ...testArgs],
      {
        cwd: SDK_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          ...testTmpEnv(RUN_TMP_DIR),
          GOODVIBES_LEAK_DETECT: '1',
          GOODVIBES_LEAK_REPORT: reportPath,
        },
      },
    );
    console.log(`\nleak report written to ${reportPath}`);
    if (result.status !== 0) {
      console.log(`(suite exited ${result.status ?? 'null'} — leak data above is still valid)`);
    }
  } finally {
    // Every exit path, including a failing suite: this run's temp tree goes
    // with this run, exactly like scripts/test.ts.
    rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  }
});
