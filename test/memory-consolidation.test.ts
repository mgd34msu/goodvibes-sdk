import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveMemoryConsolidationConfig,
  runMemoryConsolidation,
} from '../packages/sdk/src/platform/state/index.js';
import type {
  MemoryConsolidationRegistry,
  MemoryConsolidationUsageSignal,
  MemoryRecord,
  MemoryReviewPatch,
  ResolvedMemoryConsolidationConfig,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * Idle-time memory consolidation policy (hoisted from the agent surface).
 * Asserts the reversible-only contract: merges mark losers stale (never delete),
 * decay orders never-referenced first, and new-memory/delete work is PROPOSED,
 * never silently written. Semantics must match the agent original verbatim.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1_000_000_000_000;
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    scope: 'project',
    cls: 'fact',
    summary: 'a fact',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** In-memory registry satisfying the consolidation write seam, so tests control every field. */
class FakeRegistry implements MemoryConsolidationRegistry {
  public readonly records = new Map<string, MemoryRecord>();
  public readonly reviewCalls: Array<{ id: string; patch: MemoryReviewPatch }> = [];
  public readonly updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

  constructor(records: readonly MemoryRecord[]) {
    for (const r of records) this.records.set(r.id, r);
  }

  getAll(): readonly MemoryRecord[] {
    return [...this.records.values()];
  }

  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    this.reviewCalls.push({ id, patch });
    const updated: MemoryRecord = {
      ...existing,
      reviewState: patch.state ?? existing.reviewState,
      confidence: patch.confidence ?? existing.confidence,
      ...(patch.reviewedBy !== undefined ? { reviewedBy: patch.reviewedBy } : {}),
      ...(patch.staleReason !== undefined ? { staleReason: patch.staleReason } : {}),
    };
    this.records.set(id, updated);
    return updated;
  }

  update(id: string, patch: { scope?: MemoryRecord['scope']; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null {
    const existing = this.records.get(id);
    if (!existing) return null;
    this.updateCalls.push({ id, patch });
    const updated: MemoryRecord = { ...existing, ...(patch.tags ? { tags: patch.tags } : {}) };
    this.records.set(id, updated);
    return updated;
  }
}

const NOW = 1_000_000_000_000;
const cfg = (over: Partial<ResolvedMemoryConsolidationConfig> = {}): ResolvedMemoryConsolidationConfig => ({
  ...DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
  ...over,
});

describe('runMemoryConsolidation — merges', () => {
  test('exact-duplicate summary merges losers to stale, unions tags, never deletes', () => {
    const survivor = rec({ id: 'survivor', reviewState: 'reviewed', confidence: 80, updatedAt: NOW, summary: 'CI deploy note', tags: ['ci'] });
    const dup = rec({ id: 'dup', reviewState: 'fresh', confidence: 60, updatedAt: NOW - 1000, summary: 'CI deploy note', tags: ['deploy'] });
    const reg = new FakeRegistry([survivor, dup]);

    const receipt = runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'manual', idle: true, randomSuffix: () => 'abc123' });

    expect(receipt.merged.length).toBe(1);
    expect(receipt.merged[0]!.survivorId).toBe('survivor');
    expect(receipt.merged[0]!.duplicateIds).toContain('dup');
    // Loser marked stale, NOT deleted.
    expect(reg.records.size).toBe(2);
    expect(reg.records.get('dup')!.reviewState).toBe('stale');
    // Tag union applied to survivor.
    expect(reg.records.get('survivor')!.tags.sort()).toEqual(['ci', 'deploy']);
    expect(receipt.runId).toBe(`mcon-${NOW.toString(36)}-abc123`);
  });

  test('same-summary records across scopes are PROPOSED, never merged', () => {
    const a = rec({ id: 'a', scope: 'project', summary: 'shared', updatedAt: NOW });
    const b = rec({ id: 'b', scope: 'team', summary: 'shared', updatedAt: NOW });
    const reg = new FakeRegistry([a, b]);
    const receipt = runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    expect(receipt.merged.length).toBe(0);
    expect(receipt.proposed.some((p) => p.kind === 'cross-scope-duplicate')).toBe(true);
    expect(reg.records.get('a')!.reviewState).toBe('fresh');
  });
});

describe('runMemoryConsolidation — decay', () => {
  test('aged never-referenced record decays by step; usage signal availability reported', () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const receipt = runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 40 }),
      now: NOW, trigger: 'idle', idle: true,
      usageLookup: () => undefined,
    });
    expect(receipt.decayed.length).toBe(1);
    expect(receipt.decayed[0]!.toConfidence).toBe(50);
    expect(reg.records.get('aged')!.confidence).toBe(50);
    expect(receipt.usageSignalAvailable).toBe(true);
  });

  test('decay to/below archive floor marks the record stale (archived)', () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const receipt = runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0, decayConfidenceStep: 10, archiveConfidenceFloor: 55 }),
      now: NOW, trigger: 'idle', idle: true,
    });
    expect(receipt.archived.length).toBe(1);
    expect(reg.records.get('aged')!.reviewState).toBe('stale');
  });

  test('referenced records NEVER decay', () => {
    const aged = rec({ id: 'aged', confidence: 60, updatedAt: NOW - 100 * DAY_MS });
    const reg = new FakeRegistry([aged]);
    const signal: MemoryConsolidationUsageSignal = { injectedCount: 5, referencedCount: 4, lastReferencedAt: NOW };
    const receipt = runMemoryConsolidation({
      memoryRegistry: reg,
      config: cfg({ decayAgeDays: 0 }),
      now: NOW, trigger: 'idle', idle: true,
      usageLookup: (id) => (id === 'aged' ? signal : undefined),
    });
    expect(receipt.decayed.length).toBe(0);
    expect(receipt.archived.length).toBe(0);
    expect(reg.records.get('aged')!.confidence).toBe(60);
  });
});

describe('runMemoryConsolidation — stale-delete proposals', () => {
  test('long-stale record is proposed for deletion but not touched', () => {
    const stale = rec({ id: 'old', reviewState: 'stale', updatedAt: NOW - 200 * DAY_MS });
    const reg = new FakeRegistry([stale]);
    const receipt = runMemoryConsolidation({ memoryRegistry: reg, config: cfg(), now: NOW, trigger: 'idle', idle: true });
    const proposal = receipt.proposed.find((p) => p.kind === 'stale-delete');
    expect(proposal).toBeDefined();
    expect(proposal!.ids).toContain('old');
    expect(proposal!.route).toContain('memory action:"delete"');
    expect(reg.records.get('old')).not.toBeUndefined();
  });
});

describe('resolveMemoryConsolidationConfig', () => {
  test('absent learning block yields defaults', () => {
    const resolved = resolveMemoryConsolidationConfig({ getRaw: () => ({}) });
    expect(resolved).toEqual(DEFAULT_MEMORY_CONSOLIDATION_CONFIG);
  });

  test('user block overrides per key, wrong-typed values fall back', () => {
    const resolved = resolveMemoryConsolidationConfig({
      getRaw: () => ({ learning: { consolidation: { enabled: true, maxMergesPerRun: 3, decayAgeDays: 'nope' } } }),
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.maxMergesPerRun).toBe(3);
    expect(resolved.decayAgeDays).toBe(DEFAULT_MEMORY_CONSOLIDATION_CONFIG.decayAgeDays);
  });
});

describe('MemoryRegistry satisfies the consolidation seam', () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  test('runs over a real store without error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-mcon-'));
    roots.push(root);
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const store = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await store.init();
    const registry = new MemoryRegistry(store);
    await registry.add({ cls: 'fact', summary: 'one and only fact' });
    const receipt = runMemoryConsolidation({ memoryRegistry: registry, config: cfg(), now: Date.now(), trigger: 'manual', idle: true });
    expect(receipt.scanned).toBe(1);
    expect(receipt.note).toContain('never written silently');
  });
});
