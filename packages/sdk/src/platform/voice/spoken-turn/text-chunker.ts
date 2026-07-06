/**
 * TtsTextChunker — turns a stream of provider content deltas into speech-sized
 * chunks at sentence boundaries, with a max-length cut and a latency flush so a
 * long unpunctuated run still starts speaking. This is pure policy (no I/O, no
 * timers of its own — the caller drives `flushDue()` on its own clock), so it
 * lives in the SDK and is shared verbatim by every voice consumer.
 */
export interface TtsTextChunkerOptions {
  readonly minBoundaryChars?: number | undefined;
  readonly maxChunkChars?: number | undefined;
  readonly maxLatencyMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class TtsTextChunker {
  private buffer = '';
  private firstBufferedAt: number | null = null;
  private readonly minBoundaryChars: number;
  private readonly maxChunkChars: number;
  private readonly maxLatencyMs: number;
  private readonly now: () => number;

  constructor(options: TtsTextChunkerOptions = {}) {
    this.minBoundaryChars = options.minBoundaryChars ?? 24;
    this.maxChunkChars = options.maxChunkChars ?? 320;
    this.maxLatencyMs = options.maxLatencyMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
  }

  push(delta: string): string[] {
    if (!delta) return [];
    if (this.firstBufferedAt === null) this.firstBufferedAt = this.now();
    this.buffer += delta;
    return this.drainReady(false);
  }

  flushDue(): string[] {
    if (!this.buffer.trim() || this.firstBufferedAt === null) return [];
    if (this.now() - this.firstBufferedAt < this.maxLatencyMs) return [];
    return this.drainReady(true);
  }

  flushAll(): string[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      this.firstBufferedAt = null;
      return [];
    }
    return [this.takeChunk(this.buffer.length)].filter(Boolean);
  }

  reset(): void {
    this.buffer = '';
    this.firstBufferedAt = null;
  }

  private drainReady(forceLatencyFlush: boolean): string[] {
    const chunks: string[] = [];
    while (this.buffer.trim()) {
      const boundary = this.findBoundary(forceLatencyFlush);
      if (boundary <= 0) break;
      const chunk = this.takeChunk(boundary);
      if (chunk) chunks.push(chunk);
      forceLatencyFlush = false;
    }
    return chunks;
  }

  private findBoundary(forceLatencyFlush: boolean): number {
    const latestSentence = this.findLatestSentenceBoundary();
    if (latestSentence >= this.minBoundaryChars) return latestSentence;

    if (this.buffer.length >= this.maxChunkChars) {
      return this.findWordBoundaryBefore(this.maxChunkChars) || this.maxChunkChars;
    }

    if (forceLatencyFlush) {
      return this.buffer.length;
    }

    return -1;
  }

  private findLatestSentenceBoundary(): number {
    let best = -1;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char !== '.' && char !== '!' && char !== '?' && char !== ';' && char !== ':' && char !== '\n') {
        continue;
      }
      const next = this.buffer[i + 1];
      if (i === this.buffer.length - 1 || next === undefined || /\s/.test(next)) {
        best = i + 1;
      }
    }
    return best;
  }

  private findWordBoundaryBefore(index: number): number {
    const max = Math.min(index, this.buffer.length);
    for (let i = max; i > 0; i--) {
      if (/\s/.test(this.buffer[i - 1] ?? '')) return i;
    }
    return -1;
  }

  private takeChunk(end: number): string {
    const raw = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    this.firstBufferedAt = this.buffer.trim() ? this.now() : null;
    return normalizeSpeechText(raw);
  }
}

export function normalizeSpeechText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
