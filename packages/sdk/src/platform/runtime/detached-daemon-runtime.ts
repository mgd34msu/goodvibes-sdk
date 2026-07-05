/**
 * D7a Layer 2 — pid/port discovery for the detached daemon.
 *
 * When a surface spawns the daemon as a detached, standalone process, it records
 * the pid/host/port to a small JSON file under the daemon home so a later surface
 * (or a `GET /api/service/status` call against the daemon HTTP API) can discover and adopt it without a fresh
 * spawn. This is deliberately a plain record — not a lock — since the daemon's own
 * identity probe is the source of truth for "is it actually alive and mine".
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** File name of the detached-daemon runtime record within the daemon home dir. */
export const DETACHED_DAEMON_RUNTIME_FILE = 'detached-daemon.json';

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

/** Write (or overwrite) the detached-daemon runtime record. Best-effort; never throws. */
export function recordDetachedDaemonRuntime(
  runtimeDir: string,
  record: DetachedDaemonRuntimeRecord,
): string | null {
  const path = detachedDaemonRuntimePath(runtimeDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    return path;
  } catch {
    return null;
  }
}

/** Read the detached-daemon runtime record, or null if missing/unparseable. */
export function readDetachedDaemonRuntime(runtimeDir: string): DetachedDaemonRuntimeRecord | null {
  try {
    const raw = readFileSync(detachedDaemonRuntimePath(runtimeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DetachedDaemonRuntimeRecord>;
    if (typeof parsed.port !== 'number' || typeof parsed.host !== 'string') return null;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      host: parsed.host,
      port: parsed.port,
      command: typeof parsed.command === 'string' ? parsed.command : '',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      logFilePath: typeof parsed.logFilePath === 'string' ? parsed.logFilePath : undefined,
    };
  } catch {
    return null;
  }
}
