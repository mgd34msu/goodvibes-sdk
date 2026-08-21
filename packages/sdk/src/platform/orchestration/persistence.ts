/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Persistence (see CHANGELOG 0.38.0), mirrors the WrfcController chain seams
 * exactly: serializeChain:323 / deserializeChain:345 (including the
 * future-schemaVersion-reject guard at :364) / importChain:402. Writes to
 * `.goodvibes/orchestration/<workstreamId>.json`, SEPARATE from the TUI's
 * `.goodvibes/tui/wrfc-chains.json` (src/runtime/wrfc-persistence.ts), no
 * path collision. Debounce (250ms) and corrupt-snapshot quarantine
 * (`<path>.unrecognized`) mirror that same TUI module's conventions.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  CURRENT_WORKSTREAM_SCHEMA_VERSION,
  type OrchestrationEvent,
  type PhaseResult,
  type SerializedWorkItem,
  type SerializedWorkstream,
  type WorkItem,
  type WorkItemState,
  type Workstream,
  type WorkstreamSnapshot,
} from './types.js';

const DEBOUNCE_MS = 250;

/**
 * Count cap on retained TERMINAL workstream snapshots (every item passed or
 * failed). 50 is several weeks of finished work for a busy project, enough
 * that "what did that run do?" is still answerable, while keeping the
 * directory small enough to enumerate cheaply on every resume.
 *
 * A snapshot for a workstream that is still RUNNING is NEVER reaped, at any
 * count or age: resumability is the entire point of the store.
 */
const MAX_TERMINAL_SNAPSHOTS = 50;

/**
 * Age TTL for a terminal workstream snapshot, measured from its `writtenAt`.
 * 14 days: two working weeks covers "resume the thing I finished before
 * vacation" and post-mortem reads, past which a finished workstream is history
 * nobody re-enters.
 */
const TERMINAL_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Age TTL for `.unrecognized` quarantine files.
 *
 * 30 days, deliberately longer than the terminal-snapshot TTL, because these
 * files are FORENSIC: they exist precisely because something went wrong
 * (torn write, foreign/newer writer, bad shape), and the person who has to
 * explain it may not look for weeks. A month is long enough for a bug report
 * to reach someone and short enough that a repeatedly-crashing host does not
 * keep litter forever.
 */
const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on quarantine files, a crash loop can mint one per resume, so the age TTL alone is not a bound. Newest are kept. */
const MAX_QUARANTINE_FILES = 20;

/**
 * Age TTL for temp files left behind by an interrupted atomic write. An hour
 * is far beyond any real write (milliseconds), so anything older is crash
 * litter from a dead process rather than an in-flight write by a live one.
 */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Periodic housekeeping interval for {@link attachDebouncedWriter}, reaping must not be resume-only for a long-lived engine. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const QUARANTINE_SUFFIX = '.unrecognized';
const TEMP_SUFFIX = '.tmp';

function serializeWorkItem(item: WorkItem): SerializedWorkItem {
  return { ...item, visits: Object.fromEntries(item.visits) };
}

function deserializeWorkItem(raw: SerializedWorkItem): WorkItem {
  // `dependsOn` (BIG-3 item 2) defaults to [] for snapshots written before the
  // field existed, so an older snapshot deserializes as an un-gated item rather
  // than crashing the dependency pre-pass on an undefined array.
  return { ...raw, dependsOn: raw.dependsOn ?? [], visits: new Map(Object.entries(raw.visits)) };
}

export function serializeWorkstream(workstream: Workstream): SerializedWorkstream {
  return { ...workstream, items: workstream.items.map(serializeWorkItem) };
}

export function deserializeWorkstream(serialized: SerializedWorkstream): Workstream {
  return { ...serialized, items: serialized.items.map(deserializeWorkItem) };
}

/** Mirrors WrfcController.serializeChain: JSON.stringify a schema-versioned envelope. Returns null on serialization failure rather than throwing. */
export function serializeWorkstreamSnapshot(workstream: Workstream, completedResults: readonly PhaseResult[]): string | null {
  const snapshot: WorkstreamSnapshot = {
    schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    writtenAt: Date.now(),
    workstream: serializeWorkstream(workstream),
    completedResults,
  };
  try {
    return JSON.stringify(snapshot);
  } catch (error) {
    logger.error('orchestration persistence: JSON serialization failed', { workstreamId: workstream.id, error: summarizeError(error) });
    return null;
  }
}

/**
 * Mirrors WrfcController.deserializeChain's future-schemaVersion-reject
 * guard: a snapshot written by a newer runtime is rejected (fail closed)
 * rather than partially trusted.
 */
export function deserializeWorkstreamSnapshot(json: string): WorkstreamSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    logger.error('orchestration persistence: JSON parse failed', { error: summarizeError(error) });
    return null;
  }
  if (raw === null || typeof raw !== 'object') {
    logger.warn('orchestration persistence: invalid snapshot JSON, not an object');
    return null;
  }
  const candidate = raw as Partial<WorkstreamSnapshot>;
  if (typeof candidate.schemaVersion !== 'number') {
    logger.warn('orchestration persistence: invalid snapshot JSON, missing schemaVersion');
    return null;
  }
  if (candidate.schemaVersion > CURRENT_WORKSTREAM_SCHEMA_VERSION) {
    logger.error('orchestration persistence: future schemaVersion rejected, upgrade runtime to read this snapshot', {
      schemaVersion: candidate.schemaVersion,
      supportedVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    });
    return null;
  }
  if (!candidate.workstream || typeof candidate.workstream !== 'object' || !Array.isArray(candidate.completedResults)) {
    logger.warn('orchestration persistence: invalid snapshot JSON, missing workstream/completedResults');
    return null;
  }
  return candidate as WorkstreamSnapshot;
}

function orchestrationDir(projectRoot: string): string {
  return join(projectRoot, '.goodvibes', 'orchestration');
}

function snapshotPath(projectRoot: string, workstreamId: string): string {
  return join(orchestrationDir(projectRoot), `${workstreamId}.json`);
}

/** Read + quarantine-on-corrupt (never throws, never crashes the caller on a bad file). */
export function loadWorkstreamSnapshot(projectRoot: string, workstreamId: string): WorkstreamSnapshot | null {
  const path = snapshotPath(projectRoot, workstreamId);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    logger.warn('orchestration persistence: snapshot read failed', { path, error: summarizeError(error) });
    return null;
  }
  const snapshot = deserializeWorkstreamSnapshot(text);
  if (snapshot === null) {
    const quarantinePath = `${path}.unrecognized`;
    try {
      renameSync(path, quarantinePath);
      logger.warn('orchestration persistence: quarantined unrecognized snapshot', { path, quarantinePath });
    } catch (error) {
      logger.error('orchestration persistence: failed to quarantine unrecognized snapshot', { path, error: summarizeError(error) });
    }
    return null;
  }
  return snapshot;
}

/**
 * List the workstream ids with a snapshot on disk (recognized or not, callers
 * decide via loadWorkstreamSnapshot).
 *
 * This is the resume-enumeration path, so it is also the recovery point: a
 * housekeeping pass runs FIRST, so ids reclaimed by the reap are never handed
 * back to a caller that would then fail to load them.
 */
export function listSnapshotWorkstreamIds(projectRoot: string, options?: SnapshotReapOptions): string[] {
  reapOrchestrationSnapshots(projectRoot, options);
  const dir = orchestrationDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length));
  } catch (error) {
    logger.warn('orchestration persistence: failed to list snapshot directory', { dir, error: summarizeError(error) });
    return [];
  }
}

export function writeWorkstreamSnapshot(projectRoot: string, workstream: Workstream, completedResults: readonly PhaseResult[]): void {
  const json = serializeWorkstreamSnapshot(workstream, completedResults);
  if (json === null) return;
  const path = snapshotPath(projectRoot, workstream.id);
  // Temp-file-plus-rename: a crash mid-write can only leave a stray temp file
  // (aged out by the reap below), never a torn snapshot. Without this, a crash
  // during the write destroys the snapshot outright, the next load quarantines
  // the wreckage, which is self-healing but has already LOST the workstream.
  // The pid+timestamp suffix keeps two writing processes off one temp path.
  const tempPath = `${path}.${process.pid}.${Date.now()}${TEMP_SUFFIX}`;
  try {
    mkdirSync(orchestrationDir(projectRoot), { recursive: true });
    writeFileSync(tempPath, json, 'utf-8');
    renameSync(tempPath, path);
  } catch (error) {
    logger.error('orchestration persistence: snapshot write failed', { path, error: summarizeError(error) });
    removeFile(tempPath);
  }
}

// ── Housekeeping ──────────────────────────────────────────────────────────────

/** Seams for the snapshot housekeeping pass. */
export interface SnapshotReapOptions {
  /**
   * "Is this workstream still running?", INJECTED so the reap can protect a
   * live workstream's snapshot without depending on the engine. Returning
   * `true` exempts the snapshot from every bound. When omitted, liveness is
   * inferred from the snapshot's own item states (an item that is not `passed`
   * or `failed` means the workstream is not finished), which is the
   * conservative reading.
   */
  readonly isRunning?: ((workstreamId: string) => boolean) | undefined;
  /** Clock seam (tests). Defaults to `Date.now()`. */
  readonly now?: number | undefined;
}

/** What one housekeeping pass reclaimed. Counts and byte totals only, snapshot contents are never logged. */
export interface OrchestrationSnapshotReapSummary {
  /** Terminal snapshots removed for exceeding {@link TERMINAL_SNAPSHOT_MAX_AGE_MS}. */
  readonly terminalExpired: number;
  /** Terminal snapshots removed for exceeding {@link MAX_TERMINAL_SNAPSHOTS}. */
  readonly terminalOverCap: number;
  /** Quarantine files removed for exceeding {@link QUARANTINE_MAX_AGE_MS}. */
  readonly quarantineExpired: number;
  /** Quarantine files removed for exceeding {@link MAX_QUARANTINE_FILES}. */
  readonly quarantineOverCap: number;
  /** Temp files from interrupted writes removed for exceeding {@link STALE_TEMP_MAX_AGE_MS}. */
  readonly staleTempRemoved: number;
  /** Total bytes freed. */
  readonly bytesReclaimed: number;
  /** Sum of every file count above. Zero means the pass reclaimed nothing. */
  readonly total: number;
}

const EMPTY_REAP_SUMMARY: OrchestrationSnapshotReapSummary = {
  terminalExpired: 0,
  terminalOverCap: 0,
  quarantineExpired: 0,
  quarantineOverCap: 0,
  staleTempRemoved: 0,
  bytesReclaimed: 0,
  total: 0,
};

/** A workstream is finished when no item can still move. Mirrors engine.isTerminalWorkstream. */
function isTerminalItemSet(items: readonly { readonly state: WorkItemState }[]): boolean {
  // An item-less workstream can never run, so it counts as finished rather
  // than pinning a snapshot in the store forever.
  return items.every((item) => item.state === 'passed' || item.state === 'failed');
}

/** Delete a file, treating ENOENT as success (another process may have reaped it first). Returns bytes freed. */
function removeFile(path: string): number {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  try {
    unlinkSync(path);
    return size;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return 0;
    logger.warn('orchestration persistence: failed to remove file during housekeeping', { path, error: summarizeError(error) });
    return 0;
  }
}

interface DatedFile {
  readonly path: string;
  readonly at: number;
}

/**
 * Reap the orchestration snapshot directory: terminal snapshots past their TTL
 * or over the count cap, quarantine files past theirs, and temp files left by
 * an interrupted write.
 *
 * Idempotent, a second pass immediately after a first reclaims nothing, and
 * safe to run from two processes at once: every removal tolerates ENOENT, so
 * losing a race is a no-op rather than an error.
 */
export function reapOrchestrationSnapshots(projectRoot: string, options?: SnapshotReapOptions): OrchestrationSnapshotReapSummary {
  const dir = orchestrationDir(projectRoot);
  if (!existsSync(dir)) return EMPTY_REAP_SUMMARY;
  const now = options?.now ?? Date.now();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    logger.warn('orchestration persistence: failed to list snapshot directory for housekeeping', { dir, error: summarizeError(error) });
    return EMPTY_REAP_SUMMARY;
  }

  const terminal: DatedFile[] = [];
  const quarantined: DatedFile[] = [];
  let staleTempRemoved = 0;
  let bytesReclaimed = 0;

  for (const entry of entries) {
    const path = join(dir, entry);

    if (entry.endsWith(TEMP_SUFFIX)) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > STALE_TEMP_MAX_AGE_MS) {
        const freed = removeFile(path);
        if (!existsSync(path)) {
          staleTempRemoved += 1;
          bytesReclaimed += freed;
        }
      }
      continue;
    }

    if (entry.endsWith(QUARANTINE_SUFFIX)) {
      try {
        quarantined.push({ path, at: statSync(path).mtimeMs });
      } catch {
        // Vanished between readdir and stat: another process already reaped it.
      }
      continue;
    }

    if (!entry.endsWith('.json')) continue;

    const workstreamId = entry.slice(0, -'.json'.length);
    if (options?.isRunning?.(workstreamId) === true) continue;

    // Decide terminal-ness by CONTENT: a snapshot that does not parse or does
    // not validate is left alone here so loadWorkstreamSnapshot can quarantine
    // it with its existing disclosure, rather than being deleted outright.
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const snapshot = deserializeWorkstreamSnapshot(text);
    if (snapshot === null) continue;
    // deserializeWorkstreamSnapshot validates the envelope, not every field, so
    // the item list is re-checked here rather than assumed.
    const items: unknown = snapshot.workstream.items;
    if (!Array.isArray(items) || !isTerminalItemSet(items as readonly { readonly state: WorkItemState }[])) continue;
    const writtenAt = typeof snapshot.writtenAt === 'number' && Number.isFinite(snapshot.writtenAt) ? snapshot.writtenAt : 0;
    terminal.push({ path, at: writtenAt });
  }

  let terminalExpired = 0;
  const withinTtl: DatedFile[] = [];
  for (const file of terminal) {
    if (now - file.at > TERMINAL_SNAPSHOT_MAX_AGE_MS) {
      bytesReclaimed += removeFile(file.path);
      terminalExpired += 1;
      continue;
    }
    withinTtl.push(file);
  }

  let terminalOverCap = 0;
  if (withinTtl.length > MAX_TERMINAL_SNAPSHOTS) {
    const oldestFirst = [...withinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, withinTtl.length - MAX_TERMINAL_SNAPSHOTS)) {
      bytesReclaimed += removeFile(file.path);
      terminalOverCap += 1;
    }
  }

  let quarantineExpired = 0;
  const quarantineWithinTtl: DatedFile[] = [];
  for (const file of quarantined) {
    if (now - file.at > QUARANTINE_MAX_AGE_MS) {
      bytesReclaimed += removeFile(file.path);
      quarantineExpired += 1;
      continue;
    }
    quarantineWithinTtl.push(file);
  }

  let quarantineOverCap = 0;
  if (quarantineWithinTtl.length > MAX_QUARANTINE_FILES) {
    const oldestFirst = [...quarantineWithinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, quarantineWithinTtl.length - MAX_QUARANTINE_FILES)) {
      bytesReclaimed += removeFile(file.path);
      quarantineOverCap += 1;
    }
  }

  const total = terminalExpired + terminalOverCap + quarantineExpired + quarantineOverCap + staleTempRemoved;
  const summary: OrchestrationSnapshotReapSummary = {
    terminalExpired,
    terminalOverCap,
    quarantineExpired,
    quarantineOverCap,
    staleTempRemoved,
    bytesReclaimed,
    total,
  };

  if (total > 0) {
    logger.info('orchestration persistence: reclaimed snapshot files', {
      dir,
      terminalExpired,
      terminalOverCap,
      quarantineExpired,
      quarantineOverCap,
      staleTempRemoved,
      bytesReclaimed,
      total,
    });
  }
  return summary;
}

/**
 * Debounced trailing writer (250ms, exactly like wrfc-persistence.ts
 * DEBOUNCE_MS), subscribing to engine lifecycle events. Returns an
 * unsubscribe function that also flushes any pending timers.
 *
 * Also owns the PERIODIC housekeeping pass: an engine can stay attached for
 * days, so reaping only at resume would let a long-lived process accumulate
 * finished snapshots for its whole lifetime. The interval timer is unref'd, so
 * it never keeps a process alive, and it is cleared by the returned detach
 * function.
 *
 * @param sweepIntervalMs - Housekeeping interval; `0` disables the timer (tests, short-lived hosts).
 */
export function attachDebouncedWriter(
  projectRoot: string,
  getWorkstream: (workstreamId: string) => Workstream | null,
  getCompletedResults: (workstreamId: string) => readonly PhaseResult[],
  subscribe: (listener: (event: OrchestrationEvent) => void) => () => void,
  sweepIntervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // A workstream the engine still holds AND that has not finished is exempt
  // from every bound, its snapshot is the resume point.
  const isRunning = (workstreamId: string): boolean => {
    const workstream = getWorkstream(workstreamId);
    return workstream !== null && !isTerminalItemSet(workstream.items);
  };

  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      reapOrchestrationSnapshots(projectRoot, { isRunning });
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function scheduleWrite(workstreamId: string): void {
    const existing = timers.get(workstreamId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(workstreamId);
      const workstream = getWorkstream(workstreamId);
      if (!workstream) return;
      writeWorkstreamSnapshot(projectRoot, workstream, getCompletedResults(workstreamId));
    }, DEBOUNCE_MS);
    timer.unref?.();
    timers.set(workstreamId, timer);
  }

  const unsubscribe = subscribe((event) => {
    // 'dirty-tree-at-launch' (see CHANGELOG 0.38.0) is engine-wide, not
    // workstream-scoped, it has no workstreamId to schedule a write for.
    if (event.type === 'dirty-tree-at-launch') return;
    scheduleWrite(event.workstreamId);
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}
