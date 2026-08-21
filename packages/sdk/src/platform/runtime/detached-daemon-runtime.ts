/**
 * D7a Layer 2, pid/port discovery for the detached daemon.
 *
 * When a surface spawns the daemon as a detached, standalone process, it records
 * the pid/host/port to a small JSON file under the daemon home so a later surface
 * (or a `GET /api/service/status` call against the daemon HTTP API) can discover and adopt it without a fresh
 * spawn. This is deliberately a plain record, not a lock, since the daemon's own
 * identity probe is the source of truth for "is it actually alive and mine".
 */

import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

/** File name of the detached-daemon runtime record within the daemon home dir. */
export const DETACHED_DAEMON_RUNTIME_FILE = 'detached-daemon.json';

/**
 * File name of the receipt written when a stale record is reaped. Reaping is
 * disclosed rather than silent: a record that vanished with no trace is
 * indistinguishable from one that was never written.
 */
export const DETACHED_DAEMON_REAPED_FILE = 'detached-daemon-reaped.json';

export interface DetachedDaemonRuntimeRecord {
  readonly pid: number | undefined;
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly startedAt: string;
  readonly logFilePath?: string | undefined;
}

/** Absolute path of the runtime record file for a given daemon runtime dir. */
export function detachedDaemonRuntimePath(runtimeDir: string): string {
  return join(runtimeDir, DETACHED_DAEMON_RUNTIME_FILE);
}

/** Absolute path of the reaping receipt for a given daemon runtime dir. */
export function detachedDaemonReapedPath(runtimeDir: string): string {
  return join(runtimeDir, DETACHED_DAEMON_REAPED_FILE);
}

/**
 * The part of a runtime record that endpoint discovery actually uses: where to
 * dial, and whose liveness to check. Kept narrow deliberately, a caller
 * supplying a hint should not have to invent a `command` and a `startedAt` it
 * has no opinion about, and the full record satisfies this by construction.
 */
export interface DetachedDaemonRuntimeHint {
  readonly host: string;
  readonly port: number;
  readonly pid?: number | undefined;
}

/** Is this pid a process that still exists? Injectable so a test needs no real pid. */
export type ProcessAliveCheck = (pid: number) => boolean;

/**
 * Default liveness check. `kill(pid, 0)` sends no signal, it only asks the
 * kernel whether the pid exists and is signallable. EPERM means it exists and
 * belongs to another user, which still counts as alive.
 */
export const defaultProcessAliveCheck: ProcessAliveCheck = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
};

/**
 * Whether the process this record names still exists.
 *
 * A record with NO pid cannot be checked this way and is not declared dead on
 * that basis, the port probe is then the only evidence, and calling it dead
 * here would strand a daemon that simply recorded no pid.
 */
export function detachedDaemonProcessAlive(
  record: DetachedDaemonRuntimeHint,
  isProcessAlive: ProcessAliveCheck = defaultProcessAliveCheck,
): boolean {
  if (record.pid === undefined) return true;
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  return isProcessAlive(record.pid);
}

/** What a reaping receipt records, so a removed record leaves evidence. */
export interface DetachedDaemonReapReceipt {
  readonly reapedAt: string;
  /** Plain-language reason: which check the record failed. */
  readonly reason: string;
  readonly record: DetachedDaemonRuntimeHint;
}

/**
 * Remove a runtime record that has been proven not to describe a live daemon,
 * and leave a receipt saying so.
 *
 * Best-effort and idempotent: two processes can reap the same record
 * concurrently and neither throws. Removing the record is the point, while it
 * sits there, every endpoint discovery keeps preferring an address nothing
 * answers at, which is exactly the failure this reaping exists to end.
 */
export function reapDetachedDaemonRuntime(
  runtimeDir: string,
  record: DetachedDaemonRuntimeHint,
  reason: string,
): DetachedDaemonReapReceipt | null {
  const receipt: DetachedDaemonReapReceipt = {
    reapedAt: new Date().toISOString(),
    reason,
    record,
  };
  try {
    rmSync(detachedDaemonRuntimePath(runtimeDir), { force: true });
  } catch {
    return null;
  }
  try {
    writeJsonFileAtomic(detachedDaemonReapedPath(runtimeDir), receipt);
  } catch {
    // The record is gone, which is the part that matters; a receipt that could
    // not be written must not turn a successful reap into a failure.
  }
  return receipt;
}

/** Read the last reaping receipt, or null when nothing has been reaped. */
export function readDetachedDaemonReapReceipt(runtimeDir: string): DetachedDaemonReapReceipt | null {
  try {
    return readJsonFileOrQuarantine<DetachedDaemonReapReceipt>(detachedDaemonReapedPath(runtimeDir), {
      label: 'runtime/detached-daemon-reaped',
      recovery: 'The reaping receipt is treated as absent; it is evidence only and nothing depends on it.',
      validate: (raw) => {
        const parsed = raw as Partial<DetachedDaemonReapReceipt> | null;
        if (!parsed || typeof parsed.reason !== 'string') throw new Error('receipt is missing a reason');
        return parsed as DetachedDaemonReapReceipt;
      },
    });
  } catch {
    return null;
  }
}

/** Write (or overwrite) the detached-daemon runtime record. Best-effort; never throws. */
export function recordDetachedDaemonRuntime(
  runtimeDir: string,
  record: DetachedDaemonRuntimeRecord,
): string | null {
  const path = detachedDaemonRuntimePath(runtimeDir);
  try {
    writeJsonFileAtomic(path, record);
    return path;
  } catch {
    return null;
  }
}

/** Read the detached-daemon runtime record, or null if missing/unparseable. */
export function readDetachedDaemonRuntime(runtimeDir: string): DetachedDaemonRuntimeRecord | null {
  try {
    return readJsonFileOrQuarantine<DetachedDaemonRuntimeRecord>(detachedDaemonRuntimePath(runtimeDir), {
      label: 'runtime/detached-daemon-runtime',
      recovery: 'The detached daemon is treated as not running from this record; the next daemon start rewrites it, and an already-running daemon is still reachable through its configured host and port.',
      validate: (raw) => {
        const parsed = raw as Partial<DetachedDaemonRuntimeRecord> | null;
        if (!parsed || typeof parsed.port !== 'number' || typeof parsed.host !== 'string') {
          throw new Error('runtime record is missing a numeric port or a host');
        }
        return {
          pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
          host: parsed.host,
          port: parsed.port,
          command: typeof parsed.command === 'string' ? parsed.command : '',
          startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
          logFilePath: typeof parsed.logFilePath === 'string' ? parsed.logFilePath : undefined,
        };
      },
    });
  } catch {
    return null;
  }
}
