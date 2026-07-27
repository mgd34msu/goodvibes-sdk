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
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

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
  const result = spawnSync(
    'bun',
    ['test', '--preload', './test/_helpers/leak-detector.ts', ...testArgs],
    {
      cwd: SDK_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        GOODVIBES_LEAK_DETECT: '1',
        GOODVIBES_LEAK_REPORT: reportPath,
      },
    },
  );
  console.log(`\nleak report written to ${reportPath}`);
  if (result.status !== 0) {
    console.log(`(suite exited ${result.status ?? 'null'} — leak data above is still valid)`);
  }
});
