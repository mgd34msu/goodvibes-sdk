import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/_internal/platform/artifacts/index.js';
import { KnowledgeProjectionService } from '../packages/sdk/src/_internal/platform/knowledge/projections.js';
import { renderKnowledgeMap } from '../packages/sdk/src/_internal/platform/knowledge/map.js';
import { KnowledgeStore } from '../packages/sdk/src/_internal/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge generated projections and maps', () => {
  test('materializes base knowledge projections as stable generated sources', async () => {
    const { store, artifactStore } = createStores();
    const projectionService = new KnowledgeProjectionService(store, artifactStore);
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'document',
      title: 'Project Manual',
      canonicalUri: 'manual://project',
      summary: 'Operational notes.',
      tags: ['manual'],
      status: 'indexed',
    });
    const node = await store.upsertNode({
      kind: 'topic',
      slug: 'operations',
      title: 'Operations',
      summary: 'Operations notes.',
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation: 'mentions',
    });

    const first = await projectionService.materialize({ kind: 'source', id: source.id });
    const second = await projectionService.materialize({ kind: 'source', id: source.id });
    const generatedSources = store.listSources(20).filter((entry) => entry.metadata.generatedProjection === true);
    const map = renderKnowledgeMap({
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      issues: store.listIssues(20),
    }, { includeSources: true });

    expect(first.artifactCreated).toBe(true);
    expect(second.artifactCreated).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect(generatedSources).toHaveLength(1);
    expect(first.source?.metadata.generatedKnowledgePage).toBe(true);
    expect(map.nodes.some((entry) => entry.id === generatedSources[0]!.id)).toBe(true);
    expect(map.svg).toContain('Project Manual');
  });
});

function createStores(): {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-projection-'));
  tmpRoots.push(root);
  return {
    store: new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }),
  };
}
