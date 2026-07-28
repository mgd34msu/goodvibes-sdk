/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { dirname, join } from 'path';

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
/**
 * Hard ceiling on entries held in memory.
 *
 * Two states buffer without writing: before a host has named a destination,
 * and while a flush is failing. Both used to grow without limit, which turns a
 * logger into a memory leak in exactly the situation (a broken destination)
 * where the process is already in trouble. Past the cap the OLDEST entries are
 * dropped and counted, and the count is written into the log the moment one
 * lands — a gap that says how big it is beats a silent one.
 */
const MAX_BUFFERED_ENTRIES = 1_000;
/**
 * Consecutive failed flushes tolerated before the destination is declared
 * unwritable. Above one so a transient error (a directory being replaced, a
 * momentarily full disk) does not mute the log; small enough that a
 * permanently broken destination is recognised within a second.
 */
const MAX_CONSECUTIVE_FLUSH_FAILURES = 3;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|api[-_]?key|token|password|passwd|secret|credential|cookie|set-cookie)/i;

/** Options for configuring the activity logger. */
/** Options for {@link ActivityLogger.flushSync}. */
export interface FlushOptions {
  /**
   * Rebuild the log directory if it has vanished, then retry the append.
   * Defaults to true, which is the behaviour a live logger needs. `dispose()`
   * passes false so teardown cannot resurrect a directory its owner removed.
   */
  readonly recreateDestination?: boolean | undefined;
}

export interface ActivityLoggerOptions {
  /** Rotation threshold in bytes; the live file rotates to `.1` once it reaches this size. */
  readonly maxBytes?: number | undefined;
  /**
   * Where the logger reports its own failure, exactly once, when it gives up on
   * a destination. Defaults to `process.stderr`. Injected by tests, which
   * cannot assert "reported once" against a global stream.
   */
  readonly report?: ((line: string) => void) | undefined;
}

/** Every logger with a destination, so one process-exit hook can flush them all. */
const liveLoggers = new Set<ActivityLogger>();
let exitHookInstalled = false;

/**
 * Flush every configured logger synchronously.
 *
 * Installed on `process.exit`, which is what makes the guarantee hold for exit
 * paths the SDK does not own the call site of. `process.exit()` runs 'exit'
 * listeners before terminating, and only synchronous work in them completes —
 * which is the reason the flush path is synchronous at all.
 */
function flushAllLoggers(): void {
  for (const instance of liveLoggers) {
    // One logger with a broken destination must not stop the others from
    // landing. An exit hook that throws is also an exit hook that changes how
    // the process ends, which is never this module's business.
    try { instance.flushSync(); } catch { /* nothing left to log it with */ }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  if (typeof process?.on !== 'function') return;
  exitHookInstalled = true;
  process.on('exit', flushAllLoggers);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/**
 * ActivityLogger — Persistent debug logger for GoodVibes.
 * Writes to .goodvibes/logs/activity.md
 *
 * Entries are batched — flushed when the buffer reaches LOG_BUFFER_MAX or after
 * LOG_FLUSH_INTERVAL_MS, whichever comes first — so a busy process does not
 * touch the disk per line. The batched write itself is SYNCHRONOUS. It used to
 * be `appendFile` with a callback, which meant a write could still be in flight
 * when the process ended: a daemon handing over or shutting down took its last
 * lines with it, and the moments a log is dropped are exactly the moments it is
 * needed. A batch is at most LOG_BUFFER_MAX entries, so the blocking cost is
 * bounded and paid at most ten times a second.
 *
 * Rotation: the live file is size-capped at `maxBytes` (default
 * LOG_ROTATION_MAX_BYTES). When a flush would carry the file past the cap it
 * is renamed to `activity.md.1` (a single backup, overwritten each rotation)
 * and a fresh file is started. The size is tracked with an in-memory byte
 * counter — seeded once from the existing file at configure() and incremented
 * per flush — so the hot write path never stats the file per entry.
 *
 * Destination loss: a log directory that disappears under a running process
 * (a temp dir reclaimed at teardown, a workspace moved) is recreated and the
 * write retried. A destination that cannot be written at all is reported ONCE
 * and then abandoned — the logger stops accepting entries rather than emitting
 * `flush error: ENOENT` on a loop into a stream nobody is reading.
 */
export class ActivityLogger {
  private logPath: string | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bytes in the live file since the last rotation; drives the cheap size check. */
  private liveBytes = 0;
  private maxBytes = LOG_ROTATION_MAX_BYTES;
  private report: (line: string) => void = (line) => { process.stderr.write(line); };
  /** True once the destination has been declared unwritable and reported. */
  private degraded = false;
  private disposed = false;
  private consecutiveFailures = 0;
  /** Entries lost to the buffer cap, reported in the log once one lands. */
  private droppedEntries = 0;

  /**
   * True once a destination has been named. Until then every info/warn/error
   * in the whole platform accumulates in memory and reaches no file, which is
   * how a host that forgets `configure()` turns the entire platform mute — a
   * shipped daemon did exactly that, and an inbound channel surface that
   * refused to start produced no record anywhere. A host that cannot be sure
   * it configured the logger asks this and supplies a destination.
   */
  get isConfigured(): boolean {
    return this.logPath !== null;
  }

  /**
   * True once the logger has given up on its destination. A host that wants to
   * know whether its log is real can ask; nothing in the platform is required
   * to.
   */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * True once `dispose()` has run and before any later `configure()`.
   *
   * A disposed logger accepts nothing and writes nothing. Observable because
   * the alternative — finding out by watching a temp directory come back — is
   * how this was found in the first place.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  configure(logDir: string, options: ActivityLoggerOptions = {}): void {
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    this.logPath = join(logDir, 'activity.md');
    if (options.maxBytes !== undefined && options.maxBytes > 0) {
      this.maxBytes = options.maxBytes;
    }
    if (options.report) this.report = options.report;
    // Naming a destination is a host saying "log here now", so it clears a
    // previous destination's verdict: the new one has not failed yet. For the
    // same reason it revives a disposed logger — an explicit configure() is a
    // deliberate act, and silently staying mute after one would reproduce the
    // "host forgot to configure" muteness this class already guards against.
    this.degraded = false;
    this.disposed = false;
    this.consecutiveFailures = 0;
    // Seed the byte counter from the existing file once, so rotation accounts
    // for history written by earlier processes without stat-ing on every write.
    try {
      this.liveBytes = existsSync(this.logPath) ? statSync(this.logPath).size : 0;
    } catch {
      this.liveBytes = 0;
    }
    liveLoggers.add(this);
    installExitHook();
    if (this.buffer.length > 0) {
      this.flushSync();
    }
  }

  /**
   * Stop tracking this logger for the process-exit flush. For hosts and tests
   * that create their own instances; the shared singleton lives for the life of
   * the process.
   */
  dispose(): void {
    // recreateDestination: false — the difference between a live logger and a
    // disposed one. A live logger whose directory was moved underneath it
    // rebuilds it and retries, which is right and is asserted by
    // test/activity-logger-dispose-lifetime.test.ts. Doing the same DURING
    // disposal rebuilt a directory the owner had just deleted: a tui test
    // process removed its temp tree at teardown and the tree came back holding
    // workspace/.goodvibes/logs/activity.md, written after the delete.
    this.flushSync({ recreateDestination: false });
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    liveLoggers.delete(this);
    // Set last: everything above is the final flush, and `write()` refuses
    // entries from here on, so nothing can re-arm the timer behind us.
    this.disposed = true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flushSync(), LOG_FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /**
   * Rotate the live file to `.1` (one backup, overwritten) when it has reached
   * the size cap. Cheap: acts only on the in-memory byte counter, never stats
   * per entry.
   *
   * A rotation that cannot happen is never reported here. A missing file or
   * directory is the destination-loss case the append path already handles, and
   * any other rotation failure simply leaves the current file in place — an
   * append that cannot rotate is never dropped, so there is nothing a reader
   * could do with a message about it beyond the one the append path will send
   * if the write itself then fails.
   */
  private rotateIfNeeded(): void {
    if (!this.logPath) return;
    if (this.liveBytes < this.maxBytes) return;
    try {
      renameSync(this.logPath, `${this.logPath}.1`);
      this.liveBytes = 0;
    } catch (error) {
      // The live file is gone: whatever it held is not this process's to keep,
      // and the byte counter must not stay above the cap or every subsequent
      // flush would retry the same rename.
      if (errorCode(error) === 'ENOENT') this.liveBytes = 0;
    }
  }

  /**
   * Write everything buffered, now, on this thread.
   *
   * Public because a host with a controlled exit path (a clean stop, a signal
   * handler, an update handover that hands the port to a new process) must be
   * able to make its final lines land at a point it chooses rather than trust
   * that the process happens to stay alive long enough.
   */
  flushSync(options: FlushOptions = {}): void {
    const recreateDestination = options.recreateDestination ?? true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.degraded) return;
    if (this.buffer.length === 0) return;
    if (!this.logPath) return;
    this.rotateIfNeeded();
    const notice = this.takeDropNotice();
    const chunk = notice + this.buffer.join('');
    this.buffer.length = 0;
    if (this.append(chunk, recreateDestination)) {
      this.liveBytes += Buffer.byteLength(chunk, 'utf-8');
      this.consecutiveFailures = 0;
      return;
    }
    this.recordFailedFlush(chunk);
  }

  /**
   * One append attempt, with the destination recreated once if it vanished.
   *
   * Recreating is the honest response to the case actually observed: the
   * directory existed when the host named it and was removed underneath a
   * running process. Recreating restores exactly what the host asked for. It is
   * attempted once per flush, never in a loop — if the path cannot be a
   * directory at all, the retry fails and the caller degrades.
   */
  private append(chunk: string, recreateDestination: boolean): boolean {
    const path = this.logPath;
    if (!path) return false;
    try {
      appendFileSync(path, chunk, 'utf-8');
      return true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return false;
      if (!recreateDestination) return false;
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, chunk, 'utf-8');
        // The file is new, whatever it was before.
        this.liveBytes = 0;
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Hold a failed batch for the next attempt, and give up once a destination
   * has failed MAX_CONSECUTIVE_FLUSH_FAILURES times in a row.
   *
   * Giving up is the point. The prior behaviour wrote `[ActivityLogger] flush
   * error: ENOENT` to stderr on every single flush — once per 100ms for as long
   * as the process lived — while continuing to accept entries as though they
   * were being recorded. One report, then stop accepting, is what a reader can
   * actually act on.
   */
  private recordFailedFlush(chunk: string): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < MAX_CONSECUTIVE_FLUSH_FAILURES) {
      this.buffer.unshift(chunk);
      this.enforceBufferCap();
      this.scheduleFlush();
      return;
    }
    this.degraded = true;
    this.buffer.length = 0;
    this.droppedEntries = 0;
    this.report(
      `[ActivityLogger] ${this.logPath} is not writable after ${MAX_CONSECUTIVE_FLUSH_FAILURES} attempts; `
      + 'activity logging is stopped for this destination.\n',
    );
  }

  /** Drop oldest entries past the cap, remembering how many were lost. */
  private enforceBufferCap(): void {
    if (this.buffer.length <= MAX_BUFFERED_ENTRIES) return;
    this.droppedEntries += this.buffer.length - MAX_BUFFERED_ENTRIES;
    this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_ENTRIES);
  }

  private takeDropNotice(): string {
    if (this.droppedEntries === 0) return '';
    const dropped = this.droppedEntries;
    this.droppedEntries = 0;
    return `[${new Date().toISOString()}] [WARN] ActivityLogger dropped ${dropped} buffered entries before this point (in-memory buffer cap ${MAX_BUFFERED_ENTRIES})\n`;
  }

  private write(level: string, message: string, data?: Record<string, unknown>) {
    // Disposed: the owner has torn this logger down. Accepting the entry would
    // re-arm the flush timer and, on the next flush, rebuild a destination the
    // owner deleted. Dropped silently for the same reason `degraded` is —
    // there is nobody left to tell.
    if (this.disposed) return;
    // Abandoned destination: entries are dropped deliberately and silently.
    // The one report has already been made; counting them here would only grow
    // a number nobody will ever read.
    if (this.degraded) return;
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}\n`;
    if (data) {
      entry += '```json\n' + JSON.stringify(redactLogData(data), null, 2) + '\n```\n';
    }
    this.buffer.push(entry);
    this.enforceBufferCap();
    if (this.buffer.length >= LOG_BUFFER_MAX) {
      // Buffer full — flush immediately without waiting for the timer
      this.flushSync();
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

/**
 * Make everything the shared logger holds land on disk, now.
 *
 * Called by hosts at the exit paths they control. The process-exit hook covers
 * the ones they do not, but a host that is deliberately handing over should not
 * depend on a backstop to record why.
 */
export function flushActivityLogSync(): void {
  logger.flushSync();
}

/**
 * Name a destination only if the host has not already named one, and report
 * whether this call was the one that did it.
 *
 * The platform's runtimes are embedded by several hosts, and a host that
 * forgets `configureActivityLogger` does not get a degraded log — it gets no
 * log at all, for every component in the process. That is not a defect the
 * component can detect from the inside, so the long-lived runtimes call this
 * at start with their own working directory as the fallback. A host that DID
 * configure a destination keeps it; this never relocates an existing log.
 */
export function ensureActivityLoggerConfigured(
  logDir: string,
  options?: ActivityLoggerOptions,
): boolean {
  if (logger.isConfigured) return false;
  logger.configure(logDir, options);
  return true;
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
