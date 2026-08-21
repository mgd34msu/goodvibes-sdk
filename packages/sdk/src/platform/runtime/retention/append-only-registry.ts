/**
 * append-only-registry.ts, the single owner of every append-only store the
 * platform writes.
 *
 * An append-only file that no one prunes grows without bound (the observed
 * 22.8 MB activity.md, unbounded agent journals). The fix is a registry: every
 * append-only store the platform writes registers here with an owner and a
 * retention policy, and a start-time janitor (runAppendOnlyRetentionSweep) owns
 * every registered path in one pass. A registry-membership check
 * (assertAppendOnlyStoreRegistered) fails LOUDLY on an unregistered id, the
 * same fail-closed discipline as the feature-gate-id and model-source checks,
 * so a new append-only store cannot ship unowned and grow forever in silence.
 *
 * The retention engine reused here is enforceFileRetention /
 * enforceJournalDirectoryRetention (age + total-size caps over append-only
 * files), the honest fit for line-appended logs, distinct from the
 * checkpoint-record RetentionPolicy engine that owns the snapshot subsystems.
 */
import {
  DEFAULT_AT_REST_POLICY,
  enforceFileRetention,
  enforceJournalDirectoryRetention,
  resolveAtRestPolicy,
  type AtRestPolicy,
  type RetentionOutcome,
} from '../at-rest-persistence.js';
import { resolveScopedDirectory, resolveSharedDirectory } from '../surface-root.js';
import { CRASH_LOG_FILENAME } from '../crash-capture.js';
import { isLegacyAgentJournalFile } from './legacy-agent-journal-patterns.js';
import { logger } from '../../utils/logger.js';
import { join } from 'node:path';
import { closeSync, openSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs';

/** Every append-only store the platform writes. Extend this when adding one. */
export type AppendOnlyStoreId =
  | 'session-journals'
  | 'activity-log'
  | 'telemetry-local-ledger'
  | 'session-recovery-snapshots'
  | 'session-conversations'
  | 'surface-crash-log'
  | 'legacy-event-store';

/**
 * The roots a sweep resolves store paths from. A store whose required root is
 * absent is skipped this sweep (but stays registered, so the membership check
 * still enforces its ownership).
 */
export interface AppendOnlyRetentionRoots {
  readonly workingDirectory?: string | undefined;
  readonly surfaceRoot?: string | undefined;
  /**
   * The user home root. Consumed by `surface-crash-log`, which is deliberately
   * home-anchored rather than workingDirectory-anchored: a process that dies on
   * an uncaught fault may not have a usable working directory, and a crash is a
   * property of the surface install, not of the project it happened in. (The
   * recovery-snapshot store went the other way, see `session-recovery-snapshots`
   * below, because a recovery snapshot IS project state.)
   */
  readonly homeDirectory?: string | undefined;
  /** Directory holding the shared activity.md log, when the caller configured one. */
  readonly logDir?: string | undefined;
  /** Directory holding local telemetry ledger jsonl files, when configured. */
  readonly telemetryDir?: string | undefined;
}

/** The concrete on-disk targets a store resolves to for a given set of roots. */
export interface AppendOnlyStoreTargets {
  /** Directories swept for every *.jsonl file within. */
  readonly journalDirs: readonly string[];
  /** Individual files swept directly. */
  readonly files: readonly string[];
}

/** One registered append-only store: its owner, retention policy, and path resolver. */
export interface AppendOnlyStoreDescriptor {
  readonly id: AppendOnlyStoreId;
  /** The subsystem that writes this store (for diagnostics/attribution). */
  readonly owner: string;
  readonly description: string;
  /** The retention policy enforced over this store's files. */
  readonly policy: AtRestPolicy;
  /** Resolve the store's concrete targets from the roots (empty when a root is absent). */
  resolve(roots: AppendOnlyRetentionRoots): AppendOnlyStoreTargets;
}

const EMPTY_TARGETS: AppendOnlyStoreTargets = { journalDirs: [], files: [] };

/**
 * The legacy agent/workmap journal files sitting directly in `sessionsDir`
 * (not its `agents/` subdirectory) from before the repoint to sessions/agents/.
 * Classification (isLegacyAgentJournalFile) is shared with
 * session-migration.ts's move, so the sweep and the move can never
 * disagree about which files are legacy agent journals. Returns an empty
 * list when the directory is absent or unreadable, this is a best-effort
 * supplementary sweep, never a hard requirement.
 *
 * The classification is name AND first-line content: a user conversation the
 * user saved under a name that happens to collide with a journal filename
 * shape ("release_workmap", "agent-deadbeef", both legal outputs of
 * SessionManager.sanitizeName) is a real conversation, not a journal, and is
 * left completely alone. So is anything unreadable or ambiguous.
 */
function listLegacyAgentJournalFiles(sessionsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(sessionsDir, name);
    if (isLegacyAgentJournalFile(path, name)) files.push(path);
  }
  return files;
}

/**
 * Read a saved session's `saveSource` off its meta line (line 0) without
 * reading the whole file. Protective default: `'user'` (exempt from
 * reclaim) for anything that is not unambiguously `saveSource: 'auto'`,
 * an unreadable file, a malformed meta line, or (most importantly) a
 * pre-upgrade file that predates this field entirely. Losing a user's saved
 * session to an over-eager sweep is the failure mode this errs away from;
 * only a file that explicitly says `'auto'` is ever a reclaim candidate.
 */
function peekSessionSaveSource(filePath: string): 'user' | 'auto' {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return 'user';
  }
  try {
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
    if (!firstLine) return 'user';
    const meta = JSON.parse(firstLine) as { type?: unknown; saveSource?: unknown };
    if (meta.type !== 'meta') return 'user';
    return meta.saveSource === 'auto' ? 'auto' : 'user';
  } catch {
    return 'user';
  } finally {
    closeSync(fd);
  }
}

/**
 * The saved user-conversation files in `sessionsDir` (top-level `*.jsonl`
 * only, never the sessions/agents/ subdirectory, which the session-journals
 * store owns) that are eligible for retention: `saveSource: 'auto'` files
 * only. A file the user explicitly saved (`saveSource: 'user'`), or any file
 * with no readable saveSource at all, is never included here, see
 * peekSessionSaveSource.
 */
function listReclaimableAutoSessionFiles(sessionsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const path = join(sessionsDir, name);
    if (peekSessionSaveSource(path) === 'auto') files.push(path);
  }
  return files;
}

/** The canonical registry. Adding an append-only writer means adding an entry here. */
export const APPEND_ONLY_STORES: readonly AppendOnlyStoreDescriptor[] = [
  {
    id: 'session-journals',
    owner: 'session/agent journal (agents/session.ts, agents/wrfc-workmap.ts)',
    description: 'per-agent transcript journals and WRFC workmaps under the scoped sessions/agents/ directory, plus (this release only) any pre-repoint journal left flat in sessions/ from before agent journals moved out of the user-conversation directory',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.workingDirectory) return EMPTY_TARGETS;
      const sessionsDir = resolveScopedDirectory(roots.workingDirectory, roots.surfaceRoot, 'sessions');
      return {
        journalDirs: [join(sessionsDir, 'agents')],
        // Legacy sweep is filename-filtered, never the whole sessionsDir,
        // that directory also holds user conversation *.jsonl files and must
        // never be swept wholesale.
        files: listLegacyAgentJournalFiles(sessionsDir),
      };
    },
  },
  {
    id: 'activity-log',
    owner: 'shared activity logger (utils/logger.ts)',
    description: 'the shared activity.md debug log and its rotated backup',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.logDir) return EMPTY_TARGETS;
      return { journalDirs: [], files: [join(roots.logDir, 'activity.md'), join(roots.logDir, 'activity.md.1')] };
    },
  },
  {
    id: 'telemetry-local-ledger',
    owner: 'local execution ledger (runtime/telemetry/exporters/local-ledger.ts)',
    description: 'local telemetry span + ledger jsonl files',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.telemetryDir) return EMPTY_TARGETS;
      return { journalDirs: [roots.telemetryDir], files: [] };
    },
  },
  {
    id: 'session-recovery-snapshots',
    owner: 'per-session crash-recovery snapshots (runtime/session-recovery.ts, runtime/session-surface.ts)',
    description: 'per-session crash-recovery jsonl snapshots under the workingDirectory-scoped recovery/ directory (SessionSurface.recoveryDir); a snapshot that was never restored goes stale and needs retention like any other append-only artifact',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      // Anchored to workingDirectory, matching SessionSurface.recoveryDir,
      // NOT homeDirectory. A crash snapshot lives with the project it
      // happened in (see session-surface.ts's SessionSurface.recoveryDir doc
      // comment); the legacy home-anchored resolution stays reachable only
      // through session-recovery.ts's legacy call form, which this sweep
      // does not follow.
      if (!roots.workingDirectory) return EMPTY_TARGETS;
      return {
        journalDirs: [resolveScopedDirectory(roots.workingDirectory, roots.surfaceRoot, 'recovery')],
        files: [],
      };
    },
  },
  {
    id: 'session-conversations',
    owner: 'saved user conversation sessions (sessions/manager.ts SessionManager.save)',
    description: 'saved conversation *.jsonl files under the scoped sessions/ directory; a file the user explicitly saved (saveSource "user"), or any pre-upgrade file with no saveSource at all, is exempt and never reclaimed, only saveSource "auto" files are subject to the bounded default retention policy',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.workingDirectory) return EMPTY_TARGETS;
      const sessionsDir = resolveScopedDirectory(roots.workingDirectory, roots.surfaceRoot, 'sessions');
      return { journalDirs: [], files: listReclaimableAutoSessionFiles(sessionsDir) };
    },
  },
  {
    id: 'surface-crash-log',
    owner: 'process-fault crash capture (runtime/crash-capture.ts)',
    description: 'the home-anchored crashes.jsonl a surface writes from its uncaughtException/unhandledRejection exit boundary; the writer already caps it by record count, and this entry adds the age and total-size caps every other append-only store gets',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      // Home-anchored, matching where crash-capture.ts writes: a faulting
      // process may have no usable working directory, and the operator looks
      // for "why did my agent die" in one place per install, not one per
      // project.
      if (!roots.homeDirectory) return EMPTY_TARGETS;
      const surfaceDir = resolveScopedDirectory(roots.homeDirectory, roots.surfaceRoot);
      return { journalDirs: [], files: [join(surfaceDir, CRASH_LOG_FILENAME)] };
    },
  },
  {
    id: 'legacy-event-store',
    owner: 'legacy event store (dead: no live writer anywhere in the platform; last write observed 2026-07-02)',
    description: 'the unscoped .goodvibes/state/events.jsonl file and its event-archives/ directory, dead data with no live writer, NOT the whole state dir (which holds live retries.json, agent-tracking.json, workflows/, and session_*.json KVState files)',
    policy: DEFAULT_AT_REST_POLICY,
    resolve(roots) {
      if (!roots.workingDirectory) return EMPTY_TARGETS;
      const stateDir = resolveSharedDirectory(roots.workingDirectory, 'state');
      return {
        journalDirs: [join(stateDir, 'event-archives')],
        files: [join(stateDir, 'events.jsonl')],
      };
    },
  },
];

const REGISTERED_IDS: ReadonlySet<string> = new Set(APPEND_ONLY_STORES.map((store) => store.id));

/** True when `id` is a registered append-only store. */
export function isAppendOnlyStoreRegistered(id: string): boolean {
  return REGISTERED_IDS.has(id);
}

/**
 * Fail-closed membership check: throw when `id` is not a registered append-only
 * store. Mirrors assertFeatureGateIdRegistered, an unregistered append-only
 * path is a defect (it would grow unowned), so it fails loudly.
 */
export function assertAppendOnlyStoreRegistered(id: string, context: string): void {
  if (REGISTERED_IDS.has(id)) return;
  throw new Error(
    `unknown append-only store id "${id}" (${context}); every append-only store the platform writes must be `
    + 'registered in APPEND_ONLY_STORES with an owner and a retention policy.',
  );
}

/** The outcome of one start-time retention sweep. */
export interface AppendOnlySweepOutcome {
  readonly sweptStores: readonly AppendOnlyStoreId[];
  readonly skippedStores: readonly AppendOnlyStoreId[];
  readonly deletedFiles: number;
  readonly reclaimedBytes: number;
  /** How many of `deletedFiles` were reclaimed by the per-store count cap rather than by age/size. */
  readonly countCappedFiles: number;
}

/**
 * The per-store FILE-COUNT bound, the third cap alongside the AtRestPolicy's
 * age (30 days) and total-size (512 MB) caps.
 *
 * Age plus size alone do not bound a store: ten thousand 4 KB journals written
 * this week sit under both the 30-day horizon and the 512 MB budget, and the
 * directory still has ten thousand entries in it, every listing, every sweep,
 * and every consumer that enumerates the store pays for them. 512 is chosen to
 * sit far above any honest working set (a heavy fleet day produces tens of
 * agent journals, not hundreds) while still being a hard ceiling, and it keeps
 * a directory listing cheap on every filesystem.
 *
 * Enforced HERE, at the registry layer, rather than inside enforceFileRetention:
 * the count is a property of a registered store's target set (which files
 * belong to it, after its exemptions have been applied), not of the generic
 * age/size engine that several unrelated callers share.
 */
const MAX_FILES_PER_APPEND_ONLY_STORE = 512;

const EMPTY_RETENTION_OUTCOME: RetentionOutcome = { deletedFiles: [], reclaimedBytes: 0 };

/**
 * Every file currently on disk that belongs to a store's resolved targets.
 * Called AFTER the age/size pass, so it sees survivors only. An unreadable or
 * absent directory contributes nothing (best effort, never an error).
 */
function listStoreFilesOnDisk(targets: AppendOnlyStoreTargets): string[] {
  const paths: string[] = [];
  for (const dir of targets.journalDirs) {
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.jsonl')) paths.push(join(dir, name));
      }
    } catch {
      // Absent/unreadable directory, nothing of this store's is there.
    }
  }
  paths.push(...targets.files);
  return paths;
}

/**
 * Enforce the file-count bound over a store's surviving targets, deleting
 * oldest-first until at most `maxFiles` remain. Idempotent and safe to run
 * concurrently from two processes: the listing is re-read every call, a file
 * another sweep already removed (ENOENT) is a success that reclaims nothing,
 * and any other delete failure leaves the file in place rather than throwing.
 */
function enforceStoreFileCountCap(targets: AppendOnlyStoreTargets, maxFiles: number): RetentionOutcome {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return EMPTY_RETENTION_OUTCOME;
  const seen = new Set<string>();
  const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const path of listStoreFilesOnDisk(targets)) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Already gone (possibly reclaimed by the age/size pass or another sweep).
    }
  }
  if (entries.length <= maxFiles) return EMPTY_RETENTION_OUTCOME;
  // Newest first, path as a deterministic tiebreak so two processes sweeping
  // the same store at the same instant agree on which files are doomed.
  entries.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const deleted: string[] = [];
  let reclaimed = 0;
  for (const entry of entries.slice(maxFiles)) {
    try {
      unlinkSync(entry.path);
      deleted.push(entry.path);
      reclaimed += entry.size;
    } catch {
      // ENOENT: another sweep beat us to it, the post-state is what we wanted.
      // Anything else: leave the file in place; the next sweep retries.
    }
  }
  return { deletedFiles: deleted, reclaimedBytes: reclaimed };
}

/**
 * The start-time janitor: enforce every registered store's retention policy in
 * one pass over the paths its resolver yields for the given roots. A store
 * whose roots are absent is skipped (reported), not an error. Best-effort,
 * a failure on one store never aborts the others.
 */
export function runAppendOnlyRetentionSweep(
  roots: AppendOnlyRetentionRoots,
  options: {
    readonly policyOverride?: AtRestPolicy | undefined;
    /** Override the per-store file-count bound (default MAX_FILES_PER_APPEND_ONLY_STORE). */
    readonly maxFilesOverride?: number | undefined;
  } = {},
): AppendOnlySweepOutcome {
  const swept: AppendOnlyStoreId[] = [];
  const skipped: AppendOnlyStoreId[] = [];
  const maxFiles = options.maxFilesOverride ?? MAX_FILES_PER_APPEND_ONLY_STORE;
  let deletedFiles = 0;
  let reclaimedBytes = 0;
  let countCappedFiles = 0;
  for (const store of APPEND_ONLY_STORES) {
    let targets: AppendOnlyStoreTargets;
    try {
      targets = store.resolve(roots);
    } catch (error) {
      logger.warn('[retention] append-only store path resolution failed', { store: store.id, error: String(error) });
      skipped.push(store.id);
      continue;
    }
    if (targets.journalDirs.length === 0 && targets.files.length === 0) {
      skipped.push(store.id);
      continue;
    }
    const policy = options.policyOverride ?? store.policy;
    try {
      const storePruned: string[] = [];
      let storeReclaimedBytes = 0;
      for (const dir of targets.journalDirs) {
        const outcome = enforceJournalDirectoryRetention(dir, policy);
        deletedFiles += outcome.deletedFiles.length;
        reclaimedBytes += outcome.reclaimedBytes;
        storePruned.push(...outcome.deletedFiles);
        storeReclaimedBytes += outcome.reclaimedBytes;
      }
      if (targets.files.length > 0) {
        const outcome = enforceFileRetention(targets.files, policy);
        deletedFiles += outcome.deletedFiles.length;
        reclaimedBytes += outcome.reclaimedBytes;
        storePruned.push(...outcome.deletedFiles);
        storeReclaimedBytes += outcome.reclaimedBytes;
      }
      // Third cap: the file COUNT bound, over whatever survived age + size.
      const countCapped = enforceStoreFileCountCap(targets, maxFiles);
      deletedFiles += countCapped.deletedFiles.length;
      countCappedFiles += countCapped.deletedFiles.length;
      reclaimedBytes += countCapped.reclaimedBytes;
      storePruned.push(...countCapped.deletedFiles);
      storeReclaimedBytes += countCapped.reclaimedBytes;
      // Disclosure: every reclaim names exactly what was pruned, per store,
      // not just an aggregate count. A reclaimed file is gone; this is the
      // record of what happened and why (store id + owner). A store that
      // reclaimed NOTHING logs nothing, so a periodic re-sweep on a quiet
      // daemon stays silent instead of writing a line every interval.
      if (storePruned.length > 0) {
        logger.info('[retention] append-only store reclaimed files', {
          store: store.id,
          owner: store.owner,
          reclaimedBytes: storeReclaimedBytes,
          countCappedFiles: countCapped.deletedFiles.length,
          prunedFiles: storePruned,
        });
      }
      swept.push(store.id);
    } catch (error) {
      logger.warn('[retention] append-only store sweep failed', { store: store.id, error: String(error) });
      skipped.push(store.id);
    }
  }
  if (deletedFiles > 0) {
    logger.info('[retention] append-only retention sweep reclaimed files', {
      deletedFiles,
      countCappedFiles,
      reclaimedBytes,
      sweptStores: swept,
    });
  }
  return { sweptStores: swept, skippedStores: skipped, deletedFiles, reclaimedBytes, countCappedFiles };
}

/**
 * Convenience start-time entry point wired at runtime construction: resolve the
 * at-rest policy from a config getter and run the sweep, swallowing any failure
 * so a retention problem never takes runtime startup down.
 *
 * Takes the FULL roots object: a caller that omits logDir/telemetryDir/
 * homeDirectory silently skips the activity-log, telemetry-ledger, and
 * recovery-snapshot stores every sweep, registered entries that never run.
 * The composition root passes every root it knows.
 */
export function runStartupAppendOnlySweep(
  roots: AppendOnlyRetentionRoots,
  configGet?: (key: string) => unknown,
): AppendOnlySweepOutcome | null {
  try {
    return runAppendOnlyRetentionSweep(
      roots,
      { policyOverride: configGet ? resolveAtRestPolicy(configGet) : undefined },
    );
  } catch (error) {
    logger.warn('[retention] startup append-only sweep failed', { error: String(error) });
    return null;
  }
}

/**
 * How often the registry re-sweeps after startup.
 *
 * Six hours, not minutes and not days. A sweep is a stat pass over a few dozen
 * paths, so the cost is negligible at any cadence; what sets the number is
 * overshoot. The caps it enforces are a 30-day age horizon, a 512 MB size
 * budget, and a 512-file count bound, and a store can only exceed a cap for as
 * long as it takes the next sweep to arrive. Six hours bounds that overshoot to
 * a quarter of a day of append volume, small against a 512 MB budget even for
 * the fastest writer observed (the 22.8 MB activity.md accumulated over weeks),
 * and it reclaims a file within hours of its 30-day TTL rather than up to a full
 * day later. Anything in minutes would be pure wakeups for a store whose
 * shortest cap is measured in days.
 */
export const APPEND_ONLY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Construction seams for {@link AppendOnlyRetentionScheduler}; tests drive the timer directly. */
export interface AppendOnlyRetentionSchedulerOptions {
  /** The roots every sweep resolves store paths from (the composition root's full set). */
  readonly roots: AppendOnlyRetentionRoots;
  /** Config getter for the at-rest policy, read fresh on every sweep so a live config edit applies. */
  readonly configGet?: ((key: string) => unknown) | undefined;
  /** Sweep cadence; defaults to {@link APPEND_ONLY_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
  /** Observation seam for hosts/tests; never used for disclosure (the sweep logs its own reclaims). */
  readonly onSweep?: ((outcome: AppendOnlySweepOutcome | null) => void) | undefined;
}

/**
 * The append-only janitor's daemon-lifetime half.
 *
 * A start-time-only sweep is a janitor that clocks in once: a daemon that stays
 * up for weeks never prunes any of the six registered stores again after boot,
 * which is exactly the window in which they grow. This scheduler re-runs the
 * same sweep on an unref'd timer (it can never be the reason a process stays
 * alive), stops cleanly, and is safe to start twice, a second start() is a
 * no-op rather than a second timer. Same lifecycle posture as
 * StoreSnapshotScheduler: the host that constructs it stops it on teardown.
 *
 * A sweep that reclaims nothing writes no log line, so a quiet daemon does not
 * accumulate an entry every interval, the disclosure requirement is about
 * deletions, and there are none to disclose.
 */
export class AppendOnlyRetentionScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly options: AppendOnlyRetentionSchedulerOptions) {}

  private get intervalMs(): number {
    return this.options.intervalMs ?? APPEND_ONLY_SWEEP_INTERVAL_MS;
  }

  /** True while a sweep is scheduled. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Begin periodic sweeps. Idempotent: calling it again while running does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Stop periodic sweeps and release the timer. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one sweep now, then re-arm (when running). Never throws, the
   * underlying entry point already swallows and reports its own failures.
   */
  tick(): AppendOnlySweepOutcome | null {
    let outcome: AppendOnlySweepOutcome | null = null;
    try {
      outcome = runStartupAppendOnlySweep(this.options.roots, this.options.configGet);
    } finally {
      this.scheduleNext();
    }
    this.options.onSweep?.(outcome);
    return outcome;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.timer = null;
      this.tick();
    }, this.intervalMs);
    // Unref'd: a pending sweep must never hold a process open.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
