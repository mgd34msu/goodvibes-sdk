/**
 * memory-usage-stats.ts — per-memory usage counters (HOISTED to the SDK).
 *
 * Answers "was injected context actually used?". Promoted verbatim from the
 * agent surface so every consumer records the SAME instrumentation the SAME way.
 *
 * The store records, per memory id, how many times it was injected into a prompt
 * and how many of those injections were plausibly referenced by the model's
 * output (see memory-usage-detection.ts — a heuristic distinctive-content
 * overlap, not ground truth). It duplicates no memory content: it keys on the id
 * only. It is instrumentation data, not a second memory store — same durable JSON
 * sidecar idiom as the prompt-context and consolidation receipts.
 *
 * The counters feed the idle consolidation decay ordering (never-referenced
 * memories decay first) via `lookup`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryConsolidationUsageSignal } from './memory-consolidation.js';

export interface MemoryUsageEntry {
  readonly injectedCount: number;
  readonly referencedCount: number;
  readonly lastInjectedAt: number | null;
  readonly lastReferencedAt: number | null;
}

export interface MemoryUsageTopEntry extends MemoryUsageEntry {
  readonly id: string;
}

export interface MemoryUsageSummary {
  readonly totalTracked: number;
  readonly everInjected: number;
  readonly everReferenced: number;
  readonly neverReferenced: number;
  readonly mostReferenced: readonly MemoryUsageTopEntry[];
  readonly neverReferencedSample: readonly MemoryUsageTopEntry[];
  readonly signalNote: string;
}

interface MutableEntry {
  injectedCount: number;
  referencedCount: number;
  lastInjectedAt: number | null;
  lastReferencedAt: number | null;
}

const USAGE_FILE_VERSION = 1;

export const MEMORY_USAGE_SIGNAL_NOTE =
  'Reference detection is heuristic: it flags overlap between the model output and the injected memory\'s distinctive content, not ground truth that the memory changed the answer.';

function isEntry(value: unknown): value is MemoryUsageEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.injectedCount === 'number' && typeof record.referencedCount === 'number';
}

export class MemoryUsageStatsStore {
  private readonly entries = new Map<string, MutableEntry>();
  private loaded = false;

  public constructor(private readonly filePath: string) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).entries
        : null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isEntry(value)) continue;
        this.entries.set(id, {
          injectedCount: value.injectedCount,
          referencedCount: value.referencedCount,
          lastInjectedAt: value.lastInjectedAt ?? null,
          lastReferencedAt: value.lastReferencedAt ?? null,
        });
      }
    } catch {
      // Corrupt file: start from empty, next write repairs it.
    }
  }

  private persist(): void {
    const record: Record<string, MemoryUsageEntry> = {};
    for (const [id, entry] of this.entries.entries()) record[id] = { ...entry };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify({ version: USAGE_FILE_VERSION, entries: record }, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private mutable(id: string): MutableEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { injectedCount: 0, referencedCount: 0, lastInjectedAt: null, lastReferencedAt: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  public recordInjected(ids: readonly string[], at: number = Date.now()): void {
    this.ensureLoaded();
    const unique = [...new Set(ids.filter((id) => id.trim()))];
    if (unique.length === 0) return;
    for (const id of unique) {
      const entry = this.mutable(id);
      entry.injectedCount += 1;
      entry.lastInjectedAt = at;
    }
    this.persist();
  }

  public recordReferenced(ids: readonly string[], at: number = Date.now()): void {
    this.ensureLoaded();
    const unique = [...new Set(ids.filter((id) => id.trim()))];
    if (unique.length === 0) return;
    for (const id of unique) {
      const entry = this.mutable(id);
      entry.referencedCount += 1;
      entry.lastReferencedAt = at;
    }
    this.persist();
  }

  public get(id: string): MemoryUsageEntry | null {
    this.ensureLoaded();
    const entry = this.entries.get(id);
    return entry ? { ...entry } : null;
  }

  /** Consolidation decay ordering seam — undefined when the id was never instrumented. */
  public lookup(id: string): MemoryConsolidationUsageSignal | undefined {
    const entry = this.get(id);
    if (!entry) return undefined;
    return {
      injectedCount: entry.injectedCount,
      referencedCount: entry.referencedCount,
      lastReferencedAt: entry.lastReferencedAt,
    };
  }

  public summary(sampleLimit = 5): MemoryUsageSummary {
    this.ensureLoaded();
    const all: MemoryUsageTopEntry[] = [...this.entries.entries()].map(([id, entry]) => ({ id, ...entry }));
    const everInjected = all.filter((entry) => entry.injectedCount > 0);
    const everReferenced = all.filter((entry) => entry.referencedCount > 0);
    const neverReferenced = everInjected.filter((entry) => entry.referencedCount === 0);
    const mostReferenced = [...everReferenced]
      .sort((left, right) => right.referencedCount - left.referencedCount || (right.lastReferencedAt ?? 0) - (left.lastReferencedAt ?? 0))
      .slice(0, Math.max(1, sampleLimit));
    const neverReferencedSample = [...neverReferenced]
      .sort((left, right) => right.injectedCount - left.injectedCount)
      .slice(0, Math.max(1, sampleLimit));
    return {
      totalTracked: all.length,
      everInjected: everInjected.length,
      everReferenced: everReferenced.length,
      neverReferenced: neverReferenced.length,
      mostReferenced,
      neverReferencedSample,
      signalNote: MEMORY_USAGE_SIGNAL_NOTE,
    };
  }
}
