/**
 * recovery.ts — housekeeping for everything the wake-word feature persists.
 *
 * Downloaded models, abandoned partial downloads, and retained debug audio all
 * survive a restart or a crash, so they get the full treatment rather than only
 * being written:
 *
 *  1. REAP ON RECOVERY. Partial `.part` files from an interrupted download,
 *     artifacts of model versions the manifest no longer lists, and retained
 *     audio belonging to sessions that no longer exist are removed at recovery
 *     time instead of accumulating.
 *  2. BOUND EVERYTHING. Retained audio carries both a count cap and an age TTL.
 *     An unbounded "it's only debug audio" directory is a leak with a nicer name.
 *  3. VALIDATE BY CONTENT. A model file that exists may be torn, truncated, or
 *     zero-filled by a crash — this project has already shipped that exact bug
 *     once, and trained on the zeros. A file is kept only when its sha256
 *     matches the pin; otherwise it is reaped so the next provision re-fetches it.
 *  4. REAP PERIODICALLY. {@link startWakeRecoverySweeper} keeps a long-lived
 *     daemon sweeping, because a process that only sweeps at boot never sweeps.
 *     Its caller is `startWakeBootProvisioning` in ./install-provision.ts, which
 *     starts it at every boot and then retries whatever the install could not
 *     download — the sweep and the retry belong together, because reaping a torn
 *     artifact is exactly what lets the retry replace it instead of skipping it.
 *  5. DISCLOSE. Every sweep writes a receipt next to the data
 *     ({@link WAKE_REAP_RECEIPT_FILE}) and returns a summary. Silent deletion is
 *     indistinguishable from data loss.
 *
 * Sweeping is idempotent and safe to run concurrently from more than one
 * process: every removal is an unlink of a specific path, a file another process
 * already removed is not an error, and the receipt is written atomically.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { fileMatches } from '../provisioning/download-verified.js';
import { resolveWakeWordModel, WAKE_WORD_FRONT_END, WAKE_WORD_MODELS } from '../provisioning/wake-word-manifest.js';
import { resolveManagedWakePaths } from './provisioning.js';

/** Where a sweep's disclosure is written, inside the wake root. */
export const WAKE_REAP_RECEIPT_FILE = 'reaped.json';

/** Default cap on retained debug clips. */
export const WAKE_RETAINED_MAX_FILES = 200;
/** Default age after which a retained clip is reaped, in hours. */
export const WAKE_RETAINED_MAX_AGE_HOURS = 24;
/** Age after which an abandoned partial download is reaped, in hours. */
export const WAKE_PARTIAL_MAX_AGE_HOURS = 6;
/** How often the periodic sweeper runs, in milliseconds. */
export const WAKE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Why one path was reaped. */
export type WakeReapReason =
  /** A `.part` file left behind by an interrupted download. */
  | 'abandoned-partial'
  /** Present but its bytes do not hash to the pin — torn, truncated, or the wrong asset. */
  | 'failed-verification'
  /** An artifact of a model version the manifest no longer lists. */
  | 'unpinned-version'
  /** Retained audio older than the TTL. */
  | 'retained-expired'
  /** Retained audio beyond the count cap, oldest first. */
  | 'retained-over-cap'
  /** Retained audio whose owning session no longer exists. */
  | 'retained-orphaned';

/** One reaped path. */
export interface WakeReapedEntry {
  readonly path: string;
  readonly reason: WakeReapReason;
  readonly bytes: number;
}

/** What one sweep did. Returned AND written to the receipt. */
export interface WakeReapSummary {
  readonly at: string;
  readonly wakeRoot: string;
  readonly reaped: readonly WakeReapedEntry[];
  readonly bytesReclaimed: number;
  /** Paths a sweep wanted to remove but could not, with the reason. */
  readonly failures: readonly { readonly path: string; readonly error: string }[];
}

export interface WakeRecoveryOptions {
  readonly managedRoot: string;
  /** Model version whose artifacts are current. Defaults to the manifest default. */
  readonly version?: string | undefined;
  /** Session ids still alive; retained audio for any other session is orphaned. */
  readonly liveSessionIds?: readonly string[] | undefined;
  readonly retainedMaxFiles?: number | undefined;
  readonly retainedMaxAgeHours?: number | undefined;
  /** Injected clock, so TTL behaviour is deterministic under test. */
  readonly now?: number | undefined;
  /** Skip writing the receipt — for a caller that only wants the summary. */
  readonly skipReceipt?: boolean | undefined;
}

/**
 * Sweep the managed wake-word tree once. Safe to call at any time, from any
 * number of processes; returns what it removed.
 */
export function sweepWakeStorage(options: WakeRecoveryOptions): WakeReapSummary {
  const now = options.now ?? Date.now();
  const paths = resolveManagedWakePaths(options.managedRoot, options.version);
  const reaped: WakeReapedEntry[] = [];
  const failures: { path: string; error: string }[] = [];
  const remove = (path: string, reason: WakeReapReason): void => {
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // Already gone — another sweep won the race. Not a failure.
      return;
    }
    try {
      rmSync(path, { force: true });
      reaped.push({ path, reason, bytes });
    } catch (error) {
      failures.push({ path, error: summarizeError(error) });
    }
  };

  sweepPartials(paths.modelsDir, now, options, remove);
  sweepPartials(paths.frontEndDir, now, options, remove);
  sweepPinnedArtifacts(paths, options, remove);
  sweepRetained(paths.retainedDir, now, options, remove);

  const summary: WakeReapSummary = {
    at: new Date(now).toISOString(),
    wakeRoot: paths.wakeRoot,
    reaped,
    bytesReclaimed: reaped.reduce((total, entry) => total + entry.bytes, 0),
    failures,
  };
  if (options.skipReceipt !== true && existsSync(paths.wakeRoot)) writeReceipt(paths.wakeRoot, summary);
  if (reaped.length > 0) {
    logger.info('wake-word storage swept', {
      wakeRoot: paths.wakeRoot,
      reaped: reaped.length,
      bytesReclaimed: summary.bytesReclaimed,
    });
  }
  return summary;
}

/** Remove `.part` files older than the partial TTL. */
function sweepPartials(
  dir: string,
  now: number,
  _options: WakeRecoveryOptions,
  remove: (path: string, reason: WakeReapReason) => void,
): void {
  const cutoff = now - WAKE_PARTIAL_MAX_AGE_HOURS * 3600_000;
  for (const entry of listFiles(dir)) {
    if (!entry.name.endsWith('.part')) continue;
    if (entry.mtimeMs > cutoff) continue;
    remove(entry.path, 'abandoned-partial');
  }
}

/**
 * Reap model artifacts that are unpinned or fail verification.
 *
 * A file whose bytes do not match its pin is removed rather than left in place,
 * because the alternative is an existence check somewhere downstream treating a
 * torn file as a complete one.
 */
function sweepPinnedArtifacts(
  paths: ReturnType<typeof resolveManagedWakePaths>,
  options: WakeRecoveryOptions,
  remove: (path: string, reason: WakeReapReason) => void,
): void {
  const current = resolveWakeWordModel(options.version);
  const pinnedNames = new Set<string>();
  for (const version of Object.keys(WAKE_WORD_MODELS)) {
    const model = resolveWakeWordModel(version);
    if (model === null) continue;
    pinnedNames.add(`goodvibes-wakeword-hey-goodvibes-${model.version}.onnx`);
    // The tflite twin is provisioned too, so it is pinned too. Leaving it off
    // this set would have the sweeper delete an artifact the provisioner had
    // just verified, once an hour, forever.
    pinnedNames.add(`goodvibes-wakeword-hey-goodvibes-${model.version}.tflite`);
    pinnedNames.add(`goodvibes-wakeword-hey-goodvibes-${model.version}.NOTICE.txt`);
  }
  for (const entry of listFiles(paths.modelsDir)) {
    if (entry.name.endsWith('.part')) continue;
    if (!pinnedNames.has(entry.name)) {
      remove(entry.path, 'unpinned-version');
    }
  }
  if (current !== null) {
    if (existsSync(paths.classifierPath) && !fileMatches(paths.classifierPath, current.onnx)) {
      remove(paths.classifierPath, 'failed-verification');
    }
    if (existsSync(paths.mobileClassifierPath) && !fileMatches(paths.mobileClassifierPath, current.tflite)) {
      remove(paths.mobileClassifierPath, 'failed-verification');
    }
    if (existsSync(paths.noticePath) && !fileMatches(paths.noticePath, current.notice)) {
      remove(paths.noticePath, 'failed-verification');
    }
  }
  const embeddingSpec = WAKE_WORD_FRONT_END.embedding.download;
  const embeddingName = `speech-embedding-${WAKE_WORD_FRONT_END.embedding.version}.onnx`;
  for (const entry of listFiles(paths.frontEndDir)) {
    if (entry.name.endsWith('.part')) continue;
    if (entry.name !== embeddingName) {
      remove(entry.path, 'unpinned-version');
    }
  }
  if (existsSync(paths.embeddingPath) && !fileMatches(paths.embeddingPath, embeddingSpec)) {
    remove(paths.embeddingPath, 'failed-verification');
  }
}

/**
 * The filename a retained clip MUST be written under, so the sweeper can tell
 * whose it is.
 *
 * The convention is load-bearing rather than cosmetic: {@link sweepRetained}
 * reads the session id from the first `--`-delimited segment, so a host that
 * invents its own naming gets clips reaped as orphans, or worse, never reaped.
 * Exported so no surface has to re-derive it from reading this file.
 */
export function retainedClipFileName(sessionId: string, at: number, extension = 'wav'): string {
  // Colons and slashes are not portable in filenames, and the session id is the
  // one segment the sweeper parses, so a `--` inside it would split wrong.
  const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/-{2,}/g, '-');
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return `${safeSession}--${stamp}.${extension}`;
}

/**
 * Bound retained debug audio three ways: by owning session, by age, and by
 * count. Clip filenames carry their session id as the first `--`-delimited
 * segment, which is how an orphan is recognised.
 */
function sweepRetained(
  dir: string,
  now: number,
  options: WakeRecoveryOptions,
  remove: (path: string, reason: WakeReapReason) => void,
): void {
  const files = listFiles(dir).filter((entry) => !entry.name.endsWith('.part'));
  if (files.length === 0) return;
  const maxAgeMs = (options.retainedMaxAgeHours ?? WAKE_RETAINED_MAX_AGE_HOURS) * 3600_000;
  const maxFiles = options.retainedMaxFiles ?? WAKE_RETAINED_MAX_FILES;
  const live = options.liveSessionIds === undefined ? null : new Set(options.liveSessionIds);
  const survivors: typeof files = [];
  for (const entry of files) {
    if (live !== null) {
      const sessionId = entry.name.split('--')[0] ?? '';
      if (sessionId.length > 0 && !live.has(sessionId)) {
        remove(entry.path, 'retained-orphaned');
        continue;
      }
    }
    if (now - entry.mtimeMs > maxAgeMs) {
      remove(entry.path, 'retained-expired');
      continue;
    }
    survivors.push(entry);
  }
  if (survivors.length <= maxFiles) return;
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of survivors.slice(0, survivors.length - maxFiles)) {
    remove(entry.path, 'retained-over-cap');
  }
}

interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly mtimeMs: number;
}

/** List regular files in `dir`, tolerating an absent directory. */
function listFiles(dir: string): DirEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DirEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      out.push({ name, path, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished between readdir and stat — another sweep got there first.
    }
  }
  return out;
}

/** Write the disclosure receipt atomically, so a concurrent reader never sees half of it. */
function writeReceipt(wakeRoot: string, summary: WakeReapSummary): void {
  const finalPath = join(wakeRoot, WAKE_REAP_RECEIPT_FILE);
  const tmpPath = join(wakeRoot, `.${randomBytes(6).toString('hex')}.receipt`);
  try {
    mkdirSync(wakeRoot, { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, finalPath);
  } catch (error) {
    logger.warn('wake reap receipt write failed', { wakeRoot, error: summarizeError(error) });
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best effort; the next sweep's receipt write will overwrite it.
    }
  }
}

/** A running periodic sweeper. */
export interface WakeRecoverySweeper {
  /** Run a sweep now, outside the schedule. */
  sweepNow(): WakeReapSummary;
  /** Stop the schedule. Idempotent. */
  stop(): void;
}

/**
 * Sweep at recovery and then on a schedule, so a long-lived daemon does not go
 * a week between sweeps. Returns the first sweep's summary through
 * {@link WakeRecoverySweeper.sweepNow} on demand.
 */
export function startWakeRecoverySweeper(
  options: WakeRecoveryOptions & { readonly intervalMs?: number | undefined },
): WakeRecoverySweeper {
  const run = (): WakeReapSummary => sweepWakeStorage(options);
  run();
  const timer = setInterval(() => {
    try {
      run();
    } catch (error) {
      logger.warn('wake periodic sweep failed', { error: summarizeError(error) });
    }
  }, options.intervalMs ?? WAKE_SWEEP_INTERVAL_MS);
  // Never hold a process open for housekeeping.
  timer.unref?.();
  let stopped = false;
  return {
    sweepNow: run,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
