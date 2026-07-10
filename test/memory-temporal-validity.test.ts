import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryStore,
  describeMemoryPromptEligibility,
  isMemoryTemporallyActive,
  isPromptActiveMemory,
  memoryRecordTemporalStatus,
  runHonestMemorySearch,
  selectKnowledgeForTaskScored,
  type MemoryRecord,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * Temporal validity windows (validFrom/validUntil): consulted at injection time
 * so expired/pending records stop being injected, but stay stored and are
 * labelled (expiry visible, never silent).
 */

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'gv-temporal-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
  await store.init();
  return store;
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = 1_000;
  return { id: 'm', scope: 'project', cls: 'fact', summary: 's', tags: [], provenance: [], reviewState: 'fresh', confidence: 80, createdAt: now, updatedAt: now, ...overrides };
}

describe('memoryRecordTemporalStatus', () => {
  const NOW = 5_000;
  test('active with no window, pending before validFrom, expired at/after validUntil', () => {
    expect(memoryRecordTemporalStatus(record(), NOW)).toBe('active');
    expect(memoryRecordTemporalStatus(record({ validFrom: 9_000 }), NOW)).toBe('pending');
    expect(memoryRecordTemporalStatus(record({ validUntil: 4_000 }), NOW)).toBe('expired');
    expect(memoryRecordTemporalStatus(record({ validFrom: 1_000, validUntil: 9_000 }), NOW)).toBe('active');
    expect(isMemoryTemporallyActive(record({ validUntil: 4_000 }), NOW)).toBe(false);
  });
});

describe('temporal helpers resist Array.filter misuse', () => {
  // Regression: passing a helper directly to Array.prototype.filter binds the
  // array INDEX (0, 1, 2 …) to `now`, so every expiry check silently compares
  // against a near-zero epoch and expired records leak through. The helpers now
  // reject the stray array argument loudly instead of absorbing it.
  const records = [record({ validUntil: 4_000 }), record(), record({ validFrom: 9_000 })];

  test('records.filter(isMemoryTemporallyActive) throws instead of silently defeating expiry', () => {
    // Cast to the filter callback signature: TS also rejects the bad call via the
    // never[] tail, so the cast is what lets us exercise the RUNTIME guard here.
    const bad = isMemoryTemporallyActive as unknown as (r: MemoryRecord, i: number, a: MemoryRecord[]) => boolean;
    expect(() => records.filter(bad)).toThrow(/filter\/map|extra argument/);
  });

  test('records.filter(isPromptActiveMemory) throws instead of silently defeating expiry', () => {
    const bad = isPromptActiveMemory as unknown as (r: MemoryRecord, i: number, a: MemoryRecord[]) => boolean;
    expect(() => records.filter(bad)).toThrow(/filter\/map|extra argument/);
  });

  test('the correct wrapped form still filters by the real window', () => {
    const NOW = 5_000;
    const active = records.filter((r) => isMemoryTemporallyActive(r, NOW));
    // Only the no-window record is active at NOW: the first is expired, the last pending.
    expect(active).toHaveLength(1);
  });
});

describe('describeMemoryPromptEligibility temporal gate', () => {
  const NOW = 5_000;
  test('expired record is ineligible and the reason says so (visible, not silent)', () => {
    const r = describeMemoryPromptEligibility(record({ validUntil: 4_000 }), NOW);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain('expired');
  });
  test('pending record is ineligible', () => {
    expect(describeMemoryPromptEligibility(record({ validFrom: 9_000 }), NOW).eligible).toBe(false);
  });
  test('in-window high-confidence record is eligible', () => {
    expect(describeMemoryPromptEligibility(record({ validFrom: 1_000, validUntil: 9_000 }), NOW).eligible).toBe(true);
  });
});

describe('store round-trip', () => {
  test('add persists validFrom/validUntil; get reads them back', async () => {
    const store = await makeStore();
    const added = await store.add({ cls: 'fact', summary: 'windowed', validFrom: 1000, validUntil: 2000 });
    expect(added.validFrom).toBe(1000);
    expect(added.validUntil).toBe(2000);
    const got = store.get(added.id);
    expect(got?.validFrom).toBe(1000);
    expect(got?.validUntil).toBe(2000);
  });

  test('update sets a window and can clear it with null', async () => {
    const store = await makeStore();
    const added = await store.add({ cls: 'fact', summary: 'x' });
    store.update(added.id, { validUntil: 5000 });
    expect(store.get(added.id)?.validUntil).toBe(5000);
    store.update(added.id, { validUntil: null });
    expect(store.get(added.id)?.validUntil).toBeUndefined();
  });
});

describe('injection paths exclude out-of-window records', () => {
  test('runHonestMemorySearch recall excludes expired and counts it', async () => {
    const store = await makeStore();
    await store.add({ cls: 'fact', summary: 'live one', review: { confidence: 80 } });
    await store.add({ cls: 'fact', summary: 'dead one', review: { confidence: 80 }, validUntil: Date.now() - 1000 });
    const result = runHonestMemorySearch(store, {}, { recall: true });
    const summaries = result.records.map((r) => r.summary);
    expect(summaries).toContain('live one');
    expect(summaries).not.toContain('dead one');
    expect(result.excludedOutOfWindowCount).toBe(1);
  });

  test('selectKnowledgeForTaskScored drops an expired record', async () => {
    const store = await makeStore();
    await store.add({ cls: 'decision', summary: 'kubernetes rollout policy', review: { confidence: 80 } });
    await store.add({ cls: 'decision', summary: 'kubernetes rollout policy expired', review: { confidence: 80 }, validUntil: Date.now() - 1000 });
    const registry = { getAll: () => store.search({}) };
    const scored = selectKnowledgeForTaskScored(registry, 'kubernetes rollout', [], 10);
    const summaries = scored.map((entry) => entry.injection.summary);
    expect(summaries).toContain('kubernetes rollout policy');
    expect(summaries).not.toContain('kubernetes rollout policy expired');
  });
});
