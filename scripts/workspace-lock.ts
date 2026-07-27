import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

/**
 * Where the lock lives — the SHARED git directory, not this checkout.
 *
 * A linked worktree has its own `.tmp`, so keying the lock off the checkout
 * gave every worktree a private lock and two builds ran at once. They then
 * raced over one output tree: `build.ts` deletes the `dist` directory of every
 * workspace package before `tsc -b --force` regenerates it, so a second builder
 * could be reading a tree the first had just removed, and any consumer
 * dev-linked at that tree saw no SDK at all for the length of a rebuild.
 *
 * `git rev-parse --git-common-dir` resolves to the SAME directory from the main
 * checkout and from every worktree of it, which is exactly the scope the build
 * output has. A checkout that is not a git repository at all falls back to its
 * own `.tmp`, which is the old behaviour and still correct for a lone tree.
 */
function lockRoot(): string {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: SDK_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (commonDir) return resolve(commonDir, 'goodvibes-workspace');
  } catch {
    // Not a git checkout, or no git on PATH.
  }
  return resolve(SDK_ROOT, '.tmp');
}

const TMP_ROOT = lockRoot();
const LOCK_DIR = resolve(TMP_ROOT, 'workspace.lock');
const LOCK_INFO_PATH = resolve(LOCK_DIR, 'owner.json');
/**
 * How long to WAIT for the lock before giving up.
 *
 * Raised when the lock moved to the shared git directory. It now serializes
 * every worktree of this repository rather than each one separately, which is
 * the point — but it also means a legitimate queue is longer than it used to
 * be. A full suite is minutes, and several queued back to back are routinely
 * more than ten, so the old ceiling turned ordinary waiting into a failure.
 *
 * A holder that has actually died is reclaimed by the staleness check below
 * regardless of this value, so this is a deadlock ceiling, not a patience
 * budget.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
const POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

interface LockInfo {
  readonly pid: number;
  readonly label: string;
  readonly startedAt: number;
}

function readLockInfo(): LockInfo | null {
  try {
    return JSON.parse(readFileSync(LOCK_INFO_PATH, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleLock(): void {
  if (!existsSync(LOCK_DIR)) return;
  const info = readLockInfo();
  if (!info) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
    return;
  }
  const staleByAge = Date.now() - info.startedAt > STALE_AFTER_MS;
  const staleByPid = !isProcessAlive(info.pid);
  if (staleByAge || staleByPid) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

export async function waitForWorkspaceLockRelease(label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (existsSync(LOCK_DIR)) {
    clearStaleLock();
    if (!existsSync(LOCK_DIR)) return;
    if (Date.now() > deadline) {
      const info = readLockInfo();
      const owner = info
        ? `${info.label} (pid ${info.pid}, started ${new Date(info.startedAt).toISOString()})`
        : 'unknown owner';
      throw new Error(`Timed out waiting for workspace lock before ${label}; current owner: ${owner}`);
    }
    await sleep(POLL_MS);
  }
}

export async function withWorkspaceLock<T>(label: string, fn: () => T | Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  mkdirSync(TMP_ROOT, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    clearStaleLock();
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(
        LOCK_INFO_PATH,
        `${JSON.stringify({ pid: process.pid, label, startedAt: Date.now() } satisfies LockInfo, null, 2)}\n`,
        'utf8',
      );
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() > deadline) {
        const info = readLockInfo();
        const owner = info
          ? `${info.label} (pid ${info.pid}, started ${new Date(info.startedAt).toISOString()})`
          : 'unknown owner';
        throw new Error(`Timed out acquiring workspace lock for ${label}; current owner: ${owner}`);
      }
      await sleep(POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
