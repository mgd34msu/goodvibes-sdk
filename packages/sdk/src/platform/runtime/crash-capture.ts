/**
 * Crash capture — the last durable trace a surface writes before an uncaught
 * fault takes the process down.
 *
 * Why this exists: an agent process died on an uncaught exception and the
 * stack existed ONLY on the operator's terminal. Nothing reached the activity
 * log, and no crash file was written; the stack was recovered afterwards only
 * because a terminal pane happened to have been captured. A fault that leaves
 * no durable trace is a fault nobody can diagnose after the fact.
 *
 * What lands: one JSON record per fault carrying the stack, the surface
 * version, the pid, the session that was active at the moment of the fault,
 * and the timestamp — the five fields forensics actually needed and did not
 * have.
 *
 * Persisted-state doctrine (bounded / content-validated / disclosed):
 *  - Bounded twice. `appendCrashRecord` keeps at most
 *    {@link CRASH_LOG_MAX_RECORDS} records, dropping oldest-first at write
 *    time, and the store also registers with the append-only retention
 *    registry so the existing janitor enforces the age and total-size caps.
 *    An append-only file nobody prunes is a leak with a nicer name.
 *  - Content-validated. `readCrashRecords` parses and shape-checks every line
 *    and SKIPS anything torn or malformed rather than throwing. A crash log is
 *    written by a process that is in the act of dying, so a half-written last
 *    line is an expected state, not a corruption to escalate.
 *  - Redacted. Every line is credential-redacted before it lands, because a
 *    stack or an error message can carry a token in an argument.
 *
 * The write path is deliberately synchronous. It runs from an
 * `uncaughtException` handler where the process is about to exit, so a
 * promise-based write would lose the race with `process.exit`.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { redactAtRestLine } from './at-rest-persistence.js';

/** Which process-level fault produced a record. */
export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/** Filename of the crash log within a surface's home-anchored root. */
export const CRASH_LOG_FILENAME = 'crashes.jsonl';

/**
 * Count cap on retained crash records. Small on purpose: the newest crashes
 * are the ones under investigation, and this file is read by a human, not a
 * query engine. Age and total-size caps come from the retention registry on
 * top of this.
 */
export const CRASH_LOG_MAX_RECORDS = 25;

/**
 * Cap on a single record's stack text. A runaway recursive stack can be
 * megabytes; truncating keeps one pathological crash from consuming the whole
 * store's size budget and evicting the history around it.
 */
export const CRASH_STACK_MAX_CHARS = 8_000;

/** One captured process-level fault. */
export interface CrashRecord {
  /** ISO-8601 UTC timestamp of the fault. */
  readonly timestamp: string;
  /** Which process-level fault fired. */
  readonly kind: CrashKind;
  /** The error's message, or a stringified non-Error throw value. */
  readonly message: string;
  /** The stack, truncated to {@link CRASH_STACK_MAX_CHARS}; null when absent. */
  readonly stack: string | null;
  /** Surface version the fault happened on. */
  readonly version: string;
  /** Process id that faulted. */
  readonly pid: number;
  /** Session active at the moment of the fault; null when none was active. */
  readonly sessionId: string | null;
  /** Surface that faulted, e.g. `'agent'`. */
  readonly surface: string;
}

/** Inputs for {@link buildCrashRecord} other than the thrown value itself. */
export interface CrashContext {
  readonly version: string;
  readonly surface: string;
  readonly sessionId: string | null;
  readonly pid?: number;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

function truncateStack(stack: string): string {
  if (stack.length <= CRASH_STACK_MAX_CHARS) return stack;
  return `${stack.slice(0, CRASH_STACK_MAX_CHARS)}\n… stack truncated at ${CRASH_STACK_MAX_CHARS} characters`;
}

/**
 * Build a crash record from a thrown value. Never throws: a crash handler that
 * itself throws loses the very report it exists to produce, so every field
 * extraction is defensive against exotic throw values (a Proxy whose `message`
 * getter throws, a null prototype object, a bare string).
 */
export function buildCrashRecord(kind: CrashKind, thrown: unknown, context: CrashContext): CrashRecord {
  let message: string;
  let stack: string | null = null;
  try {
    if (thrown instanceof Error) {
      message = thrown.message;
      stack = typeof thrown.stack === 'string' ? truncateStack(thrown.stack) : null;
    } else {
      message = String(thrown);
    }
  } catch {
    message = '<unrepresentable throw value>';
  }
  return {
    timestamp: (context.now?.() ?? new Date()).toISOString(),
    kind,
    message,
    stack,
    version: context.version,
    pid: context.pid ?? process.pid,
    sessionId: context.sessionId,
    surface: context.surface,
  };
}

function isCrashRecord(value: unknown): value is CrashRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['timestamp'] === 'string' &&
    (record['kind'] === 'uncaughtException' || record['kind'] === 'unhandledRejection') &&
    typeof record['message'] === 'string' &&
    (record['stack'] === null || typeof record['stack'] === 'string') &&
    typeof record['version'] === 'string' &&
    typeof record['pid'] === 'number' &&
    (record['sessionId'] === null || typeof record['sessionId'] === 'string') &&
    typeof record['surface'] === 'string'
  );
}

/**
 * Read every well-formed record from a crash log, oldest first.
 *
 * Content-validated, never existence-validated: a line that does not parse or
 * does not carry the record shape is skipped, so one torn tail line (the
 * normal outcome of crashing mid-write) still yields every record before it.
 * A missing or unreadable file reads as an empty history.
 */
export function readCrashRecords(filePath: string): CrashRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const records: CrashRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isCrashRecord(parsed)) records.push(parsed);
  }
  return records;
}

/**
 * Append one crash record, enforcing the count cap.
 *
 * Fast path is a plain O_APPEND write — a single small line, which is the
 * cheapest thing that can land from a dying process. The rewrite that enforces
 * {@link CRASH_LOG_MAX_RECORDS} only runs once the file has actually grown
 * past the cap, and goes through `writeFileAtomic` so a crash during the
 * trim cannot leave a truncated log.
 *
 * Best-effort by contract: returns `false` instead of throwing when the write
 * fails. The caller is an exit-boundary handler whose remaining duty (stderr,
 * activity log, exit code) must still run on a read-only or full disk.
 */
export function appendCrashRecord(filePath: string, record: CrashRecord): boolean {
  const line = `${redactAtRestLine(JSON.stringify(record))}\n`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line, { mode: 0o600 });
  } catch {
    return false;
  }
  try {
    // Cheap guard: only pay for a read+rewrite once the file could plausibly
    // hold more than the cap. An average record is well under 1 KiB.
    const size = statSync(filePath).size;
    if (size < CRASH_LOG_MAX_RECORDS * 1024) return true;
    const records = readCrashRecords(filePath);
    if (records.length <= CRASH_LOG_MAX_RECORDS) return true;
    const kept = records.slice(records.length - CRASH_LOG_MAX_RECORDS);
    const contents = kept.map((entry) => `${redactAtRestLine(JSON.stringify(entry))}\n`).join('');
    writeFileAtomic(filePath, contents, { mode: 0o600 });
  } catch {
    // The record itself already landed; failing to trim is not worth losing it.
    return true;
  }
  return true;
}
