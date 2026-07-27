import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceLock } from './workspace-lock.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const args = process.argv.slice(2);

/**
 * Where this run's tests are allowed to put temp directories.
 *
 * The suite calls `mkdtempSync(join(tmpdir(), …))` in hundreds of places, and
 * the ones whose cleanup does not run — a test that throws before its
 * `afterEach`, a process killed mid-file — leave the directory behind in the
 * SYSTEM temp dir, where nothing ever reclaims it. On a machine where /tmp is a
 * tmpfs that is a slow inode leak, and inodes are the resource that runs out
 * first: measured on this project's own host, ~74k leaked directories from
 * these suites had consumed all 1,048,576 tmpfs inodes, at which point every
 * subsequent test failed with ENOSPC no matter what it was asserting. That is
 * the worst kind of failure, because it looks like a defect in whichever test
 * happened to run next.
 *
 * Pointing TMPDIR at a per-run directory inside the checkout makes the leak
 * bounded and self-cleaning: this run's leftovers go away with this run, and an
 * age-based sweep reclaims anything a signal-killed run could not remove
 * itself. It matches what the TUI's runner already does (scripts/run-tests.ts).
 */
const TEST_TMP_ROOT = resolve(SDK_ROOT, '.test-tmp');
const RUN_TMP_DIR = join(TEST_TMP_ROOT, `run-${process.pid}`);
/** Entries older than this are from a run that is long gone. */
const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Reclaim `run-*` directories left by a previous run that could not clean up
 * after itself. Age-based, so a sibling run started moments ago is never
 * touched — several checkouts of this repository are routinely under test at
 * the same time.
 */
function sweepStaleRunDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(TEST_TMP_ROOT);
  } catch {
    return; // nothing there yet
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('run-')) continue;
    const path = join(TEST_TMP_ROOT, name);
    try {
      if (now - statSync(path).mtimeMs <= STALE_RUN_MS) continue;
    } catch {
      continue; // vanished between listing and stat
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort — another run may have reclaimed it first.
    }
  }
}

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
  sweepStaleRunDirs();
  rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  mkdirSync(RUN_TMP_DIR, { recursive: true });
  try {
    const timeoutArgs = hasExplicitTimeout() ? [] : [`--timeout=${resolveTimeoutMs()}`];
    execFileSync('bun', ['test', ...timeoutArgs, ...testArgs], {
      cwd: SDK_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TMPDIR: RUN_TMP_DIR,
        TMP: RUN_TMP_DIR,
        TEMP: RUN_TMP_DIR,
        // TMPDIR now lives INSIDE this repository, so git discovery from a bare
        // temp directory would walk up and find the repo's own `.git` — which
        // breaks every test that needs a genuinely non-git directory. Fence
        // discovery at the run's temp root. A repository a test `git init`s
        // under this directory is unaffected: its own `.git` is found first.
        // Set here in the child's environment because bun snapshots the
        // environment at process start.
        GIT_CEILING_DIRECTORIES: RUN_TMP_DIR,
      },
    });
  } finally {
    // Every exit path, including a failing suite: this run's temp tree goes
    // with this run. Sibling runs own their own `run-<pid>` subtree and are
    // never touched.
    rmSync(RUN_TMP_DIR, { recursive: true, force: true });
  }
});
