/**
 * offset-store.ts — the Telegram getUpdates offset, persisted across restarts.
 *
 * Telegram's long-poll queue is confirmation-based: an update stays queued
 * until a getUpdates call passes an `offset` greater than its `update_id`.
 * That offset is therefore the daemon's read cursor, and it MUST outlive the
 * process. Without persistence every restart either replays the whole retained
 * backlog (re-spawning agents for work already done) or skips it (silently
 * dropping messages) — the two failure modes this file exists to prevent.
 *
 * Housekeeping posture for state that survives crashes:
 *   bound    — a fixed-size, single-record file; refuse to parse anything
 *              larger than MAX_FILE_BYTES rather than loading whatever is there
 *   validate — by CONTENT, not by existence: a file that exists is not evidence
 *              it is intact, so the parsed record must be the right shape with a
 *              plausible integer cursor
 *   sweep    — a torn or nonsense file is deleted, not left to fail every boot
 *   disclose — every recovery decision is logged with the reason, because a
 *              cursor that silently moved is indistinguishable from lost mail
 *   write    — temp file + rename, so a crash mid-write cannot tear the record
 *              in the first place
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Refuse to parse a cursor file larger than this; it is one small record. */
const MAX_FILE_BYTES = 4_096;
const RECORD_VERSION = 1;

/**
 * What the store found on disk, and therefore how the poller must start.
 *
 * - `resume`   — a valid cursor; continue exactly where the last run stopped.
 * - `fresh`    — no cursor file at all (first run, or the surface was just
 *                enabled). Start with NO offset so Telegram hands over its
 *                retained backlog. This is deliberate: a user who sends /start
 *                before the daemon is running must still be answered, which is
 *                precisely the case that made the missing ingress path visible.
 * - `skip-ahead` — the cursor file existed but was torn or implausible. We
 *                cannot know which updates were already dispatched, so the
 *                poller jumps to the newest update instead of replaying.
 *                Rationale: replaying spawns duplicate agents that do real work
 *                on the user's machine and send duplicate messages, whereas
 *                skipping loses at most the messages sent since the crash —
 *                which the user can see went unanswered and can resend.
 *                Duplicated autonomous work is the worse failure.
 */
export type TelegramOffsetStart =
  | { readonly mode: 'resume'; readonly offset: number }
  | { readonly mode: 'fresh' }
  | { readonly mode: 'skip-ahead'; readonly reason: string };

interface OffsetRecord {
  readonly version: number;
  readonly offset: number;
  readonly updatedAt: string;
}

function isPlausibleOffset(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

export class TelegramOffsetStore {
  constructor(private readonly filePath: string) {}

  /**
   * Read the cursor and decide how to start. Never throws: a store that cannot
   * be read must degrade to a stated recovery mode, not stop ingress.
   */
  load(): TelegramOffsetStart {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      logger.info('Telegram offset store: no cursor found; starting from the retained backlog', {
        path: this.filePath,
      });
      return { mode: 'fresh' };
    }

    if (size > MAX_FILE_BYTES) {
      return this.sweep(`cursor file is ${size} bytes, over the ${MAX_FILE_BYTES}-byte bound`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown;
    } catch (error) {
      return this.sweep(`cursor file is not valid JSON (${summarizeError(error)})`);
    }

    const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    if (!record) return this.sweep('cursor file does not contain a record');
    if (record.version !== RECORD_VERSION) {
      return this.sweep(`cursor file has unsupported version ${String(record.version)}`);
    }
    if (!isPlausibleOffset(record.offset)) {
      return this.sweep(`cursor file has an implausible offset (${String(record.offset)})`);
    }

    logger.info('Telegram offset store: resuming from persisted cursor', {
      path: this.filePath,
      offset: record.offset,
    });
    return { mode: 'resume', offset: record.offset };
  }

  /**
   * Persist the cursor. Called after a batch is fully processed, so an update
   * is only confirmed once the work it triggered has been handed off — a crash
   * mid-batch replays that batch rather than losing it.
   */
  save(offset: number): void {
    if (!isPlausibleOffset(offset)) {
      logger.warn('Telegram offset store: refusing to persist an implausible offset', { offset });
      return;
    }
    const record: OffsetRecord = {
      version: RECORD_VERSION,
      offset,
      updatedAt: new Date().toISOString(),
    };
    const temp = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(temp, JSON.stringify(record), 'utf-8');
      renameSync(temp, this.filePath);
    } catch (error) {
      logger.warn('Telegram offset store: failed to persist cursor', {
        path: this.filePath,
        error: summarizeError(error),
      });
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    }
  }

  /** Remove the cursor entirely — used when the surface is reconfigured. */
  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch (error) {
      logger.warn('Telegram offset store: failed to clear cursor', {
        path: this.filePath,
        error: summarizeError(error),
      });
    }
  }

  /** Delete an unusable cursor file and report why, so it cannot fail every boot. */
  private sweep(reason: string): TelegramOffsetStart {
    logger.warn('Telegram offset store: discarding an unusable cursor and skipping ahead', {
      path: this.filePath,
      reason,
      consequence: 'messages sent since the last confirmed update are not replayed',
    });
    this.clear();
    return { mode: 'skip-ahead', reason };
  }
}
