/**
 * Wave-5 (W5.3 Stage A, review fix round) — CodeIndexStore lifecycle honesty:
 *
 *  1. reroot()-during-build race: an in-flight buildFull() started against
 *     tree A must ABORT (epoch check after every await) when the store is
 *     rerooted to tree B mid-build — never resuming with relative(newRoot,
 *     oldPath) and writing wrong-rooted chunks into B's database. The abort
 *     is recorded honestly (abortReason) and never becomes lastBuild.
 *
 *  2. embedding-provider mismatch: after building under provider X, switching
 *     the default to Y must (a) surface an explicit mismatch string in
 *     stats(), (b) disable the vector search path — query vectors in Y-space
 *     against X-space rows are meaningless — degrading to lexical
 *     symbol/path matching labeled 'lexical', and (c) force a full re-embed
 *     on the next buildFull(), after which the mismatch clears and search is
 *     semantic again.
 *
 *  3. chunksIndexed accounting: unchanged files' pre-existing chunks are
 *     reported as chunksUnchanged, not silently folded into chunksIndexed.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../packages/sdk/src/platform/state/code-index-store.js';
import {
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  type MemoryEmbeddingProvider,
} from '../packages/sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRegistry(root: string): MemoryEmbeddingProviderRegistry {
  const configManager = new ConfigManager({ configDir: join(root, '.config') });
  return new MemoryEmbeddingProviderRegistry({ configManager });
}

function makeProvider(id: string, onEmbed?: () => Promise<void> | void): { provider: MemoryEmbeddingProvider; calls: () => number } {
  let calls = 0;
  const provider: MemoryEmbeddingProvider = {
    id,
    label: `Test Provider ${id}`,
    dimensions: 384,
    deterministic: true,
    embedSync(request) {
      calls++;
      return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
    },
    async embed(request) {
      calls++;
      await onEmbed?.();
      return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
    },
  };
  return { provider, calls: () => calls };
}

describe('CodeIndexStore — reroot()-during-build race (epoch abort)', () => {
  test('a build started against tree A aborts on reroot to tree B: no tree-A paths land in B\'s db, abort recorded', async () => {
    const rootA = makeRoot('gv-code-index-reroot-a-');
    const rootB = makeRoot('gv-code-index-reroot-b-');
    writeFileSync(join(rootA, 'tree-a-file.ts'), 'export const treeAOnly = 1;\n');
    writeFileSync(join(rootB, 'tree-b-file.ts'), 'export const treeBOnly = 2;\n');

    // Gate: the FIRST async embed signals it started, then blocks until released —
    // giving the test a deterministic mid-build window to reroot in.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let signalStarted: () => void = () => {};
    const firstEmbedStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let embedCalls = 0;
    const { provider } = makeProvider('gated-test');
    const gatedProvider: MemoryEmbeddingProvider = {
      ...provider,
      async embed(request) {
        embedCalls++;
        if (embedCalls === 1) {
          signalStarted();
          await gate;
        }
        return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
      },
    };
    const registry = makeRegistry(rootA);
    registry.register(gatedProvider, { makeDefault: true });

    const store = new CodeIndexStore(rootA, ':memory:', registry);
    store.init();

    const buildPromise = store.buildFull();
    await firstEmbedStarted;

    // Mid-build workspace swap. Epoch bumps; the in-flight build must abort at
    // its next await instead of writing tree-A chunks into tree B's fresh db.
    await store.reroot(rootB, ':memory:');
    releaseGate();

    const aborted = await buildPromise;
    expect(aborted.abortReason).toBe('build aborted by reroot');
    // The aborted build never becomes lastBuild and wrote nothing to B's db.
    expect(store.stats().lastBuild).toBeNull();
    expect(store.stats().indexedChunks).toBe(0);

    // A fresh build against tree B indexes ONLY tree-B content.
    const rebuilt = await store.buildFull();
    expect(rebuilt.abortReason).toBeUndefined();
    expect(rebuilt.filesIndexed).toBe(1);

    const hits = store.search('treeAOnly treeBOnly', { limit: 10 });
    expect(hits.some((r) => r.chunk.path === 'tree-a-file.ts')).toBe(false);
    expect(hits.some((r) => r.chunk.path === 'tree-b-file.ts')).toBe(true);
  });
});

describe('CodeIndexStore — embedding-provider mismatch honesty', () => {
  test('switching the default provider disables the vector path (lexical only), states the mismatch, and rebuild re-embeds', async () => {
    const root = makeRoot('gv-code-index-provider-');
    writeFileSync(join(root, 'a.ts'), 'export function fooBar(): number {\n  return 1;\n}\n');
    const registry = makeRegistry(root);
    const { provider: providerX } = makeProvider('prov-x');
    registry.register(providerX, { makeDefault: true });

    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();
    await store.buildFull();

    // Same provider: vector path, semantic label, no mismatch reported.
    expect(store.stats().embeddingProviderMismatch).toBeUndefined();
    const semanticHits = store.search('fooBar', { limit: 5 });
    expect(semanticHits.length).toBeGreaterThan(0);
    expect(semanticHits.every((r) => r.label === 'semantic')).toBe(true);

    // Provider switch: X-space vectors, Y-space queries — vector path must be skipped.
    const { provider: providerY, calls: yCalls } = makeProvider('prov-y');
    registry.register(providerY, { makeDefault: true });

    const mismatch = store.stats().embeddingProviderMismatch;
    expect(mismatch).toBeDefined();
    expect(mismatch).toContain('prov-x');
    expect(mismatch).toContain('prov-y');
    expect(mismatch).toContain('rebuild to re-embed');

    const lexicalHits = store.search('fooBar', { limit: 5 });
    expect(lexicalHits.length).toBeGreaterThan(0);
    expect(lexicalHits.every((r) => r.label === 'lexical')).toBe(true);
    expect(lexicalHits[0]!.chunk.symbol).toBe('fooBar');

    // Rebuild under Y: the unchanged-file shortcut is overridden (full re-embed),
    // the mismatch clears, and the vector path is honest again.
    const rebuild = await store.buildFull();
    expect(rebuild.chunksIndexed).toBeGreaterThan(0);
    expect(rebuild.filesUnchanged).toBe(0);
    expect(yCalls()).toBeGreaterThan(0);
    expect(store.stats().embeddingProviderMismatch).toBeUndefined();
    const postRebuildHits = store.search('fooBar', { limit: 5 });
    expect(postRebuildHits.every((r) => r.label === 'semantic')).toBe(true);
  });
});

describe('CodeIndexStore — chunk accounting honesty', () => {
  test('a rebuild over an unchanged tree reports chunksUnchanged, not chunksIndexed', async () => {
    const root = makeRoot('gv-code-index-counts-');
    writeFileSync(join(root, 'a.ts'), 'export function one(): number {\n  return 1;\n}\n\nexport function two(): number {\n  return 2;\n}\n\nexport const three = 3;\n');
    const registry = makeRegistry(root);
    const { provider } = makeProvider('count-prov');
    registry.register(provider, { makeDefault: true });

    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const first = await store.buildFull();
    expect(first.chunksIndexed).toBe(3);
    expect(first.chunksUnchanged).toBe(0);

    const second = await store.buildFull();
    expect(second.filesUnchanged).toBe(1);
    expect(second.chunksIndexed).toBe(0);
    expect(second.chunksUnchanged).toBe(3);
  });
});
