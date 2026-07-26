/**
 * Clean-shutdown marker + failed-start counter: one small persisted file the
 * daemon writes at three moments.
 *
 *   - start ATTEMPT (the first thing start() does): bumps the consecutive
 *     failed-start counter and reports how many previous attempts never
 *     reached a fully-started daemon. This is what makes a crash loop after a
 *     bad update visible from inside the next boot.
 *   - fully STARTED (the server is accepting): stamps `state: 'running'` and
 *     resets the counter — a boot that got this far was not a failed start.
 *   - orderly STOP: stamps `state: 'clean-shutdown'` and resets the counter.
 *
 * A start that finds the previous marker still saying `running` means the last
 * daemon died without shutting down — the caller records one honest crash
 * receipt.
 *
 * Persisted-state hygiene: every field is validated by content on read (a
 * hand-edited, truncated, or foreign file degrades to "no marker", never to a
 * fabricated crash or a fabricated rollback), the counter is bounded, and a
 * failed-start streak older than the crash-loop window is dropped rather than
 * accumulated across weeks of unrelated boots.
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

/**
 * Upper bound on the persisted failed-start counter. The counter only ever
 * needs to be compared against a small threshold, so an absurd value (a
 * hand-edited file, a corrupted write) is clamped rather than trusted.
 */
export const MAX_TRACKED_FAILED_STARTS = 32;

/**
 * How recent a failed-start streak has to be to still count as "rapid". Boots
 * spread further apart than this start a fresh streak: three failures over
 * three weeks are three unrelated incidents, not a crash loop.
 */
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;

export interface LifecycleMarker {
  readonly state: 'running' | 'clean-shutdown';
  readonly at: number;
  readonly pid?: number | undefined;
  /** Consecutive start attempts that never reached a fully-started daemon. */
  readonly failedStarts: number;
  /** When the current failed-start streak began — what bounds "rapid". */
  readonly streakStartedAt?: number | undefined;
  /** When an automatic rollback last restored the kept previous binary; cleared by the next fully-started boot. */
  readonly autoRollbackAt?: number | undefined;
}

/** A count field is trusted only when it is a finite, non-negative number; always clamped. */
function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_TRACKED_FAILED_STARTS, Math.floor(value));
}

/** A timestamp field is trusted only when it is a finite, positive number. */
function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function parseMarker(raw: string | null): LifecycleMarker | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.state !== 'running' && parsed.state !== 'clean-shutdown') return null;
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)) return null;
    const streakStartedAt = readTimestamp(parsed.streakStartedAt);
    const autoRollbackAt = readTimestamp(parsed.autoRollbackAt);
    return {
      state: parsed.state,
      at: parsed.at,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      failedStarts: readCount(parsed.failedStarts),
      ...(streakStartedAt !== undefined ? { streakStartedAt } : {}),
      ...(autoRollbackAt !== undefined ? { autoRollbackAt } : {}),
    };
  } catch {
    return null;
  }
}

function writeMarker(io: LifecycleMarkerIo, markerPath: string, marker: LifecycleMarker): void {
  io.write(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

export interface StartupMarkerResult {
  /** True when the previous daemon exited without an orderly shutdown. */
  readonly crashed: boolean;
  /** The previous marker, when one existed and parsed. */
  readonly previous: LifecycleMarker | null;
}

export interface StartAttemptResult extends StartupMarkerResult {
  /**
   * How many PREVIOUS consecutive start attempts never reached a
   * fully-started daemon (this attempt is not counted in the number — it has
   * not failed yet). Zero on a healthy host.
   */
  readonly failedStarts: number;
  /** When an automatic rollback last fired, if no healthy boot has cleared it since. */
  readonly autoRollbackAt: number | undefined;
}

export interface MarkerCallOptions {
  io?: LifecycleMarkerIo;
  now?: () => number;
  pid?: number;
}

/**
 * Called as the FIRST thing daemon start() does, before anything that could
 * fail: records this boot as an unconfirmed start attempt and reports how many
 * consecutive attempts before it never reached a fully-started daemon.
 *
 * The clean-shutdown fields (`state`, `at`, `pid`) are carried through
 * untouched, so crash detection at fully-started still sees the PREVIOUS run's
 * state rather than this boot's own write.
 */
export function recordDaemonStartAttempt(
  markerPath: string,
  options: MarkerCallOptions & { windowMs?: number } = {},
): StartAttemptResult {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = (options.now ?? Date.now)();
  const previous = parseMarker(io.read(markerPath));
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS);

  const streakStartedAt = previous?.streakStartedAt;
  const streakIsRapid =
    previous !== null &&
    previous.failedStarts > 0 &&
    streakStartedAt !== undefined &&
    now >= streakStartedAt &&
    now - streakStartedAt <= windowMs;
  const failedStarts = streakIsRapid ? previous.failedStarts : 0;

  writeMarker(io, markerPath, {
    state: previous?.state ?? 'clean-shutdown',
    at: previous?.at ?? now,
    ...(previous?.pid !== undefined ? { pid: previous.pid } : {}),
    failedStarts: Math.min(MAX_TRACKED_FAILED_STARTS, failedStarts + 1),
    streakStartedAt: streakIsRapid && streakStartedAt !== undefined ? streakStartedAt : now,
    ...(previous?.autoRollbackAt !== undefined ? { autoRollbackAt: previous.autoRollbackAt } : {}),
  });

  return {
    failedStarts,
    autoRollbackAt: previous?.autoRollbackAt,
    crashed: previous?.state === 'running',
    previous,
  };
}

/**
 * Called once the daemon is fully started (the server is accepting): stamps
 * this run as `running` and RESETS the failed-start streak — a boot that got
 * this far was not a failed start, and it re-arms the automatic rollback.
 * Returns whether the previous run ended in a crash (marker still `running`).
 * An unreadable/absent marker is honestly NOT a crash — first boots and
 * hand-deleted state must not fabricate a crash receipt.
 */
export function recordDaemonStart(markerPath: string, options: MarkerCallOptions = {}): StartupMarkerResult {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  const previous = parseMarker(io.read(markerPath));
  writeMarker(io, markerPath, {
    state: 'running',
    at: now(),
    pid: options.pid ?? process.pid,
    failedStarts: 0,
  });
  return { crashed: previous?.state === 'running', previous };
}

/** Called on orderly shutdown: stamps the marker `clean-shutdown` and clears the failed-start streak. */
export function recordDaemonCleanShutdown(markerPath: string, options: MarkerCallOptions = {}): void {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  writeMarker(io, markerPath, { state: 'clean-shutdown', at: now(), failedStarts: 0 });
}

/**
 * Called immediately after an automatic rollback restored the kept previous
 * binary: clears the streak (the restored version gets a clean slate) and
 * stamps when the rollback fired, so a second automatic rollback is refused
 * until a fully-started boot re-arms it. Without that stamp a rollback — which
 * EXCHANGES the live file with its kept previous — would ping-pong between two
 * versions that both fail to start.
 */
export function recordDaemonAutoRollback(markerPath: string, options: MarkerCallOptions = {}): void {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = (options.now ?? Date.now)();
  const previous = parseMarker(io.read(markerPath));
  writeMarker(io, markerPath, {
    state: previous?.state ?? 'clean-shutdown',
    at: previous?.at ?? now,
    ...(previous?.pid !== undefined ? { pid: previous.pid } : {}),
    failedStarts: 0,
    autoRollbackAt: now,
  });
}
