import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNNER_ENV_FLAG, sweepStaleRunDirs, withRunTmpDir } from './test-tmp-root.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

/**
 * Where this run's tests put their temp directories.
 *
 * The containment lives in ./test-tmp-root.ts, together with the measurements
 * that justify it and the guard test that drives it. In short: cleanup
 * registered with `process.on('exit')` never runs under `bun test`, so a GREEN
 * run of 248 files left 260 directories in the system temp dir. One per-run
 * parent, exported as TMPDIR/TMP/TEMP and removed on every exit path, turns
 * that into zero.
 */
const TEST_TMP_ROOT = tmpdir();

function defaultTestArgs(): readonly string[] {
  const testRoot = resolve(SDK_ROOT, 'test');
  const rootTestFiles = readdirSync(testRoot)
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort()
    .map((entry) => `test/${entry}`);
  // Include integration subdirectory only if it exists and contains test files.
  const integrationDir = resolve(testRoot, 'integration');
  let integrationArgs: string[] = [];
  try {
    const entries = readdirSync(integrationDir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && /\.test\.(ts|tsx|mjs)$/.test(e.name))) {
      integrationArgs = ['test/integration'];
    }
  } catch {
    // Integration tests are optional in package-only checkouts.
  }
  // Include the toolchain unit-test subdirectory when present. Mirrors the
  // integration pattern so `bun run test` (and CI's platform-matrix) exercises
  // the @pellux/goodvibes-toolchain suites without listing each file.
  const toolchainDir = resolve(testRoot, 'toolchain');
  let toolchainArgs: string[] = [];
  try {
    const entries = readdirSync(toolchainDir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && /\.test\.(ts|tsx|mjs)$/.test(e.name))) {
      toolchainArgs = ['test/toolchain'];
    }
  } catch {
    // Toolchain tests are optional in package-only checkouts.
  }
  return [...rootTestFiles, ...integrationArgs, ...toolchainArgs];
}

function resolveTestArgs(): readonly string[] {
  return args.length > 0 ? args : defaultTestArgs();
}

/**
 * Per-test ceiling. bun's built-in default is 5 000 ms, and that is an idle
 * machine's number: this suite boots real daemons, opens real sockets, shells
 * out to real `git`, and signs real crypto — work whose wall-clock cost is set
 * by how busy the host is, not by what the test asserts. Measured on this
 * project's own machine under a realistic concurrent load, the daemon-backed
 * spine files failed outright with "this test timed out after 5000ms" while the
 * daemon was still coming up perfectly normally, and one of them takes ~37 s in
 * total there.
 *
 * A CEILING, not a delay: nothing waits it out, so a fast host finishes exactly
 * as quickly as before and only a genuinely stuck test pays it. A test that
 * needs a different budget still declares its own as the third argument to
 * test(), which continues to win over this default.
 */
function resolveTimeoutMs(): number {
  const env = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return 60_000;
}

/** True when the caller already passed an explicit --timeout, which wins. */
function hasExplicitTimeout(): boolean {
  return args.some((arg) => arg === '--timeout' || arg.startsWith('--timeout='));
}

await withWorkspaceLock('test', async () => {
  const testArgs = resolveTestArgs();
  sweepStaleRunDirs(TEST_TMP_ROOT);
  // withRunTmpDir removes the parent in a `finally`, so a failing suite takes
  // its temp tree with it too. Sibling runs own their own parent and are never
  // touched.
  await withRunTmpDir(TEST_TMP_ROOT, (runTmpDir) => {
    const timeoutArgs = hasExplicitTimeout() ? [] : [`--timeout=${resolveTimeoutMs()}`];
    execFileSync('bun', ['test', ...timeoutArgs, ...testArgs], {
      cwd: SDK_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TMPDIR: runTmpDir,
        TMP: runTmpDir,
        TEMP: runTmpDir,
        [RUNNER_ENV_FLAG]: '1',
      },
    });
  });
});
