import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import { KnowledgeService } from '../packages/sdk/src/platform/knowledge/service.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../packages/sdk/src/platform/state/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge memory sync', () => {
  test('keeps reviewed project memory visible in default regular knowledge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-memory-sync-'));
    tmpRoots.push(root);
    const configManager = new ConfigManager({ configDir: join(root, 'config') });
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
      enableVectorIndex: false,
    });
    await memoryStore.init();
    const memoryRegistry = new MemoryRegistry(memoryStore);
    await memoryRegistry.add({
      scope: 'project',
      cls: 'fact',
      summary: 'Use sqlite-vec for semantic recall',
      detail: 'sqlite-vec is the project memory vector index backend.',
      tags: ['sqlite-vec', 'semantic-recall'],
      review: { state: 'reviewed', confidence: 95 },
    });

    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const service = new KnowledgeService(
      store,
      new ArtifactStore({ rootDir: join(root, 'artifacts') }),
      undefined,
      { memoryRegistry },
    );

    await service.reindex();

    expect(store.status().nodeCount).toBe(3);
    expect(service.listNodes(100).map((node) => node.title)).toContain('Use sqlite-vec for semantic recall');
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.title)).toEqual(
      expect.arrayContaining(['Use sqlite-vec for semantic recall', 'sqlite-vec', 'semantic-recall']),
    );
    const memoryNode = service.queryNodes({ query: 'sqlite-vec', limit: 10 }).items.find((node) => node.kind === 'memory');
    expect(memoryNode?.metadata.knowledgeSpaceId).toBe('default');
    expect(memoryNode?.metadata.namespace).toBe('default');
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.length).toBeGreaterThanOrEqual(3);
  });
});
