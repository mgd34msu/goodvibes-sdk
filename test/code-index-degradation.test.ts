/**
 * Repo code index (Stage A) — no-embedding-provider degradation.
 *
 * The registry ALWAYS has HASHED_MEMORY_EMBEDDING_PROVIDER as its default —
 * there is never literally "no provider" — but the hashed one is a
 * deterministic, weak lexical-ish signal. This suite covers the Stage-A
 * scope of that honesty contract: search still works in hashed mode (labeled
 * 'lexical'), the degradation reason is exposed exactly once (not per-turn
 * nagging), and a real provider flips retrieval quality to 'semantic' with no
 * further prompting.
 *
 * Stage B (auto-injection into coding turns) is explicitly deferred — see the
 * repo code index's staging decision — so this suite does not exercise
 * selectCodeContextForTask (it does not exist yet).
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../packages/sdk/src/platform/state/code-index-store.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER,
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  type MemoryEmbeddingProvider,
} from '../packages/sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-code-index-degradation-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('CodeIndexStore — no-embedding-provider degradation (Stage A)', () => {
  test('with only the hashed provider active, semantic retrieval is unavailable and the reason is stated exactly once', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), 'export function foo(): number {\n  return 1;\n}\n');
    const configManager = new ConfigManager({ configDir: join(root, '.config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    expect(registry.getDefaultProviderId()).toBe(HASHED_MEMORY_EMBEDDING_PROVIDER.id);

    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    expect(store.hasSemanticProvider()).toBe(false);
    const reason = store.describeDegradation();
    expect(reason).toBe('code auto-retrieval disabled: no semantic embedding provider configured');
    // Calling it again is idempotent (same value) — the caller decides how
    // often to surface it (once), the store never nags on its own.
    expect(store.describeDegradation()).toBe(reason);

    expect(store.stats().semanticRetrievalAvailable).toBe(false);
  });

  test('Stage-A search still returns results in hashed mode, labeled lexical (not semantic)', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), 'export function foo(): number {\n  return 1;\n}\n');
    const configManager = new ConfigManager({ configDir: join(root, '.config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();
    await store.buildFull();

    const results = store.search('foo', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.label).toBe('lexical');
    }
  });

  test('registering a real provider as default flips retrieval to semantic with no further prompting', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.ts'), 'export function foo(): number {\n  return 1;\n}\n');
    const configManager = new ConfigManager({ configDir: join(root, '.config') });
    const registry = new MemoryEmbeddingProviderRegistry({ configManager });
    const store = new CodeIndexStore(root, ':memory:', registry);
    store.init();

    const realProvider: MemoryEmbeddingProvider = {
      id: 'fake-real-provider',
      label: 'Fake Real Provider',
      dimensions: 384,
      embedSync(request) {
        return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
      },
      async embed(request) {
        return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
      },
    };
    registry.register(realProvider, { makeDefault: true });

    expect(store.hasSemanticProvider()).toBe(true);
    expect(store.describeDegradation()).toBeNull();

    await store.buildFull();
    const results = store.search('foo', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.label).toBe('semantic');
    }
  });
});
