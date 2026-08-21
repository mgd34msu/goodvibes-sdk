/**
 * Clean-shutdown marker + failed-start counter: one small persisted file the
 * daemon writes at three moments.
 *
 *   - start ATTEMPT (the first thing start() does): bumps the consecutive
 *     failed-start counter and reports how many previous attempts never
 *     reached a fully-started daemon. This is what makes a crash loop after a
 *     bad update visible from inside the next boot.
 *   - fully STARTED (the server is accepting): stamps `state: 'running'` and
 *     resets the counter, a boot that got this far was not a failed start.
 *   - orderly STOP: stamps `state: 'clean-shutdown'` and resets the counter.
 *
 * A start that finds the previous marker still saying `running` means the last
 * daemon died without shutting down, the caller records one honest crash
 * receipt.
 *
 * A streak is scoped to the BUILD that recorded it (`version`). Failed starts
 * accuse a specific binary, so when the executable on disk changes between
 * boots the accusation does not transfer to its replacement. Without that, a
 * daemon that had been up for hours could inherit an unrelated streak and roll
 * a perfectly good binary back to an older one.
 *
 * A rollback also records the version it moved AWAY from (`rejectedVersion`),
 * which outlives the rollback: it is the only thing standing between the
 * self-update loop and re-downloading, re-verifying, re-installing and
 * re-restarting into the exact release that just crash looped, every hour,
 * forever.
 *
 * Persisted-state hygiene: every field is validated by content on read (a
 * hand-edited, truncated, or foreign file degrades to "no marker", never to a
 * fabricated crash or a fabricated rollback), the counter is bounded, version
 * strings are length-bounded, and a failed-start streak older than the
 * crash-loop window is dropped rather than accumulated across weeks of
 * unrelated boots.
 *
 * Filesystem and clock are injectable so the contract is provable in tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import { quarantineCorruptFile, writeFileAtomic } from '../utils/atomic-json-store.js';
import { isRecord } from '../utils/record-coerce.js';

export interface LifecycleMarkerIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
  /**
   * Move a marker whose content this module cannot trust aside, preserving it
   * for inspection. Optional so an injected in-memory io (tests, the daemon's
   * own fakes) needs no filesystem behaviour; absent, a bad marker is simply
   * read as "no marker" exactly as before.
   */
  quarantine?(path: string, reason: string): void;
}

export const realLifecycleMarkerIo: LifecycleMarkerIo = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null),
  write: (path, contents) => {
    writeFileAtomic(path, contents);
  },
  quarantine: (path, reason) => {
    quarantineCorruptFile(path, {
      label: 'daemon/lifecycle-marker',
      reason,
      recovery: 'The daemon treats this start as if no previous marker existed: the crash streak resets to zero and an automatic rollback that was pending is not resumed.',
    });
  },
};

/**
 * Read and validate the marker at `markerPath`. Content the parser rejects is
 * quarantined (never deleted) so the record of what a crashing daemon last
 * wrote survives, and the caller still gets the "no marker" answer.
 */
function readMarkerAt(io: LifecycleMarkerIo, markerPath: string): LifecycleMarker | null {
  const raw = io.read(markerPath);
  if (raw === null) return null;
  const marker = parseMarker(raw);
  if (!marker) {
    io.quarantine?.(markerPath, 'marker content is not a valid lifecycle marker');
  }
  return marker;
}

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
  /** When the current failed-start streak began, what bounds "rapid". */
  readonly streakStartedAt?: number | undefined;
  /** When an automatic rollback last restored the kept previous binary; cleared by the next fully-started boot. */
  readonly autoRollbackAt?: number | undefined;
  /**
   * The artifact version the CURRENT streak belongs to. A failed-start streak
   * accuses a specific build; when the build on disk changes (an update, a
   * rollback, a hand-run install) the accusation does not carry over to its
   * replacement, so the streak restarts rather than convicting a binary that
   * never failed.
   */
  readonly version?: string | undefined;
  /**
   * The version an automatic rollback moved AWAY from, the build that crash
   * looped. Kept across boots so the self-update loop does not download,
   * verify, swap and restart into the exact release that just failed, over and
   * over, every check interval. Cleared once that version starts successfully.
   */
  readonly rejectedVersion?: string | undefined;
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

/**
 * Upper bound on a persisted version string. A version is compared and printed,
 * never executed, but an unbounded string from a corrupted file has no business
 * being carried forward into a receipt or a log line.
 */
export const MAX_TRACKED_VERSION_LENGTH = 64;

/** A version field is trusted only when it is a short, non-empty string. */
function readVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRACKED_VERSION_LENGTH) return undefined;
  return trimmed;
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
    const version = readVersion(parsed.version);
    const rejectedVersion = readVersion(parsed.rejectedVersion);
    return {
      state: parsed.state,
      at: parsed.at,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
      failedStarts: readCount(parsed.failedStarts),
      ...(streakStartedAt !== undefined ? { streakStartedAt } : {}),
      ...(autoRollbackAt !== undefined ? { autoRollbackAt } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(rejectedVersion !== undefined ? { rejectedVersion } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The marker as it stands, or null when there is none / it does not survive
 * content validation. Exported so the self-update loop can read the version an
 * automatic rollback rejected without a second parser for the same file.
 */
export function readLifecycleMarker(markerPath: string, io: LifecycleMarkerIo = realLifecycleMarkerIo): LifecycleMarker | null {
  try {
    return readMarkerAt(io, markerPath);
  } catch {
    // An unreadable marker is "no marker", never a throw into a boot path.
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
   * fully-started daemon (this attempt is not counted in the number, it has
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
  /**
   * The running artifact's version. Scopes the failed-start streak to the build
   * it accuses: a marker left by a DIFFERENT version is another build's record,
   * and its failures must not be counted against this one.
   */
  version?: string | undefined;
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
  const previous = readMarkerAt(io, markerPath);
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS);

  const version = readVersion(options.version);
  // A streak accuses the build that recorded it. When the binary on disk has
  // changed since, an update swapped it, a rollback restored it, the owner
  // reinstalled, the previous build's failures are not this build's, and
  // carrying them over is how a healthy binary gets convicted of a crash loop
  // it had no part in.
  const versionChanged =
    version !== undefined && previous?.version !== undefined && previous.version !== version;

  const streakStartedAt = previous?.streakStartedAt;
  const streakIsRapid =
    previous !== null &&
    !versionChanged &&
    previous.failedStarts > 0 &&
    streakStartedAt !== undefined &&
    now >= streakStartedAt &&
    now - streakStartedAt <= windowMs;
  const failedStarts = streakIsRapid ? previous.failedStarts : 0;
  const carriedVersion = version ?? previous?.version;

  writeMarker(io, markerPath, {
    state: previous?.state ?? 'clean-shutdown',
    at: previous?.at ?? now,
    ...(previous?.pid !== undefined ? { pid: previous.pid } : {}),
    failedStarts: Math.min(MAX_TRACKED_FAILED_STARTS, failedStarts + 1),
    streakStartedAt: streakIsRapid && streakStartedAt !== undefined ? streakStartedAt : now,
    ...(previous?.autoRollbackAt !== undefined ? { autoRollbackAt: previous.autoRollbackAt } : {}),
    ...(carriedVersion !== undefined ? { version: carriedVersion } : {}),
    ...(previous?.rejectedVersion !== undefined ? { rejectedVersion: previous.rejectedVersion } : {}),
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
 * this run as `running` and RESETS the failed-start streak, a boot that got
 * this far was not a failed start, and it re-arms the automatic rollback.
 * Returns whether the previous run ended in a crash (marker still `running`).
 * An unreadable/absent marker is honestly NOT a crash, first boots and
 * hand-deleted state must not fabricate a crash receipt.
 */
export function recordDaemonStart(markerPath: string, options: MarkerCallOptions = {}): StartupMarkerResult {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  const previous = readMarkerAt(io, markerPath);
  const version = readVersion(options.version) ?? previous?.version;
  // A rejected version outlives the boot that rejected it, the whole point is
  // that the self-update loop, running on the RESTORED build moments from now,
  // must not fetch and install the rejected release all over again. The one
  // thing that clears it is the rejected version itself reaching fully-started:
  // it works after all, so the rejection is stale and saying otherwise would
  // pin the daemon to an old build forever.
  const rejectedVersion =
    previous?.rejectedVersion !== undefined && previous.rejectedVersion !== version
      ? previous.rejectedVersion
      : undefined;
  writeMarker(io, markerPath, {
    state: 'running',
    at: now(),
    pid: options.pid ?? process.pid,
    failedStarts: 0,
    ...(version !== undefined ? { version } : {}),
    ...(rejectedVersion !== undefined ? { rejectedVersion } : {}),
  });
  return { crashed: previous?.state === 'running', previous };
}

/** Called on orderly shutdown: stamps the marker `clean-shutdown` and clears the failed-start streak. */
export function recordDaemonCleanShutdown(markerPath: string, options: MarkerCallOptions = {}): void {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = options.now ?? Date.now;
  const previous = readMarkerAt(io, markerPath);
  const version = readVersion(options.version) ?? previous?.version;
  writeMarker(io, markerPath, {
    state: 'clean-shutdown',
    at: now(),
    failedStarts: 0,
    ...(version !== undefined ? { version } : {}),
    ...(previous?.rejectedVersion !== undefined ? { rejectedVersion: previous.rejectedVersion } : {}),
  });
}

/**
 * Called immediately after an automatic rollback restored the kept previous
 * binary: clears the streak (the restored version gets a clean slate) and
 * stamps when the rollback fired, so a second automatic rollback is refused
 * until a fully-started boot re-arms it. Without that stamp a rollback, which
 * EXCHANGES the live file with its kept previous, would ping-pong between two
 * versions that both fail to start.
 */
export function recordDaemonAutoRollback(
  markerPath: string,
  options: MarkerCallOptions & {
    /** The version being rolled AWAY from, the build that crash looped. */
    rejectedVersion?: string | undefined;
  } = {},
): void {
  const io = options.io ?? realLifecycleMarkerIo;
  const now = (options.now ?? Date.now)();
  const previous = readMarkerAt(io, markerPath);
  const rejectedVersion = readVersion(options.rejectedVersion) ?? previous?.rejectedVersion;
  writeMarker(io, markerPath, {
    state: previous?.state ?? 'clean-shutdown',
    at: previous?.at ?? now,
    ...(previous?.pid !== undefined ? { pid: previous.pid } : {}),
    failedStarts: 0,
    autoRollbackAt: now,
    // The restored build is about to run, and it is a DIFFERENT version from
    // the one that just failed. Leaving the failing version stamped here would
    // make the restored binary's first boot look like a continuation of its
    // streak; naming the rejected one separately keeps both facts.
    ...(rejectedVersion !== undefined ? { rejectedVersion } : {}),
  });
}
