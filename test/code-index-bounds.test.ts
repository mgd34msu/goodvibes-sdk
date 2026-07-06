/**
 * Repo code index (Stage A) — CodeIndexStore bounds + honest skip
 * reporting: maxFiles/maxFileBytes/binary/gitignore exclusions all appear in
 * the skip report with honest counts, and .gitignore'd paths are never indexed.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../packages/sdk/src/platform/state/code-index-store.js';
import { MemoryEmbeddingProviderRegistry } from '../packages/sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-code-index-bounds-'));
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

describe('CodeIndexStore — bounds honesty', () => {
  test('gitignored paths are never indexed', async () => {
    const root = makeRoot();
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(root, 'ignored.ts'), 'export const secret = 1;\n');
    writeFileSync(join(root, 'kept.ts'), 'export const kept = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const stats = await store.buildFull();
    expect(stats.skip.ignoredByGitignore).toBe(1);
    expect(stats.filesIndexed).toBe(1);

    const results = store.search('secret kept', { limit: 10 });
    expect(results.some((r) => r.chunk.path === 'ignored.ts')).toBe(false);
    expect(results.some((r) => r.chunk.path === 'kept.ts')).toBe(true);
  });

  test('files over maxFileBytes are skipped and counted as tooLarge', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'big.ts'), `export const big = '${'x'.repeat(2000)}';\n`);
    writeFileSync(join(root, 'small.ts'), 'export const small = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry, { maxFileBytes: 200 });
    store.init();

    const stats = await store.buildFull();
    expect(stats.skip.tooLarge).toBe(1);
    expect(stats.filesIndexed).toBe(1);
    const results = store.search('big small', { limit: 10 });
    expect(results.some((r) => r.chunk.path === 'big.ts')).toBe(false);
  });

  test('files beyond maxFiles are skipped and counted as overFileCap, honest total preserved', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
    writeFileSync(join(root, 'c.ts'), 'export const c = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry, { maxFiles: 1 });
    store.init();

    const stats = await store.buildFull();
    expect(stats.filesScanned).toBe(3);
    expect(stats.filesIndexed).toBe(1);
    expect(stats.skip.overFileCap).toBe(2);
    // The two bounds report separately — the byte budget was never hit here.
    expect(stats.skip.overTotalBytes).toBe(0);
  });

  test('files beyond maxTotalBytes are skipped and counted as overTotalBytes (distinct from the file-count cap)', async () => {
    const root = makeRoot();
    // ~40 bytes each; a 50-byte budget accepts exactly the first (sorted) file.
    writeFileSync(join(root, 'a.ts'), 'export const aaaaaaaaaa = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const bbbbbbbbbb = 1;\n');
    writeFileSync(join(root, 'c.ts'), 'export const cccccccccc = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry, { maxTotalBytes: 50 });
    store.init();

    const stats = await store.buildFull();
    expect(stats.filesScanned).toBe(3);
    expect(stats.filesIndexed).toBe(1);
    expect(stats.skip.overTotalBytes).toBe(2);
    expect(stats.skip.overFileCap).toBe(0);
  });

  test('nested .gitignore files are honored relative to their own directory', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'sub'), { recursive: true });
    // No root .gitignore at all — only the nested one excludes.
    writeFileSync(join(root, 'sub', '.gitignore'), 'ignored.ts\n');
    writeFileSync(join(root, 'sub', 'ignored.ts'), 'export const nestedSecret = 1;\n');
    writeFileSync(join(root, 'sub', 'kept.ts'), 'export const nestedKept = 1;\n');
    writeFileSync(join(root, 'top.ts'), 'export const top = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const stats = await store.buildFull();
    expect(stats.skip.ignoredByGitignore).toBe(1);

    const results = store.search('nestedSecret nestedKept top', { limit: 10 });
    expect(results.some((r) => r.chunk.path === 'sub/ignored.ts')).toBe(false);
    expect(results.some((r) => r.chunk.path === 'sub/kept.ts')).toBe(true);
    expect(results.some((r) => r.chunk.path === 'top.ts')).toBe(true);
  });

  test('binary files are skipped and counted as binary, never indexed', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.bin'), Buffer.from([0, 1, 2, 0, 3, 4]));
    writeFileSync(join(root, 'kept.ts'), 'export const kept = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const stats = await store.buildFull();
    expect(stats.skip.binary).toBe(1);
    expect(stats.filesIndexed).toBe(1);
  });

  test('skip counts never silently disappear across an empty build', async () => {
    const root = makeRoot();
    writeFileSync(join(root, '.gitignore'), 'ignored/**\n');
    writeFileSync(join(root, 'kept.ts'), 'export const kept = 1;\n');
    const registry = makeRegistry(root);
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const stats = await store.buildFull();
    // Every counter is a real, non-negative, reportable number — never undefined/NaN.
    for (const value of Object.values(stats.skip)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
