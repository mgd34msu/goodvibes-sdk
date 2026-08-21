/**
 * store.ts, persistence for the trigger family, with recovery housekeeping.
 *
 * Anything persisted across restarts and crashes has to do real housekeeping at
 * recovery, not just load. This store does all five:
 *
 *   1. Reap on recovery, triggers whose owning session is gone are removed,
 *      and a one-shot on-exit trigger that already fired retires itself.
 *   2. Bound everything, count cap AND age TTL on run history, observations
 *      and the shared event log. An unbounded append-only store is a leak with
 *      a nicer name.
 *   3. Validate by content, never by existence, the snapshot carries a
 *      checksum written last; a torn, truncated or zero-filled file fails the
 *      checksum and is quarantined instead of being served as good state.
 *   4. Reap periodically, the supervisor runs the same sweep on a timer,
 *      because a long-lived daemon that only sweeps at boot never sweeps.
 *   5. Disclose what was reaped, every sweep returns a report and the startup
 *      sweep writes `triggers-reaped.json`. Silent deletion is indistinguishable
 *      from data loss.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * leaves the previous good snapshot rather than a half-written one.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveSharedDirectory } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type {
  TriggerActionGrant,
  TriggerEventLogEntry,
  TriggerRecord,
  TriggerRecoveryReport,
} from './types.js';

export const TRIGGER_STORE_VERSION = 1;

export interface TriggerStoreSnapshot {
  readonly version: typeof TRIGGER_STORE_VERSION;
  readonly daemonBootId: string;
  readonly savedAt: number;
  readonly triggers: readonly TriggerRecord[];
  readonly grants: readonly TriggerActionGrant[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  /** sha256 over the canonical body, written last. Absent = torn write. */
  readonly checksum: string;
}

export interface TriggerRetentionPolicy {
  readonly observationRingSize: number;
  readonly runHistoryLimit: number;
  readonly runHistoryTtlMs: number;
  readonly eventLogLimit: number;
  readonly eventLogTtlMs: number;
}

export const DEFAULT_RETENTION: TriggerRetentionPolicy = {
  observationRingSize: 200,
  runHistoryLimit: 50,
  runHistoryTtlMs: 168 * 60 * 60 * 1000,
  eventLogLimit: 500,
  eventLogTtlMs: 24 * 60 * 60 * 1000,
};

export function getTriggerStorePath(rootPath: string): string {
  return resolveSharedDirectory(rootPath, 'triggers.json');
}

export function getTriggerReapReportPath(storePath: string): string {
  return join(dirname(storePath), 'triggers-reaped.json');
}

interface SnapshotBody {
  readonly version: number;
  readonly daemonBootId: string;
  readonly savedAt: number;
  readonly triggers: readonly TriggerRecord[];
  readonly grants: readonly TriggerActionGrant[];
  readonly eventLog: readonly TriggerEventLogEntry[];
}

/** Canonical serialisation the checksum is computed over. Key order is fixed. */
function canonicalBody(body: SnapshotBody): string {
  return JSON.stringify({
    version: body.version,
    daemonBootId: body.daemonBootId,
    savedAt: body.savedAt,
    triggers: body.triggers,
    grants: body.grants,
    eventLog: body.eventLog,
  });
}

export function checksumOf(body: SnapshotBody): string {
  return createHash('sha256').update(canonicalBody(body)).digest('hex');
}

/**
 * Content validation. `existsSync` proves nothing: a crashed run can leave a
 * full-size file of zeros that an existence check happily treats as complete.
 * We re-derive the checksum and require every record to parse into shape.
 */
export function validateSnapshot(parsed: unknown): TriggerStoreSnapshot | { readonly invalid: string } {
  if (typeof parsed !== 'object' || parsed === null) return { invalid: 'snapshot is not an object' };
  const snapshot = parsed as Partial<TriggerStoreSnapshot>;
  if (snapshot.version !== TRIGGER_STORE_VERSION) {
    return { invalid: `unsupported snapshot version ${String(snapshot.version)}` };
  }
  if (typeof snapshot.checksum !== 'string' || snapshot.checksum.length !== 64) {
    return { invalid: 'snapshot has no checksum, the write did not complete' };
  }
  if (!Array.isArray(snapshot.triggers) || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.eventLog)) {
    return { invalid: 'snapshot collections are missing or not arrays' };
  }
  const body: SnapshotBody = {
    version: snapshot.version,
    daemonBootId: typeof snapshot.daemonBootId === 'string' ? snapshot.daemonBootId : '',
    savedAt: typeof snapshot.savedAt === 'number' ? snapshot.savedAt : 0,
    triggers: snapshot.triggers,
    grants: snapshot.grants,
    eventLog: snapshot.eventLog,
  };
  if (checksumOf(body) !== snapshot.checksum) {
    return { invalid: 'snapshot checksum mismatch, the file is torn, truncated or was written by a crashed run' };
  }
  const malformed = snapshot.triggers.filter((record) => !isWellFormedRecord(record));
  if (malformed.length > 0) {
    return { invalid: `${malformed.length} trigger record(s) failed shape validation` };
  }
  return {
    version: TRIGGER_STORE_VERSION,
    daemonBootId: body.daemonBootId,
    savedAt: body.savedAt,
    triggers: snapshot.triggers,
    grants: snapshot.grants,
    eventLog: snapshot.eventLog,
    checksum: snapshot.checksum,
  };
}

function isWellFormedRecord(record: unknown): record is TriggerRecord {
  if (typeof record !== 'object' || record === null) return false;
  const candidate = record as Partial<TriggerRecord>;
  const definition = candidate.definition;
  if (typeof definition !== 'object' || definition === null) return false;
  if (typeof definition.id !== 'string' || definition.id.length === 0) return false;
  if (typeof definition.spec !== 'object' || definition.spec === null) return false;
  if (typeof definition.action !== 'object' || definition.action === null) return false;
  if (!Array.isArray(candidate.observations) || !Array.isArray(candidate.runs)) return false;
  if (typeof candidate.strikes !== 'number' || typeof candidate.firedCount !== 'number') return false;
  return true;
}

export function saveTriggerSnapshot(
  storePath: string,
  input: {
    readonly daemonBootId: string;
    readonly triggers: readonly TriggerRecord[];
    readonly grants: readonly TriggerActionGrant[];
    readonly eventLog: readonly TriggerEventLogEntry[];
    readonly now?: number | undefined;
  },
): void {
  const body: SnapshotBody = {
    version: TRIGGER_STORE_VERSION,
    daemonBootId: input.daemonBootId,
    savedAt: input.now ?? Date.now(),
    triggers: [...input.triggers].sort((a, b) => a.definition.id.localeCompare(b.definition.id)),
    grants: [...input.grants].sort((a, b) => a.id.localeCompare(b.id)),
    eventLog: [...input.eventLog].sort((a, b) => a.at - b.at || a.triggerId.localeCompare(b.triggerId)),
  };
  const snapshot: TriggerStoreSnapshot = { ...body, version: TRIGGER_STORE_VERSION, checksum: checksumOf(body) };
  mkdirSync(dirname(storePath), { recursive: true });
  const temp = `${storePath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
  renameSync(temp, storePath);
}

export interface LoadedTriggerStore {
  readonly snapshot: TriggerStoreSnapshot | null;
  /** Set when the on-disk state failed content validation and was set aside. */
  readonly quarantined?: string | undefined;
}

/**
 * Loads and content-validates. A file that fails validation is renamed aside
 * rather than deleted (so it can be inspected) and the caller starts clean.
 */
export function loadTriggerSnapshot(storePath: string): LoadedTriggerStore {
  if (!existsSync(storePath)) return { snapshot: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as unknown;
  } catch (error) {
    return { snapshot: null, quarantined: quarantine(storePath, `unparseable: ${summarizeError(error)}`) };
  }
  const validated = validateSnapshot(parsed);
  if ('invalid' in validated) {
    return { snapshot: null, quarantined: quarantine(storePath, validated.invalid) };
  }
  return { snapshot: validated };
}

function quarantine(storePath: string, reason: string): string {
  const target = `${storePath}.corrupt-${Date.now()}`;
  try {
    renameSync(storePath, target);
  } catch (error) {
    logger.warn('Trigger store quarantine rename failed', { storePath, error: summarizeError(error) });
    try {
      unlinkSync(storePath);
    } catch {
      // Leaving the bad file in place is still better than serving it.
    }
  }
  logger.warn('Trigger store failed content validation and was set aside', { storePath, target, reason });
  return `${reason} (moved to ${target})`;
}

// ─── Bounding ─────────────────────────────────────────────────────────────────

export interface BoundResult {
  readonly record: TriggerRecord;
  readonly runsReaped: number;
  readonly observationsReaped: number;
}

/** Applies the count cap AND the age TTL to one record's retained state. */
export function boundRecord(record: TriggerRecord, policy: TriggerRetentionPolicy, now: number): BoundResult {
  const runCutoff = now - policy.runHistoryTtlMs;
  const keptRuns = record.runs
    .filter((run) => run.at >= runCutoff)
    .slice(-policy.runHistoryLimit);
  const keptObservations = record.observations.slice(-policy.observationRingSize);
  const runsReaped = record.runs.length - keptRuns.length;
  const observationsReaped = record.observations.length - keptObservations.length;
  if (runsReaped === 0 && observationsReaped === 0) {
    return { record, runsReaped: 0, observationsReaped: 0 };
  }
  return {
    record: { ...record, runs: keptRuns, observations: keptObservations },
    runsReaped,
    observationsReaped,
  };
}

export function boundEventLog(
  eventLog: readonly TriggerEventLogEntry[],
  policy: TriggerRetentionPolicy,
  now: number,
): { readonly eventLog: readonly TriggerEventLogEntry[]; readonly reaped: number } {
  const cutoff = now - policy.eventLogTtlMs;
  const kept = eventLog.filter((entry) => entry.at >= cutoff).slice(-policy.eventLogLimit);
  return { eventLog: kept, reaped: eventLog.length - kept.length };
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

export interface SweepInput {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly policy: TriggerRetentionPolicy;
  readonly now: number;
  readonly reason: 'startup' | 'sweep';
  /** Returns false when the session that created a trigger no longer exists. */
  readonly sessionIsLive?: ((sessionId: string) => boolean) | undefined;
  /** Returns false when a tracked child process is no longer running. */
  readonly processIsLive?: ((pid: number, startedAt: number) => boolean) | undefined;
  readonly quarantined?: string | undefined;
}

export interface SweepResult {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly report: TriggerRecoveryReport;
}

/**
 * The recovery sweep. Idempotent and safe to run concurrently from more than
 * one process: it only ever removes records that are already terminal or whose
 * owner is provably gone, and running it twice produces the same result.
 */
export function sweepTriggers(input: SweepInput): SweepResult {
  const { policy, now } = input;
  const kept: TriggerRecord[] = [];
  const reapedIds: string[] = [];
  const orphanedProcesses: string[] = [];
  let runsReaped = 0;
  let observationsReaped = 0;

  for (const record of input.triggers) {
    // A malformed record must not take the sweep down: recovery is exactly
    // when the store is most likely to hold something torn, and a crash here
    // would leave every OTHER record unreaped and unbounded too.
    if (!isWellFormedRecord(record)) {
      const id = (record as Partial<TriggerRecord>)?.definition?.id;
      reapedIds.push(typeof id === 'string' && id.length > 0 ? id : '<malformed record>');
      continue;
    }
    const owner = record.definition.ownerSessionId;
    if (owner && input.sessionIsLive && !input.sessionIsLive(owner)) {
      reapedIds.push(record.definition.id);
      continue;
    }
    // A one-shot on-exit trigger retires once it has fired: keeping it would
    // mean a second fire on the next load.
    if (record.definition.spec.kind === 'on-exit' && (record.state === 'fired' || record.state === 'cancelled')) {
      reapedIds.push(record.definition.id);
      continue;
    }
    if (record.process && input.processIsLive && !input.processIsLive(record.process.pid, record.process.startedAt)) {
      orphanedProcesses.push(record.process.processId);
    }
    const bounded = boundRecord(record, policy, now);
    runsReaped += bounded.runsReaped;
    observationsReaped += bounded.observationsReaped;
    kept.push(bounded.record);
  }

  const boundedLog = boundEventLog(input.eventLog, policy, now);

  return {
    triggers: kept,
    eventLog: boundedLog.eventLog,
    report: {
      at: now,
      reason: input.reason,
      triggersLoaded: input.triggers.length,
      triggersReaped: reapedIds.length,
      reapedIds,
      runsReaped,
      observationsReaped,
      eventsReaped: boundedLog.reaped,
      orphanedProcesses,
      ...(input.quarantined ? { quarantined: input.quarantined } : {}),
    },
  };
}

/**
 * Discloses the sweep. Mirrors the checkpoint adoption path's
 * `checkpoints-moved.json`: whatever was removed is written down where a person
 * can find it, so a reap never looks like data loss.
 */
export function writeReapReport(storePath: string, report: TriggerRecoveryReport): void {
  if (
    report.triggersReaped === 0
    && report.runsReaped === 0
    && report.observationsReaped === 0
    && report.eventsReaped === 0
    && report.orphanedProcesses.length === 0
    && !report.quarantined
  ) {
    return;
  }
  const path = getTriggerReapReportPath(storePath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    let history: TriggerRecoveryReport[] = [];
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
        if (Array.isArray(parsed)) history = parsed as TriggerRecoveryReport[];
      } catch {
        history = [];
      }
    }
    history.push(report);
    writeFileSync(path, `${JSON.stringify(history.slice(-50), null, 2)}\n`, 'utf-8');
  } catch (error) {
    logger.warn('Trigger reap report write failed', { path, error: summarizeError(error) });
  }
}
