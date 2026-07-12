/**
 * Clean-shutdown marker: the daemon writes `state: 'running'` when it comes
 * up and `state: 'clean-shutdown'` on orderly stop. A start that finds the
 * previous marker still saying `running` means the last daemon died without
 * shutting down — the caller records one honest crash receipt.
 *
 * Filesystem and clock are injectable so the contract is provable in tests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isRecord } from '../utils/record-coerce.js';

export interface LifecycleMarkerIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
}

export const realLifecycleMarkerIo: LifecycleMarkerIo = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null),
  write: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf-8');
  },
};

export interface LifecycleMarker {
  readonly state: 'running' | 'clean-shutdown';
  readonly at: number;
  readonly pid?: number | undefined;
}

function parseMarker(raw: string | null): LifecycleMarker | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.state !== 'running' && parsed.state !== 'clean-shutdown') return null;
    if (typeof parsed.at !== 'number') return null;
    return {
      state: parsed.state,
      at: parsed.at,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
    };
  } catch {
    return null;
  }
}

export interface StartupMarkerResult {
  /** True when the previous daemon exited without an orderly shutdown. */
  readonly crashed: boolean;
  /** The previous marker, when one existed and parsed. */
  readonly previous: LifecycleMarker | null;
}

/**
 * Called at daemon start: reads the previous marker, then stamps this run as
 * `running`. Returns whether the previous run ended in a crash (marker still
 * `running`). An unreadable/absent marker is honestly NOT a crash — first
 * boots and hand-deleted state must not fabricate a crash receipt.
 */
export function recordDaemonStart(
  markerPath: string,
  options: { io?: LifecycleMarkerIo; now?: () => number; pid?: number } = {},
): StartupMarkerResult {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  const previous = parseMarker(io.read(markerPath));
  const next: LifecycleMarker = {
    state: 'running',
    at: now(),
    pid: options.pid ?? process.pid,
  };
  io.write(markerPath, `${JSON.stringify(next, null, 2)}\n`);
  return { crashed: previous?.state === 'running', previous };
}

/** Called on orderly shutdown: stamps the marker `clean-shutdown`. */
export function recordDaemonCleanShutdown(
  markerPath: string,
  options: { io?: LifecycleMarkerIo; now?: () => number } = {},
): void {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  const marker: LifecycleMarker = { state: 'clean-shutdown', at: now() };
  io.write(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}
