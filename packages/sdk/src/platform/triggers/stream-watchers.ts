/**
 * stream-watchers.ts — watching the output of a long-lived command.
 *
 * The pipeline, in order: split into lines -> keep lines matching `match` and
 * drop lines matching `exclude` -> suppress repeats of a line already seen
 * inside the dedup TTL -> push onto a BOUNDED queue -> emit a batch once
 * `batchLines` have accumulated or `batchIntervalMs` has elapsed.
 *
 * Two properties matter more than the rest:
 *
 *   An agent is invoked only after a match. A stream watcher tailing a busy log
 *   must not start an agent turn per line, so batching and dedup are part of
 *   the watcher rather than something the caller is trusted to add.
 *
 *   The queue is bounded and every drop is counted. When a log outruns the
 *   consumer the oldest entries go, and the drop count is reported on the
 *   trigger record — a silent drop would make the watcher look healthy while it
 *   was losing exactly the lines it exists to catch.
 *
 * The processor below is pure and synchronous: feed it text, ask it for
 * batches. That makes the whole matching/batching/dedup story testable without
 * spawning a process.
 */

import { validateRegexSource } from './validation.js';
import type { RegexExtract, StreamTriggerSpec } from './types.js';

export interface StreamBatch {
  readonly at: number;
  readonly lines: readonly string[];
  /** Lines dropped by the bounded queue since the previous batch. */
  readonly dropped: number;
  /** Lines suppressed by the dedup TTL since the previous batch. */
  readonly deduped: number;
}

export interface StreamProcessorOptions {
  readonly match: RegexExtract;
  readonly exclude?: RegexExtract | undefined;
  readonly batchLines: number;
  readonly batchIntervalMs: number;
  readonly queueLimit: number;
  readonly dedupTtlMs?: number | undefined;
}

export const DEFAULT_STREAM_BATCH_LINES = 25;
export const DEFAULT_STREAM_BATCH_INTERVAL_MS = 1_000;
export const DEFAULT_STREAM_QUEUE_LIMIT = 1_000;
/** A single line longer than this is truncated rather than buffered whole. */
const MAX_LINE_LENGTH = 8_192;

export function resolveStreamOptions(
  spec: StreamTriggerSpec,
  defaults: {
    readonly batchLines?: number | undefined;
    readonly batchIntervalMs?: number | undefined;
    readonly queueLimit?: number | undefined;
  } = {},
): StreamProcessorOptions {
  return {
    match: spec.match,
    ...(spec.exclude !== undefined ? { exclude: spec.exclude } : {}),
    batchLines: spec.batchLines ?? defaults.batchLines ?? DEFAULT_STREAM_BATCH_LINES,
    batchIntervalMs: spec.batchIntervalMs ?? defaults.batchIntervalMs ?? DEFAULT_STREAM_BATCH_INTERVAL_MS,
    queueLimit: spec.queueLimit ?? defaults.queueLimit ?? DEFAULT_STREAM_QUEUE_LIMIT,
    ...(spec.dedupTtlMs !== undefined ? { dedupTtlMs: spec.dedupTtlMs } : {}),
  };
}

export class StreamLineProcessor {
  private readonly matchRegex: RegExp;
  private readonly excludeRegex: RegExp | null;
  private readonly options: StreamProcessorOptions;
  private carry = '';
  private queue: string[] = [];
  private dedupMarks = new Map<string, number>();
  private droppedSinceBatch = 0;
  private dedupedSinceBatch = 0;
  private totalDropped = 0;
  private totalMatched = 0;
  private firstQueuedAt: number | null = null;

  constructor(options: StreamProcessorOptions) {
    this.options = options;
    this.matchRegex = validateRegexSource(options.match.pattern, 'stream.match', options.match.flags);
    this.excludeRegex = options.exclude
      ? validateRegexSource(options.exclude.pattern, 'stream.exclude', options.exclude.flags)
      : null;
  }

  /** Lines dropped by the bounded queue over the watcher's whole lifetime. */
  get droppedTotal(): number {
    return this.totalDropped;
  }

  /** Lines that matched over the watcher's whole lifetime. */
  get matchedTotal(): number {
    return this.totalMatched;
  }

  get pending(): number {
    return this.queue.length;
  }

  /**
   * Feeds a chunk of stream output. Partial trailing lines are carried to the
   * next chunk, so a line split across two reads is still matched once, whole.
   */
  push(chunk: string, now: number): void {
    const combined = this.carry + chunk;
    const parts = combined.split('\n');
    this.carry = parts.pop() ?? '';
    if (this.carry.length > MAX_LINE_LENGTH) {
      // A stream with no newlines must not grow the carry without limit.
      this.acceptLine(this.carry.slice(0, MAX_LINE_LENGTH), now);
      this.carry = '';
    }
    for (const part of parts) {
      this.acceptLine(part, now);
    }
  }

  /** Flushes any partial trailing line — call when the stream closes. */
  finish(now: number): void {
    if (this.carry.length > 0) {
      this.acceptLine(this.carry, now);
      this.carry = '';
    }
  }

  private acceptLine(rawLine: string, now: number): void {
    const line = rawLine.length > MAX_LINE_LENGTH ? rawLine.slice(0, MAX_LINE_LENGTH) : rawLine;
    if (line.length === 0) return;
    if (!this.matchRegex.test(line)) return;
    if (this.excludeRegex?.test(line) === true) return;
    this.totalMatched += 1;

    const ttl = this.options.dedupTtlMs;
    if (ttl !== undefined && ttl > 0) {
      this.pruneDedup(now, ttl);
      const seenAt = this.dedupMarks.get(line);
      if (seenAt !== undefined && now - seenAt < ttl) {
        this.dedupedSinceBatch += 1;
        return;
      }
      this.dedupMarks.set(line, now);
    }

    if (this.queue.length === 0) this.firstQueuedAt = now;
    this.queue.push(line);
    while (this.queue.length > this.options.queueLimit) {
      this.queue.shift();
      this.droppedSinceBatch += 1;
      this.totalDropped += 1;
    }
  }

  private pruneDedup(now: number, ttlMs: number): void {
    if (this.dedupMarks.size < 4_096) return;
    for (const [line, at] of this.dedupMarks) {
      if (now - at >= ttlMs) this.dedupMarks.delete(line);
    }
  }

  /**
   * Returns a batch when one is ready — either the batch is full, or a partial
   * batch has been waiting longer than `batchIntervalMs`. Returns null
   * otherwise, so a caller can poll on a timer without emitting empty turns.
   */
  takeBatch(now: number, force = false): StreamBatch | null {
    if (this.queue.length === 0) return null;
    const full = this.queue.length >= this.options.batchLines;
    const aged = this.firstQueuedAt !== null && now - this.firstQueuedAt >= this.options.batchIntervalMs;
    if (!full && !aged && !force) return null;

    const lines = this.queue.splice(0, this.options.batchLines);
    const batch: StreamBatch = {
      at: now,
      lines,
      dropped: this.droppedSinceBatch,
      deduped: this.dedupedSinceBatch,
    };
    this.droppedSinceBatch = 0;
    this.dedupedSinceBatch = 0;
    this.firstQueuedAt = this.queue.length > 0 ? now : null;
    return batch;
  }
}

/**
 * The default agent prompt for a stream match. Says what matched and what was
 * lost, because a batch that silently omits dropped or deduplicated lines would
 * let an agent reason from a partial picture without knowing it.
 */
export function renderStreamPrompt(batch: StreamBatch, label: string, pattern: string): string {
  const lines = [
    `A stream watcher matched output from a supervised command.`,
    '',
    `Trigger: ${label}`,
    `Match pattern: ${pattern}`,
    `Matched lines in this batch: ${batch.lines.length}`,
  ];
  if (batch.deduped > 0) {
    lines.push(`Suppressed as repeats inside the dedup window: ${batch.deduped}`);
  }
  if (batch.dropped > 0) {
    lines.push(`DROPPED because the bounded queue overflowed: ${batch.dropped} — this batch is incomplete.`);
  }
  lines.push('', '--- matched lines ---', ...batch.lines, '');
  lines.push('Decide whether these lines need action, and act only on what they actually show.');
  return lines.join('\n');
}
