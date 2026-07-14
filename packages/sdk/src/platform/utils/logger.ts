/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { appendFile, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { join } from 'path';

/** Maximum buffered entries before a flush is triggered. */
const LOG_BUFFER_MAX = 10;
/** Flush interval in milliseconds when buffer is below max. */
const LOG_FLUSH_INTERVAL_MS = 100;
/**
 * Default rotation threshold for activity.md. When the live file reaches this
 * size it is rotated to activity.md.1 (one backup kept) and a fresh file is
 * started, so an append-only debug log on a long-lived daemon stops growing
 * without limit. Honest default: 10 MB (a real 22.8 MB activity.md was the
 * motivating observation — two rotations' worth of debugging history stays on
 * disk, older history is reclaimed).
 */
const LOG_ROTATION_MAX_BYTES = 10 * 1024 * 1024;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|api[-_]?key|token|password|passwd|secret|credential|cookie|set-cookie)/i;

/** Options for configuring the activity logger. */
export interface ActivityLoggerOptions {
  /** Rotation threshold in bytes; the live file rotates to `.1` once it reaches this size. */
  readonly maxBytes?: number | undefined;
}

/**
 * ActivityLogger — Persistent debug logger for GoodVibes.
 * Writes to .goodvibes/logs/activity.md
 *
 * Uses a buffered async writer to avoid blocking the event loop on every
 * log entry. Entries are flushed when the buffer reaches LOG_BUFFER_MAX
 * or after LOG_FLUSH_INTERVAL_MS, whichever comes first.
 *
 * Rotation: the live file is size-capped at `maxBytes` (default
 * LOG_ROTATION_MAX_BYTES). When a flush would carry the file past the cap it
 * is renamed to `activity.md.1` (a single backup, overwritten each rotation)
 * and a fresh file is started. The size is tracked with an in-memory byte
 * counter — seeded once from the existing file at configure() and incremented
 * per flush — so the hot write path never stats the file per entry.
 */
class ActivityLogger {
  private logPath: string | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bytes in the live file since the last rotation; drives the cheap size check. */
  private liveBytes = 0;
  private maxBytes = LOG_ROTATION_MAX_BYTES;

  configure(logDir: string, options: ActivityLoggerOptions = {}): void {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logPath = join(logDir, 'activity.md');
    if (options.maxBytes !== undefined && options.maxBytes > 0) {
      this.maxBytes = options.maxBytes;
    }
    // Seed the byte counter from the existing file once, so rotation accounts
    // for history written by earlier processes without stat-ing on every write.
    try {
      this.liveBytes = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    } catch {
      this.liveBytes = 0;
    }
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flush(), LOG_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /**
   * Rotate the live file to `.1` (one backup, overwritten) when it has reached
   * the size cap. Cheap: acts only on the in-memory byte counter, never stats
   * per entry. A rotation failure leaves the current file in place — an
   * append that cannot rotate is never dropped.
   */
  private rotateIfNeeded(): void {
    if (!this.logPath) return;
    if (this.liveBytes < this.maxBytes) return;
    try {
      renameSync(this.logPath, `${this.logPath}.1`);
      this.liveBytes = 0;
    } catch (err) {
      // Cannot log the logger's own error without recursion.
      process.stderr.write(`[ActivityLogger] rotation error: ${(err as Error).message}\n`);
    }
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;
    if (!this.logPath) return;
    this.rotateIfNeeded();
    const chunk = this.buffer.splice(0).join('');
    this.liveBytes += Buffer.byteLength(chunk, 'utf-8');
    appendFile(this.logPath, chunk, (err) => {
      if (err) {
        // Cannot log the logger's own error without recursion.
        process.stderr.write(`[ActivityLogger] flush error: ${err.message}\n`);
      }
    });
  }

  private write(level: string, message: string, data?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}\n`;
    if (data) {
      entry += '```json\n' + JSON.stringify(redactLogData(data), null, 2) + '\n```\n';
    }
    this.buffer.push(entry);
    if (this.buffer.length >= LOG_BUFFER_MAX) {
      // Buffer full — flush immediately without waiting for the timer
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  info(message: string, data?: Record<string, unknown>) { this.write('INFO', message, data); }
  warn(message: string, data?: Record<string, unknown>) { this.write('WARN', message, data); }
  error(message: string, data?: Record<string, unknown>) { this.write('ERROR', message, data); }
  debug(message: string, data?: Record<string, unknown>) { this.write('DEBUG', message, data); }
}

export const logger = new ActivityLogger();

export function configureActivityLogger(logDir: string, options?: ActivityLoggerOptions): void {
  logger.configure(logDir, options);
}

function redactLogData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactLogData(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactLogData(nested, seen);
  }
  return out;
}
