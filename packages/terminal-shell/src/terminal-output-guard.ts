/**
 * terminal-output-guard.ts, catches direct stdout/stderr/console writes made
 * while a full-screen terminal renderer owns the screen, so a stray write from
 * some other code path never corrupts the compositor's output.
 *
 * `installTerminalOutputGuard` is the primitive: it monkeypatches the given
 * streams and console methods, records every intercepted write, and restores
 * everything on dispose. Installing a second guard before the first is
 * disposed first disposes that first guard, so the restore chain always
 * unwinds against the real underlying write rather than an intermediate
 * patch, without this, a second install's "original" would actually be the
 * first guard's wrapper, and disposing the second would leave the first's
 * patch installed forever.
 *
 * `installFullScreenTerminalOutputGuard` is the full-screen-renderer wrapper: it adds
 * a rate limit (at most once per 5s) over the raw intercept stream, so a burst
 * of captured writes produces one on-screen notice rather than a line per
 * write. It exposes two independent, optional ways for a caller to learn about
 * captures:
 *   - `onCapture`: the cumulative count of writes captured this session, for
 *     a caller that keeps its own quiet counter (e.g. surfaced by /debug).
 *   - `notify`: a formatted, human-readable notice, how many writes were
 *     captured since the last notice (reset to zero after each call) and the
 *     most recent write's preview, for a caller that wants to push a
 *     transcript-style message. Also logged via logger.info at the same
 *     cadence, so the aggregate stays reachable in the activity log even
 *     where a UI-level noise gate drops the notice from a visible feed.
 * A caller passes whichever it needs; both can be exercised independently and
 * neither depends on the other being present.
 */
import { format } from 'node:util';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

type WritableStreamLike = {
  write: {
    (buffer: string | Uint8Array, cb?: (error?: Error | null) => void): boolean;
    (buffer: string | Uint8Array, encoding?: BufferEncoding, cb?: (error?: Error | null) => void): boolean;
  };
};

export type TerminalOutputInterceptSource =
  | 'stdout'
  | 'stderr'
  | 'console.debug'
  | 'console.error'
  | 'console.info'
  | 'console.log'
  | 'console.warn';

export type TerminalOutputIntercept = {
  readonly source: TerminalOutputInterceptSource;
  readonly text: string;
  readonly preview: string;
};

export type TerminalOutputGuard = {
  setActive(active: boolean): void;
  allowTerminalWrite<T>(fn: () => T): T;
  dispose(): void;
};

export type TerminalOutputGuardOptions = {
  readonly stdout: WritableStreamLike;
  readonly stderr?: WritableStreamLike;
  readonly active?: boolean;
  readonly onIntercept?: (event: TerminalOutputIntercept) => void;
};

export type FullScreenTerminalOutputGuardOptions = {
  readonly stdout: WritableStreamLike;
  readonly stderr?: WritableStreamLike;
  readonly active?: boolean;
  /**
   * Called (rate-limited, at most once per 5s) with the cumulative count of
   * direct writes captured this session, so an honest quiet counter (e.g.
   * /debug) can refresh. The per-write detail is already recorded to the
   * activity log via logger.warn inside installTerminalOutputGuard, this
   * callback intentionally does NOT push transcript lines.
   */
  readonly onCapture?: (total: number) => void;
  /**
   * Called (rate-limited, at most once per 5s) with a formatted notice naming
   * how many direct writes were captured since the last notice, that count
   * resets to zero after each call, and the most recent write's preview.
   * Also logged via logger.info at the same cadence.
   */
  readonly notify?: (message: string) => void;
};

const MAX_LOG_TEXT = 4_000;
const MAX_PREVIEW_TEXT = 180;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let currentGuard: TerminalOutputGuard | null = null;

function writeCallback(args: unknown[]): ((error?: Error | null) => void) | undefined {
  const maybeCallback = args[args.length - 1];
  return typeof maybeCallback === 'function'
    ? maybeCallback as (error?: Error | null) => void
    : undefined;
}

function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

function normalizeText(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r/g, '').trim();
}

function previewText(text: string): string {
  const singleLine = normalizeText(text).replace(/\s+/g, ' ');
  if (singleLine.length <= MAX_PREVIEW_TEXT) return singleLine;
  return `${singleLine.slice(0, MAX_PREVIEW_TEXT - 1)}...`;
}

function truncateForLog(text: string): string {
  if (text.length <= MAX_LOG_TEXT) return text;
  return `${text.slice(0, MAX_LOG_TEXT)}\n[truncated ${text.length - MAX_LOG_TEXT} byte(s)]`;
}

function invokeSuppressedCallback(args: unknown[]): void {
  const callback = writeCallback(args);
  if (callback) {
    queueMicrotask(() => callback(null));
  }
}

export function allowTerminalWrite<T>(fn: () => T): T {
  return currentGuard ? currentGuard.allowTerminalWrite(fn) : fn();
}

export function installTerminalOutputGuard(options: TerminalOutputGuardOptions): TerminalOutputGuard {
  // If a guard already exists and hasn't been disposed, dispose it first so
  // the monkeypatch chain is cleanly unwound BEFORE the originals below are
  // snapshotted. Without this, a second install's "original" write is actually
  // the first guard's wrapper, and disposing the second guard alone leaves the
  // first guard's patch installed forever.
  if (currentGuard !== null) {
    currentGuard.dispose();
  }

  const stdout = options.stdout;
  const stderr = options.stderr ?? process.stderr;
  const originalStdoutWriteMethod = stdout.write;
  const originalStderrWriteMethod = stderr.write;
  const originalStdoutWrite = (...args: unknown[]): boolean =>
    Reflect.apply(originalStdoutWriteMethod, stdout, args) as boolean;
  const originalStderrWrite = (...args: unknown[]): boolean =>
    Reflect.apply(originalStderrWriteMethod, stderr, args) as boolean;
  const originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  let active = options.active ?? true;
  let disposed = false;
  let allowDepth = 0;
  let captureDepth = 0;

  const record = (source: TerminalOutputInterceptSource, text: string): void => {
    if (disposed || !active) return;
    const normalized = normalizeText(text);
    if (!normalized) return;
    if (normalized.startsWith('[ActivityLogger]')) return;
    if (captureDepth > 0) return;

    captureDepth++;
    try {
      const event: TerminalOutputIntercept = {
        source,
        text: truncateForLog(normalized),
        preview: previewText(normalized),
      };
      logger.warn('Intercepted terminal output while TUI renderer was active', {
        source: event.source,
        text: event.text,
      });
      options.onIntercept?.(event);
    } finally {
      captureDepth--;
    }
  };

  const shouldPassThrough = (): boolean => !active || allowDepth > 0 || disposed;

  stdout.write = ((...args: unknown[]) => {
    if (shouldPassThrough()) {
      return originalStdoutWrite(...args);
    }
    record('stdout', chunkToText(args[0]));
    invokeSuppressedCallback(args);
    return true;
  }) as WritableStreamLike['write'];

  stderr.write = ((...args: unknown[]) => {
    if (shouldPassThrough()) {
      return originalStderrWrite(...args);
    }
    record('stderr', chunkToText(args[0]));
    invokeSuppressedCallback(args);
    return true;
  }) as WritableStreamLike['write'];

  console.debug = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.debug(...args);
    record('console.debug', format(...args));
  };
  console.error = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.error(...args);
    record('console.error', format(...args));
  };
  console.info = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.info(...args);
    record('console.info', format(...args));
  };
  console.log = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.log(...args);
    record('console.log', format(...args));
  };
  console.warn = (...args: unknown[]) => {
    if (!active || disposed) return originalConsole.warn(...args);
    record('console.warn', format(...args));
  };

  const guard: TerminalOutputGuard = {
    setActive(nextActive) {
      active = nextActive;
    },
    allowTerminalWrite<T>(fn: () => T): T {
      allowDepth++;
      try {
        return fn();
      } finally {
        allowDepth--;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stdout.write = originalStdoutWriteMethod;
      stderr.write = originalStderrWriteMethod;
      console.debug = originalConsole.debug;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      if (currentGuard === guard) {
        currentGuard = null;
      }
    },
  };

  currentGuard = guard;
  return guard;
}

export function installFullScreenTerminalOutputGuard(options: FullScreenTerminalOutputGuardOptions): TerminalOutputGuard {
  let totalInterceptedWrites = 0;
  let sinceLastNotifyCount = 0;
  let lastNoticeAt = 0;
  return installTerminalOutputGuard({
    stdout: options.stdout,
    ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
    ...(options.active !== undefined ? { active: options.active } : {}),
    onIntercept: (event) => {
      // Each intercept is already logged (logger.warn in record()). This
      // wrapper only maintains the two counters below and, rate-limited,
      // refreshes whichever of the caller's callbacks is present, no
      // repeated transcript lines per write.
      totalInterceptedWrites++;
      sinceLastNotifyCount++;
      const now = Date.now();
      if (now - lastNoticeAt < 5_000) return;
      lastNoticeAt = now;

      options.onCapture?.(totalInterceptedWrites);

      if (options.notify) {
        const count = sinceLastNotifyCount;
        sinceLastNotifyCount = 0;
        const plural = count === 1 ? '' : 's';
        const notice = `[Terminal] Captured ${count} direct ${event.source} write${plural} that would have corrupted the TUI: ${event.preview}`;
        // Keep the aggregate count reachable in the activity log even where a
        // UI-level noise gate drops the notice from a visible feed. (Drop-
        // from-the-feed, not delete, an honest degraded state.)
        logger.info(notice, { source: event.source, count });
        options.notify(notice);
      }
    },
  });
}
