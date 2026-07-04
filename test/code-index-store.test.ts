/**
 * Wave-5 (wo802, W5.3 Stage A) — CodeIndexStore unit suite: chunking
 * determinism, incremental reindex (unchanged/changed/deleted files), and
 * the "never silently drop a file" fallback contract.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodeIndexStore,
  type CodeChunk,
} from '../packages/sdk/src/platform/state/code-index-store.js';
import {
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  type MemoryEmbeddingProvider,
} from '../packages/sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-code-index-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

/** A deterministic, call-counting embedding provider registered as default (semantic, not hashed). */
function makeCountingRegistry(root: string): { registry: MemoryEmbeddingProviderRegistry; callCount: () => number } {
  const configManager = new ConfigManager({ configDir: join(root, '.config') });
  const registry = new MemoryEmbeddingProviderRegistry({ configManager });
  let calls = 0;
  const provider: MemoryEmbeddingProvider = {
    id: 'counting-test',
    label: 'Counting Test Provider',
    dimensions: 384,
    deterministic: true,
    embedSync(request) {
      calls++;
      return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
    },
    async embed(request) {
      calls++;
      return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
    },
  };
  registry.register(provider, { makeDefault: true });
  return { registry, callCount: () => calls };
}

function makeStore(root: string, registry: MemoryEmbeddingProviderRegistry): CodeIndexStore {
  const store = new CodeIndexStore(root, ':memory:', registry);
  store.init();
  return store;
}

const TS_FIXTURE = `export function foo(): number {
  return 1;
}

export class Bar {
  method(): number {
    return 2;
  }
}

export const baz = 42;
`;

describe('CodeIndexStore — chunking determinism', () => {
  test('chunk count matches top-level tree-sitter symbol count', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    const stats = await store.buildFull();
    // foo (function), Bar (class), baz (constant) — method() is nested, not top-level.
    expect(stats.chunksIndexed).toBe(3);
    expect(stats.filesIndexed).toBe(1);
    expect(stats.skip.chunkedByWindow).toBe(0);

    const results = store.search('foo', { limit: 10 });
    const symbols = results.map((r) => r.chunk.symbol).sort();
    expect(symbols).toEqual(['Bar', 'baz', 'foo']);
  });

  test('building the same unchanged tree twice yields identical chunk ids', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    await store.buildFull();
    const first = store.search('foo bar baz', { limit: 10 }).map((r) => r.chunk.chunkId).sort();

    const store2 = makeStore(root, registry);
    await store2.buildFull();
    const second = store2.search('foo bar baz', { limit: 10 }).map((r) => r.chunk.chunkId).sort();

    expect(second).toEqual(first);
  });
});

describe('CodeIndexStore — incremental reindex', () => {
  test('re-indexing an unchanged file does not re-embed', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    const { registry, callCount } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    await store.buildFull();
    const firstCallCount = callCount();
    expect(firstCallCount).toBeGreaterThan(0);

    await store.buildFull();
    expect(callCount()).toBe(firstCallCount);
  });

  test('a changed file re-embeds only that file\'s chunks; other files are untouched', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    writeFileSync(join(root, 'b.ts'), 'export function untouched(): number {\n  return 9;\n}\n');
    const { registry, callCount } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    await store.buildFull();
    const bChunksBefore = store.search('untouched', { limit: 10 }).filter((r) => r.chunk.path === 'b.ts');
    expect(bChunksBefore.length).toBeGreaterThan(0);
    const bChunkIdBefore = bChunksBefore[0]!.chunk.chunkId;

    const afterFirstBuild = callCount();
    writeFileSync(join(root, 'a.ts'), `${TS_FIXTURE}\nexport function extra(): number {\n  return 3;\n}\n`);
    await store.buildFull();
    expect(callCount()).toBeGreaterThan(afterFirstBuild);

    const bChunksAfter = store.search('untouched', { limit: 10 }).filter((r) => r.chunk.path === 'b.ts');
    expect(bChunksAfter.length).toBe(bChunksBefore.length);
    expect(bChunksAfter[0]!.chunk.chunkId).toBe(bChunkIdBefore);

    const aChunks = store.search('extra foo bar baz', { limit: 20 }).filter((r) => r.chunk.path === 'a.ts');
    const symbolNames = aChunks.map((r) => r.chunk.symbol).sort();
    expect(symbolNames).toContain('extra');
  });

  test('a deleted file\'s chunks are removed on the next full build', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    writeFileSync(join(root, 'gone.ts'), 'export const removeMe = 1;\n');
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    const first = await store.buildFull();
    expect(first.filesIndexed).toBe(2);

    rmSync(join(root, 'gone.ts'));
    const second = await store.buildFull();
    expect(second.filesRemoved).toBe(1);

    const stats = store.stats();
    expect(stats.indexedFiles).toBe(1);
    const remaining = store.search('removeMe', { limit: 10 });
    expect(remaining.find((r) => r.chunk.path === 'gone.ts')).toBeUndefined();
  });

  test('reindexFile incrementally reindexes a single path without a full build', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);
    await store.buildFull();

    writeFileSync(join(root, 'a.ts'), 'export function onlyOne(): number {\n  return 1;\n}\n');
    const outcome = await store.reindexFile(join(root, 'a.ts'));
    expect(outcome.indexed).toBe(true);
    expect(outcome.mode).toBe('symbols');

    const stats = store.stats();
    expect(stats.indexedChunks).toBe(1);
  });
});

describe('CodeIndexStore — never silently drops a non-empty file', () => {
  test('an unsupported language falls back to windowed chunks, not zero chunks', async () => {
    const root = makeRoot();
    const longRustFile = Array.from({ length: 80 }, (_, i) => `fn f${i}() {}`).join('\n');
    writeFileSync(join(root, 'a.rs'), longRustFile);
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    const stats = await store.buildFull();
    expect(stats.skip.chunkedByWindow).toBe(1);
    expect(stats.chunksIndexed).toBeGreaterThan(0);
    expect(stats.filesIndexed).toBe(1);
  });

  test('a supported-language file with zero top-level symbols (a re-export barrel) still gets windowed chunks', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'barrel.ts'), Array.from({ length: 30 }, (_, i) => `export { x${i} } from './x${i}.js';`).join('\n'));
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    const stats = await store.buildFull();
    expect(stats.skip.chunkedByWindow).toBe(1);
    expect(stats.chunksIndexed).toBeGreaterThan(0);
  });

  test('a genuinely empty file yields zero chunks without being counted as a fallback', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'empty.ts'), '');
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);

    const stats = await store.buildFull();
    expect(stats.skip.chunkedByWindow).toBe(0);
    expect(stats.chunksIndexed).toBe(0);
  });
});

describe('CodeIndexStore — chunk shape', () => {
  test('chunk_id is a deterministic function of path + lines + content hash', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), TS_FIXTURE);
    const { registry } = makeCountingRegistry(root);
    const store = makeStore(root, registry);
    await store.buildFull();

    const results = store.search('foo', { limit: 10 });
    const fooChunk = results.find((r) => r.chunk.symbol === 'foo')?.chunk as CodeChunk;
    expect(fooChunk).toBeDefined();
    expect(fooChunk.path).toBe('a.ts');
    expect(fooChunk.startLine).toBe(1);
    expect(fooChunk.chunkId).toMatch(/^[0-9a-f]{64}$/);
  });
});
