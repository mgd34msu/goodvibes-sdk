import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
  foldMemoryStores,
  runHonestMemorySearch,
} from '../packages/sdk/src/platform/state/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

/**
 * The recall-honesty contract applied END TO END through a search: literal /
 * semantic-with-stated-fallback, and the recall-injection exclusion of flagged and
 * sub-floor records. This is the ONE composition the daemon route, the wire client,
 * and an offline surface all call, so the honesty is identical everywhere.
 */

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function embeddingRegistry(root: string): MemoryEmbeddingProviderRegistry {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  return new MemoryEmbeddingProviderRegistry({ configManager });
}

async function seededStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gv-honest-search-'));
  tmpRoots.push(root);
  // enableVectorIndex:false → the semantic index is DISABLED, a deterministic
  // "index cannot be consulted" state for the honest-fallback assertions.
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: embeddingRegistry(root),
    enableVectorIndex: false,
  });
  await store.init();
  await store.add({ cls: 'decision', summary: 'alpha deployment plan', review: { confidence: 80 } });
  await store.add({ cls: 'incident', summary: 'beta outage postmortem', review: { state: 'stale', confidence: 90 } });
  await store.add({ cls: 'fact', summary: 'gamma uncertain note', review: { confidence: 40 } });
  return { store, root };
}

describe('runHonestMemorySearch — recall-injection exclusion', () => {
  test('default (no recall) returns everything, unfiltered', async () => {
    const { store } = await seededStore();
    const result = runHonestMemorySearch(store, {}, {});
    expect(result.records.length).toBe(3);
    expect(result.recallFiltered).toBe(false);
    expect(result.excludedFlaggedCount).toBe(0);
    expect(result.excludedBelowFloorCount).toBe(0);
    expect(result.totalBeforeRecallFilter).toBe(3);
  });

  test('recall:true excludes flagged (stale) AND sub-floor records, counting each honestly', async () => {
    const { store } = await seededStore();
    const result = runHonestMemorySearch(store, {}, { recall: true });
    expect(result.recallFiltered).toBe(true);
    expect(result.records.map((r) => r.summary)).toEqual(['alpha deployment plan']);
    expect(result.excludedFlaggedCount).toBe(1); // the stale record
    expect(result.excludedBelowFloorCount).toBe(1); // the confidence-40 record
    expect(result.totalBeforeRecallFilter).toBe(3);
  });
});

describe('runHonestMemorySearch — semantic fallback is honest, never a silent empty', () => {
  test('semantic requested but index unavailable → literal fallback WITH a stated reason', async () => {
    const { store } = await seededStore();
    const result = runHonestMemorySearch(store, { query: 'alpha', semantic: true }, {});
    expect(result.requestedSemantic).toBe(true);
    expect(result.indexUnavailableReason).not.toBeNull();
    expect(result.indexUnavailableReason).toContain('disabled');
    expect(result.mode).toBe('literal');
    // The literal fallback still finds the record — not a silent empty.
    expect(result.records.map((r) => r.summary)).toEqual(['alpha deployment plan']);
    expect(result.caveat).toBeNull();
  });

  test('a plain literal search reports no requested-semantic and no unavailable reason', async () => {
    const { store } = await seededStore();
    const result = runHonestMemorySearch(store, { query: 'beta' }, {});
    expect(result.requestedSemantic).toBe(false);
    expect(result.indexUnavailableReason).toBeNull();
    expect(result.mode).toBe('literal');
  });
});

describe('MemoryRegistry.honestSearch delegates to the same composition', () => {
  test('registry honestSearch applies the recall contract', async () => {
    const { store } = await seededStore();
    const registry = new MemoryRegistry(store);
    const result = registry.honestSearch({}, { recall: true });
    expect(result.records.length).toBe(1);
    expect(result.excludedFlaggedCount + result.excludedBelowFloorCount).toBe(2);
  });
});

describe('fold interop — folded records honor the recall contract on the canonical store', () => {
  test('foldMemoryStores still works, and honestSearch over the canonical store excludes a folded flagged record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-fold-honest-'));
    tmpRoots.push(root);
    const registry = embeddingRegistry(root);

    // Two legacy per-surface source stores.
    const agentPath = join(root, 'agent', 'memory.sqlite');
    const tuiPath = join(root, 'tui', 'memory.sqlite');
    const agent = new MemoryStore(agentPath, { embeddingRegistry: registry, enableVectorIndex: false });
    await agent.init();
    await agent.add({ cls: 'decision', summary: 'agent good decision', review: { confidence: 75 } });
    await agent.add({ cls: 'incident', summary: 'agent flagged incident', review: { state: 'contradicted', confidence: 95 } });
    agent.close();
    const tui = new MemoryStore(tuiPath, { embeddingRegistry: registry, enableVectorIndex: false });
    await tui.init();
    await tui.add({ cls: 'pattern', summary: 'tui useful pattern', review: { confidence: 70 } });
    tui.close();

    const canonicalPath = resolveCanonicalMemoryDbPath(root);
    const canonical = new MemoryStore(canonicalPath, { embeddingRegistry: registry, enableVectorIndex: false });
    const report = await foldMemoryStores(canonical, [
      { label: 'agent-global', dbPath: agentPath },
      { label: 'tui:/repo', dbPath: tuiPath },
    ], { embeddingRegistry: registry });

    expect(report.totalImported).toBe(3);
    expect(report.failedSources).toEqual([]);

    // All three folded records are present unfiltered.
    const all = runHonestMemorySearch(canonical, {}, {});
    expect(all.records.length).toBe(3);

    // Under the recall contract the folded contradicted record is excluded.
    const recalled = runHonestMemorySearch(canonical, {}, { recall: true });
    expect(recalled.records.map((r) => r.summary).sort()).toEqual(['agent good decision', 'tui useful pattern']);
    expect(recalled.excludedFlaggedCount).toBe(1);
    canonical.close();
  });
});
