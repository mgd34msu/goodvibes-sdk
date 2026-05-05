/**
 * LocalLedgerExporter — append-only JSON lines span exporter.
 *
 * Writes completed spans to a rotating JSON Lines (.jsonl) file.
 * Export failures are isolated from the runtime and reported through
 * structured logger entries.
 *
 * Also provides typed event ledger recording for deterministic replay.
 * Call `recordEvent()` to append a `LedgerEntry` to the ledger file.
 */
import { appendFileSync, statSync, renameSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { logger } from '../../../utils/logger.js';
import type { ReadableSpan, SpanExporter } from '../types.js';
import { summarizeError } from '../../../utils/error-display.js';

/** Configuration for LocalLedgerExporter. */
export interface LocalLedgerConfig {
  /**
   * Absolute path to the output file (e.g. `/home/user/.goodvibes/telemetry/spans.jsonl`).
   */
  readonly filePath: string;
  /**
   * Maximum file size in bytes before rotation.
   * When the file exceeds this size, it is renamed to `<filePath>.1` and a
   * fresh file is started. Defaults to 10 MB.
   */
  readonly maxFileSizeBytes?: number | undefined;
  /**
   * Optional path for the typed event ledger file.
   * When provided, `recordEvent()` appends `LedgerEntry` lines here.
   * Defaults to `<filePath>.ledger.jsonl`.
   */
  readonly ledgerFilePath?: string | undefined;
}

/**
 * A single typed event entry in the replay ledger.
 *
 * Each entry captures the run identifier, a monotonically increasing
 * revision counter, the event name, payload, and wall-clock timestamp.
 * The revision counter is used by the deterministic replay engine for
 * seek and stepwise playback.
 */
export interface LedgerEntry {
  /** Run identifier — groups entries belonging to the same recorded run. */
  readonly runId: string;
  /** Monotonically increasing revision counter within the run (starts at 1). */
  readonly rev: number;
  /** Event name recorded in the typed runtime ledger. */
  readonly eventName: string;
  /** Full event payload, JSON-serialisable. */
  readonly payload: unknown;
  /** Wall-clock timestamp (epoch ms) when the event was recorded. */
  readonly ts: number;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * LocalLedgerExporter — writes spans as JSON lines to a rotating file.
 *
 * Usage:
 * ```ts
 * const exporter = new LocalLedgerExporter({
 *   filePath: '/home/user/.goodvibes/telemetry/spans.jsonl',
 *   maxFileSizeBytes: 5 * 1024 * 1024,
 * });
 * ```
 */
export class LocalLedgerExporter implements SpanExporter {
  readonly name = 'local-ledger';
  private readonly filePath: string;
  private readonly maxFileSizeBytes: number;
  private readonly ledgerFilePath: string;

  constructor(config: LocalLedgerConfig) {
    this.filePath = config.filePath;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.ledgerFilePath = config.ledgerFilePath ?? `${config.filePath}.ledger.jsonl`;
  }

  /**
   * Export a batch of spans as JSON lines.
   *
   * Failures are logged and isolated from callers so exporter I/O cannot break
   * runtime work.
   */
  async export(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;

    const lines: string[] = [];
    let droppedSpans = 0;
    for (const span of spans) {
      try {
        lines.push(JSON.stringify(span));
      } catch (err) {
        droppedSpans++;
        logger.warn('[local-ledger] span serialization failed', {
          error: summarizeError(err),
          spanName: span.name,
          traceId: span.spanContext.traceId,
          spanId: span.spanContext.spanId,
        });
      }
    }

    if (lines.length === 0) {
      logger.warn('[local-ledger] export produced no serializable spans', {
        spanCount: spans.length,
        droppedSpans,
      });
      return;
    }

    const payload = `${lines.join('\n')}\n`;

    // All I/O in a microtask to keep the call non-blocking.
    await Promise.resolve().then(() => {
      try {
        this._rotateIfNeeded();
        appendFileSync(this.filePath, payload, 'utf8');
      } catch (err) {
        logger.warn('[local-ledger] export failed', {
          error: summarizeError(err),
          filePath: this.filePath,
          spanCount: spans.length,
          writtenSpans: lines.length,
          droppedSpans,
        });
      }
    });
  }

  /**
   * Record a typed event entry to the ledger file.
   *
   * Used by the deterministic replay engine to build a per-run event log.
   * Failures are logged and isolated from callers.
   *
   * @param entry - The ledger entry to append.
   *
   * @remarks
   * This method is used by the event recording integration that
   * wires typed runtime events to the ledger. The integration subscribes to the
   * runtime bus at session start and calls `recordEvent()` for each event that should
   * be included in the replay ledger. See `DeterministicReplayEngine.load()`
   * for the consumer side of this pipeline.
   */
  recordEvent(entry: LedgerEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.ledgerFilePath, line, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] ledger write failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
        runId: entry.runId,
        rev: entry.rev,
        eventName: entry.eventName,
      });
    }
  }

  /**
   * Read all ledger entries for a given run.
   *
   * Parses the ledger file line-by-line. Malformed lines are skipped.
   * Returns entries sorted by revision (ascending).
   *
   * @param runId - The run to retrieve entries for.
   * @returns Ordered ledger entries for the run.
   */
  readRunEntries(runId: string): LedgerEntry[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    const entries: LedgerEntry[] = [];
    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] ledger read failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
        runId,
      });
      return [];
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (entry.runId === runId) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines — ledger may have partial writes.
      }
    }

    entries.sort((a, b) => a.rev - b.rev);
    return entries;
  }

  /**
   * List all run IDs recorded in the ledger.
   */
  listRunIds(): string[] {
    if (!existsSync(this.ledgerFilePath)) return [];

    let raw: string;
    try {
      raw = readFileSync(this.ledgerFilePath, 'utf8');
    } catch (err) {
      logger.warn('[local-ledger] ledger read failed', {
        error: summarizeError(err),
        ledgerFilePath: this.ledgerFilePath,
      });
      return [];
    }

    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as LedgerEntry;
        if (typeof entry.runId === 'string') {
          seen.add(entry.runId);
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return [...seen];
  }

  /** Flush is a no-op for synchronous append-only writes. */
  async flush(): Promise<void> {
    // Nothing to flush — writes are synchronous via appendFileSync.
  }

  /** Shutdown is a no-op for file-based exports. */
  async shutdown(): Promise<void> {
    // Nothing to tear down.
  }

  /**
   * Rotate the log file if it exceeds the configured maximum size.
   * Renames the current file to `<filePath>.1` (overwrites any existing `.1`).
   */
  private _rotateIfNeeded(): void {
    try {
      const stat = statSync(this.filePath);
      if (stat.size >= this.maxFileSizeBytes) {
        renameSync(this.filePath, `${this.filePath}.1`);
        writeFileSync(this.filePath, '', 'utf8');
        logger.debug(`[local-ledger] rotated ${this.filePath}`);
      }
    } catch (err) {
      if (isNodeErrorCode(err, 'ENOENT')) {
        return;
      }
      logger.warn('[local-ledger] rotation check failed', {
        error: summarizeError(err),
        filePath: this.filePath,
      });
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
