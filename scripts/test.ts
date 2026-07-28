import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sweepStaleTmpDirs } from './stale-tmp-sweep.ts';
import { makeRunTmpDirName, RUN_TMP_PREFIX, STALE_RUN_MS, testTmpEnv, TEST_TMP_ROOT } from './test-run-tmp.ts';
import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

/**
 * Where this run's tests put their temp directories.
 *
 * The suite calls `mkdtempSync(join(tmpdir(), …))` in hundreds of places, and
 * the ones whose cleanup does not run — a test that throws before its
 * `afterEach`, a process killed mid-file — leave the directory behind in the
 * system temp dir, where nothing ever reclaims it. On a machine where /tmp is a
 * tmpfs that is a slow inode leak, and inodes are the resource that runs out
 * first: measured on this project's own host, ~74k leaked directories from
 * these suites had consumed all 1,048,576 tmpfs inodes, at which point every
 * subsequent test failed with ENOSPC no matter what it was asserting. That is
 * the worst kind of failure, because it looks like a defect in whichever test
 * happened to run next.
 *
 * The fix is a single per-run PARENT inside the system temp dir: this run's
 * leftovers are one directory, removed with the run, and an age-based sweep
 * (scripts/stale-tmp-sweep.ts, params in scripts/test-run-tmp.ts — shared with
 * scripts/leak-scan.ts, the other direct-`bun test` entry point) reclaims what
 * a signal-killed run could not remove itself. Thousands of unowned siblings
 * become one owned subtree.
 *
 * It deliberately does NOT live inside the checkout. `tmpdir()` is expected to
 * be somewhere no project rooted above it, and tests rely on that: pointing it
 * at `<repo>/.test-tmp` put a tsconfig.json above every temp directory, so
 * post-edit-diagnostics.test.ts's "returns [] when no TS project context is
 * detectable" case suddenly had one and reported 14 diagnostics where it
 * expected none. Anything rooted above the temp dir — tsconfig, .git,
 * package.json, an editorconfig — is a property tests are entitled to assume
 * absent.
 */
const RUN_TMP_DIR = join(TEST_TMP_ROOT, makeRunTmpDirName());

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

await withWorkspaceLock('test', () => {
  const testArgs = resolveTestArgs();
  sweepStaleTmpDirs(TEST_TMP_ROOT, RUN_TMP_PREFIX, STALE_RUN_MS);
  rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  mkdirSync(RUN_TMP_DIR, { recursive: true });
  try {
    const timeoutArgs = hasExplicitTimeout() ? [] : [`--timeout=${resolveTimeoutMs()}`];
    execFileSync('bun', ['test', ...timeoutArgs, ...testArgs], {
      cwd: SDK_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...testTmpEnv(RUN_TMP_DIR),
      },
    });
  } finally {
    // Every exit path, including a failing suite: this run's temp tree goes
    // with this run. Sibling runs own their own `run-<pid>` subtree and are
    // never touched.
    rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  }
});
