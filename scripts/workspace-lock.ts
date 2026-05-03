import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const TMP_ROOT = resolve(SDK_ROOT, '.tmp');
const LOCK_DIR = resolve(TMP_ROOT, 'workspace.lock');
const LOCK_INFO_PATH = resolve(LOCK_DIR, 'owner.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
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
