/**
 * store.ts, durable state for hosted sessions.
 *
 * A hosted session that is allowed to survive a client's departure must also
 * survive the daemon restarting, or "survive-detach" means "survives until the
 * next update swaps the binary". So the record and its conversation are written
 * to disk, and the platform's standing treatment for anything persisted applies
 * in full:
 *
 *  - BOUNDS. At most `maxSessions` session files, and at most
 *    `maxMessagesPerSession` messages kept per file (the TAIL is kept: a
 *    conversation's recent turns are what a reattach needs). A session's file
 *    cannot grow without limit, and the directory cannot either.
 *  - CONTENT VALIDATION. Every file is validated on load against the shape the
 *    engine can actually rebuild from. A file that fails is not silently
 *    dropped and not half-restored: it is counted, named in the restore report,
 *    and moved aside with a `.rejected` suffix so it can be inspected rather
 *    than lost.
 *  - SWEEP. Terminated sessions are retired once they are older than
 *    `terminatedRetentionMs`; the sweep runs at init and on a timer.
 *  - DISCLOSURE. `load()` returns exactly what happened, restored, rejected,
 *    swept, and truncated counts, so the manager can state it rather than the
 *    numbers living only in a log line nobody reads.
 *
 * Writes are atomic (tmp file + rename), so a crash mid-write leaves the
 * previous good file rather than a truncated one.
 */

import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { HostedSessionRecord } from './types.js';

/** The on-disk envelope. `version` is checked, not assumed. */
export interface PersistedHostedSession {
  readonly version: 1;
  readonly record: HostedSessionRecord;
  /** `ConversationManager.toJSON()`, replayed through `fromJSON` on restore. */
  readonly conversation: unknown;
}

/** Bounds and retention, all configurable. */
export interface HostedSessionStoreLimits {
  /** Hard cap on persisted session files. Oldest terminated go first, then oldest idle. */
  readonly maxSessions: number;
  /** Hard cap on messages persisted per session; the tail is kept. */
  readonly maxMessagesPerSession: number;
  /** How long a terminated session's record is kept before it is retired. */
  readonly terminatedRetentionMs: number;
}

/** What a load pass actually did, the disclosure half of the doctrine. */
export interface HostedSessionLoadReport {
  readonly restored: readonly PersistedHostedSession[];
  /** Files that failed validation, by filename, with the reason. */
  readonly rejected: readonly { readonly file: string; readonly reason: string }[];
  /** Sessions retired by the retention sweep, by id. */
  readonly swept: readonly string[];
  /** Sessions dropped because the directory was over `maxSessions`, by id. */
  readonly evicted: readonly string[];
}

const SESSION_FILE_SUFFIX = '.json';
const REJECTED_SUFFIX = '.rejected';
/** Ids are file names; anything that could escape the directory is refused. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one loaded file against the shape the engine can rebuild from.
 * Returns the reason it is unusable, or null when it is usable.
 */
export function describeInvalidPersistedHostedSession(value: unknown): string | null {
  if (!isRecordObject(value)) return 'not a JSON object';
  if (value['version'] !== 1) return `unsupported version ${String(value['version'])}`;
  const record = value['record'];
  if (!isRecordObject(record)) return 'missing the session record';
  const id = record['id'];
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return 'the session id is missing or not a safe file name';
  if (typeof record['workspaceRoot'] !== 'string' || record['workspaceRoot'].length === 0) {
    return 'the workspace root is missing';
  }
  const status = record['status'];
  if (status !== 'idle' && status !== 'running' && status !== 'terminated') {
    return `unknown session status ${String(status)}`;
  }
  if (typeof record['createdAt'] !== 'number' || typeof record['updatedAt'] !== 'number') {
    return 'the record has no usable timestamps';
  }
  return null;
}

/** Keep the last `max` entries of a message array. Returns the kept slice. */
export function boundMessages(messages: readonly unknown[], max: number): readonly unknown[] {
  if (max <= 0 || messages.length <= max) return messages;
  return messages.slice(messages.length - max);
}

/**
 * The disk store. One directory, one file per session, atomic writes.
 */
export class HostedSessionStore {
  constructor(
    private readonly directory: string,
    private readonly limits: HostedSessionStoreLimits,
  ) {}

  /** The directory this store owns, for status reporting. */
  path(): string {
    return this.directory;
  }

  private ensureDir(): void {
    mkdirSync(this.directory, { recursive: true });
  }

  private fileFor(sessionId: string): string {
    return join(this.directory, `${sessionId}${SESSION_FILE_SUFFIX}`);
  }

  /**
   * Load every persisted session, sweeping retired ones and rejecting
   * unusable files. Never throws: an unreadable directory is an empty load
   * with the reason logged.
   */
  async load(now: number = Date.now()): Promise<HostedSessionLoadReport> {
    const restored: PersistedHostedSession[] = [];
    const rejected: { file: string; reason: string }[] = [];
    const swept: string[] = [];
    const evicted: string[] = [];
    let entries: string[];
    try {
      this.ensureDir();
      entries = (await fs.readdir(this.directory)).filter((name) => name.endsWith(SESSION_FILE_SUFFIX));
    } catch (error) {
      logger.warn('[hosted-sessions] the session directory could not be read; starting with none', {
        directory: this.directory,
        error: summarizeError(error),
      });
      return { restored, rejected, swept, evicted };
    }

    for (const file of entries) {
      const full = join(this.directory, file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fs.readFile(full, 'utf-8')) as unknown;
      } catch (error) {
        rejected.push({ file, reason: `unreadable: ${summarizeError(error)}` });
        await this.setAside(full);
        continue;
      }
      const problem = describeInvalidPersistedHostedSession(parsed);
      if (problem) {
        rejected.push({ file, reason: problem });
        await this.setAside(full);
        continue;
      }
      const session = parsed as PersistedHostedSession;
      if (this.isRetired(session.record, now)) {
        swept.push(session.record.id);
        await this.delete(session.record.id);
        continue;
      }
      restored.push(session);
    }

    // Bound the directory. Terminated sessions go first (they are history),
    // then the least recently updated, never a session that is still live in
    // this process, because load runs before any session is composed.
    if (restored.length > this.limits.maxSessions) {
      const ordered = [...restored].sort((a, b) => rankForEviction(a.record) - rankForEviction(b.record));
      const overflow = ordered.slice(0, ordered.length - this.limits.maxSessions);
      for (const session of overflow) {
        evicted.push(session.record.id);
        await this.delete(session.record.id);
      }
      const dropped = new Set(overflow.map((session) => session.record.id));
      return {
        restored: restored.filter((session) => !dropped.has(session.record.id)),
        rejected,
        swept,
        evicted,
      };
    }
    return { restored, rejected, swept, evicted };
  }

  /** Whether a terminated record has outlived its retention. */
  private isRetired(record: HostedSessionRecord, now: number): boolean {
    if (record.status !== 'terminated') return false;
    const at = record.terminatedAt ?? record.updatedAt;
    return now - at > this.limits.terminatedRetentionMs;
  }

  /**
   * Move an unusable file aside instead of deleting it. A rejected file the
   * operator can still read is the difference between "the engine told me it
   * dropped one and where it is" and "a session disappeared".
   */
  private async setAside(fullPath: string): Promise<void> {
    try {
      await fs.rename(fullPath, `${fullPath}${REJECTED_SUFFIX}`);
    } catch (error) {
      logger.warn('[hosted-sessions] an unusable session file could not be moved aside', {
        file: fullPath,
        error: summarizeError(error),
      });
    }
  }

  /** Atomically write one session. Bounds the conversation before writing. */
  async save(record: HostedSessionRecord, conversation: unknown): Promise<void> {
    if (!SAFE_ID.test(record.id)) {
      throw new Error(`Refusing to persist hosted session '${record.id}': the id is not a safe file name.`);
    }
    const bounded = this.boundConversation(conversation);
    const payload: PersistedHostedSession = { version: 1, record, conversation: bounded };
    const file = this.fileFor(record.id);
    const tmp = `${file}.tmp`;
    try {
      this.ensureDir();
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      await fs.rename(tmp, file);
    } catch (error) {
      if (existsSync(tmp)) {
        await fs.unlink(tmp).catch(() => undefined);
      }
      throw new Error(`Persisting hosted session ${record.id} failed: ${summarizeError(error)}`);
    }
  }

  /**
   * Apply the per-session message bound to a `ConversationManager.toJSON()`
   * payload. Unknown shapes pass through untouched, the bound is a cap on a
   * known field, not a rewrite of a payload this store does not understand.
   */
  boundConversation(conversation: unknown): unknown {
    if (!isRecordObject(conversation)) return conversation;
    const messages = conversation['messages'];
    if (!Array.isArray(messages)) return conversation;
    const kept = boundMessages(messages, this.limits.maxMessagesPerSession);
    if (kept.length === messages.length) return conversation;
    return { ...conversation, messages: kept };
  }

  /** Remove one session's file. Absent is success. */
  async delete(sessionId: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(sessionId));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT') return;
      logger.warn('[hosted-sessions] removing a session file failed', {
        sessionId,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Retire terminated sessions past their retention. Returns the ids retired,
   * so the caller can drop them from its own map and say so.
   */
  async sweep(records: Iterable<HostedSessionRecord>, now: number = Date.now()): Promise<readonly string[]> {
    const retired: string[] = [];
    for (const record of records) {
      if (!this.isRetired(record, now)) continue;
      retired.push(record.id);
      await this.delete(record.id);
    }
    return retired;
  }
}

/** Lower ranks are evicted first: terminated before live, older before newer. */
function rankForEviction(record: HostedSessionRecord): number {
  const terminatedBias = record.status === 'terminated' ? 0 : 1e15;
  return terminatedBias + record.updatedAt;
}
