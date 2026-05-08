import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { listGeneratedKnowledgePages } from '../packages/sdk/src/platform/knowledge/generated-pages.js';
import { materializeGeneratedKnowledgeProjection } from '../packages/sdk/src/platform/knowledge/generated-projections.js';
import { renderDevicePassportPage } from '../packages/sdk/src/platform/knowledge/home-graph/rendering.js';
import { buildKnowledgePacketSync } from '../packages/sdk/src/platform/knowledge/packet.js';
import { KnowledgeProjectionService } from '../packages/sdk/src/platform/knowledge/projections.js';
import { renderKnowledgeMap } from '../packages/sdk/src/platform/knowledge/map.js';
import { KnowledgeService } from '../packages/sdk/src/platform/knowledge/service.js';
import { knowledgeSpaceMetadata } from '../packages/sdk/src/platform/knowledge/spaces.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { semanticFactId } from '../packages/sdk/src/platform/knowledge/semantic/utils.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge generated projections and maps', () => {
  test('deletes replaced generated page artifacts when regenerated markdown changes', async () => {
    const { store, artifactStore } = createStores();
    const topic = await store.upsertNode({
      kind: 'topic',
      slug: 'device-page-target',
      title: 'Device Page Target',
      aliases: [],
      confidence: 90,
    });

    const first = await materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nFirst version.',
      projectionKind: 'test-generated-page',
      target: { kind: 'node', id: topic.id },
    });
    const second = await materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nSecond version with changed content.',
      projectionKind: 'test-generated-page',
      target: { kind: 'node', id: topic.id },
    });

    expect(first.artifact.id).not.toBe(second.artifact.id);
    expect(artifactStore.get(first.artifact.id)).toBeNull();
    expect(artifactStore.get(second.artifact.id)).not.toBeNull();
  });

  test('keeps the previous generated artifact when replacement source persistence fails', async () => {
    const { store, artifactStore } = createStores();
    const first = await materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nFirst version.',
      projectionKind: 'test-generated-page',
    });
    const failingStore = Object.create(store) as KnowledgeStore;
    failingStore.upsertSource = async () => {
        throw new Error('source persistence failed');
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: failingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nSecond version.',
      projectionKind: 'test-generated-page',
    })).rejects.toThrow('source persistence failed');

    expect(artifactStore.get(first.artifact.id)).not.toBeNull();
    expect(store.getSource(first.source.id)?.artifactId).toBe(first.artifact.id);
    expect(artifactStore.list(20).map((artifact) => artifact.id)).toEqual([first.artifact.id]);
  });

  test('rejects missing generated page targets before replacing the persisted source artifact', async () => {
    const { store, artifactStore } = createStores();
    const first = await materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nFirst version.',
      projectionKind: 'test-generated-page',
    });

    await expect(materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nSecond version with invalid target.',
      projectionKind: 'test-generated-page',
      target: { kind: 'node', id: 'missing-node' },
    })).rejects.toThrow('target node does not exist');

    expect(artifactStore.get(first.artifact.id)).not.toBeNull();
    expect(store.getSource(first.source.id)?.artifactId).toBe(first.artifact.id);
    expect(artifactStore.list(20).map((artifact) => artifact.id)).toEqual([first.artifact.id]);
  });

  test('rejects missing generated page artifact targets before creating projection artifacts', async () => {
    const { store, artifactStore } = createStores();

    await expect(materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-device-page-target',
      canonicalUri: 'knowledge://generated/device/page-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nInvalid artifact target.',
      projectionKind: 'test-generated-page',
      target: { kind: 'artifact', id: 'missing-artifact' },
    })).rejects.toThrow('target artifact does not exist');

    expect(store.getSource('kg-gen-device-page-target')).toBeNull();
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('rejects unsupported generated page target kinds before creating projection artifacts', async () => {
    const { store, artifactStore } = createStores();

    await expect(materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-unsupported-target',
      canonicalUri: 'knowledge://generated/device/unsupported-target',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nUnsupported target kind.',
      projectionKind: 'test-generated-page',
      target: { kind: 'session', id: 'session-1' } as never,
    })).rejects.toThrow('target kind is not supported: session');

    expect(store.getSource('kg-gen-unsupported-target')).toBeNull();
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('removes newly-created projection artifacts when cancellation happens before source persistence', async () => {
    const { store, artifactStore } = createStores();
    const controller = new AbortController();
    const abortingArtifactStore = Object.create(artifactStore) as ArtifactStore;
    abortingArtifactStore.create = async (input) => {
      const artifact = await artifactStore.create(input);
      controller.abort();
      return artifact;
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store,
      artifactStore: abortingArtifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-cancelled-device-page',
      canonicalUri: 'knowledge://generated/device/cancelled-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nCancelled before source persistence.',
      projectionKind: 'test-generated-page',
      signal: controller.signal,
    })).rejects.toThrow('Generated knowledge projection was cancelled');

    expect(store.getSource('kg-gen-cancelled-device-page')).toBeNull();
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('removes newly-created generated sources when cancellation happens after source persistence', async () => {
    const { store, artifactStore } = createStores();
    const controller = new AbortController();
    const abortingStore = Object.create(store) as KnowledgeStore;
    abortingStore.upsertSource = async (input) => {
      const source = await store.upsertSource(input);
      controller.abort();
      return source;
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: abortingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-source-cancelled-device-page',
      canonicalUri: 'knowledge://generated/device/source-cancelled-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nCancelled after source persistence.',
      projectionKind: 'test-generated-page',
      signal: controller.signal,
    })).rejects.toThrow('Generated knowledge projection was cancelled');

    expect(store.getSource('kg-gen-source-cancelled-device-page')).toBeNull();
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('removes newly-created generated sources when source persistence throws after writing', async () => {
    const { store, artifactStore } = createStores();
    const failingStore = Object.create(store) as KnowledgeStore;
    failingStore.upsertSource = async (input) => {
      await store.upsertSource(input);
      throw new Error('source write failed after persistence');
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: failingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-source-failed-device-page',
      canonicalUri: 'knowledge://generated/device/source-failed-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nSource write fails after persistence.',
      projectionKind: 'test-generated-page',
    })).rejects.toThrow('source write failed after persistence');

    expect(store.getSource('kg-gen-source-failed-device-page')).toBeNull();
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('removes newly-created generated edges when cancellation happens after edge persistence', async () => {
    const { store, artifactStore } = createStores();
    const target = await store.upsertNode({
      kind: 'topic',
      slug: 'edge-cancel-target',
      title: 'Edge Cancel Target',
    });
    const controller = new AbortController();
    const abortingStore = Object.create(store) as KnowledgeStore;
    abortingStore.upsertEdge = async (input) => {
      const edge = await store.upsertEdge(input);
      controller.abort();
      return edge;
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: abortingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-edge-cancelled-device-page',
      canonicalUri: 'knowledge://generated/device/edge-cancelled-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nCancelled after edge persistence.',
      projectionKind: 'test-generated-page',
      target: { kind: 'node', id: target.id },
      signal: controller.signal,
    })).rejects.toThrow('Generated knowledge projection was cancelled');

    expect(store.getSource('kg-gen-edge-cancelled-device-page')).toBeNull();
    expect(store.listEdges()).not.toContainEqual(expect.objectContaining({
      fromKind: 'source',
      fromId: 'kg-gen-edge-cancelled-device-page',
      toKind: 'node',
      toId: target.id,
    }));
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('removes newly-created generated edges when edge persistence throws after writing', async () => {
    const { store, artifactStore } = createStores();
    const target = await store.upsertNode({
      kind: 'topic',
      slug: 'edge-fail-target',
      title: 'Edge Fail Target',
    });
    const failingStore = Object.create(store) as KnowledgeStore;
    failingStore.upsertEdge = async (input) => {
      await store.upsertEdge(input);
      throw new Error('edge write failed after persistence');
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: failingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-edge-failed-device-page',
      canonicalUri: 'knowledge://generated/device/edge-failed-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nEdge write fails after persistence.',
      projectionKind: 'test-generated-page',
      target: { kind: 'node', id: target.id },
    })).rejects.toThrow('edge write failed after persistence');

    expect(store.getSource('kg-gen-edge-failed-device-page')).toBeNull();
    expect(store.listEdges()).not.toContainEqual(expect.objectContaining({
      fromKind: 'source',
      fromId: 'kg-gen-edge-failed-device-page',
      toKind: 'node',
      toId: target.id,
    }));
    expect(artifactStore.list(20)).toEqual([]);
  });

  test('restores previous generated source and edge records exactly after replacement cancellation', async () => {
    const { store, artifactStore } = createStores();
    const target = await store.upsertNode({
      kind: 'topic',
      slug: 'restore-target',
      title: 'Restore Target',
    });
    const first = await materializeGeneratedKnowledgeProjection({
      store,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: 'kg-gen-restored-device-page',
      canonicalUri: 'knowledge://generated/device/restored-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nOriginal content.',
      projectionKind: 'test-generated-page',
      metadata: { originalOnly: true },
      edgeMetadata: { edgeOriginalOnly: true },
      target: { kind: 'node', id: target.id },
    });
    const previousSource = store.getSource(first.source.id)!;
    const previousEdge = first.linked!;
    const controller = new AbortController();
    const abortingStore = Object.create(store) as KnowledgeStore;
    abortingStore.upsertEdge = async (input) => {
      const edge = await store.upsertEdge(input);
      controller.abort();
      return edge;
    };

    await expect(materializeGeneratedKnowledgeProjection({
      store: abortingStore,
      artifactStore,
      connectorId: 'generated-pages',
      sourceId: first.source.id,
      canonicalUri: 'knowledge://generated/device/restored-page',
      title: 'Generated Device Page',
      filename: 'device-page.md',
      markdown: '# Device\n\nReplacement content.',
      projectionKind: 'test-generated-page',
      metadata: { replacementOnly: true },
      edgeMetadata: { edgeReplacementOnly: true },
      target: { kind: 'node', id: target.id },
      signal: controller.signal,
    })).rejects.toThrow('Generated knowledge projection was cancelled');

    expect(store.getSource(first.source.id)).toEqual(previousSource);
    expect(store.getSource(first.source.id)?.metadata).not.toHaveProperty('replacementOnly');
    expect(store.listEdges().find((edge) => edge.id === previousEdge.id)).toEqual(previousEdge);
    expect(store.listEdges().find((edge) => edge.id === previousEdge.id)?.metadata).not.toHaveProperty('edgeReplacementOnly');
    expect(artifactStore.get(first.artifact.id)).not.toBeNull();
    expect(artifactStore.list(20).map((artifact) => artifact.id)).toEqual([first.artifact.id]);
  });

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
      metadata: {
        evidence: 'raw extracted evidence should stay out of generated markdown',
        table: [['raw', 'table', 'debris']],
      },
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
    const { buffer } = await artifactStore.readContent(first.artifact.id);
    const markdown = buffer.toString('utf-8');
    expect(markdown).not.toContain('## Metadata JSON');
    expect(markdown).not.toContain('raw extracted evidence');
    expect(markdown).not.toContain('raw\",\"table\",\"debris');
  });

  test('lists targetless generated pages instead of hiding them', async () => {
    const { store, artifactStore } = createStores();
    const artifact = await artifactStore.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'knowledge-packet.md',
      text: '# Knowledge Packet',
      metadata: { generatedKnowledgePage: true },
    });
    const source = await store.upsertSource({
      connectorId: 'knowledge-projection',
      sourceType: 'document',
      title: 'Knowledge Packet',
      canonicalUri: 'knowledge://generated/packet/test',
      tags: ['generated-page'],
      status: 'indexed',
      artifactId: artifact.id,
      metadata: {
        generatedKnowledgePage: true,
        generatedProjection: true,
        projectionKind: 'packet',
      },
    });

    const pages = await listGeneratedKnowledgePages({
      artifactStore,
      spaceId: 'default',
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      limit: 20,
      includeMarkdown: true,
    });

    expect(pages.pages.map((page) => page.source.id)).toContain(source.id);
    expect(pages.pages.find((page) => page.source.id === source.id)?.target).toBeUndefined();
    expect(pages.pages.find((page) => page.source.id === source.id)?.markdown).toBe('# Knowledge Packet');
  });

  test('scopes generated page listings to the requested knowledge space', async () => {
    const { store, artifactStore } = createStores();
    const defaultPage = await store.upsertSource({
      connectorId: 'knowledge-projection',
      sourceType: 'document',
      title: 'Default Space Packet',
      canonicalUri: 'knowledge://generated/default-space',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: {
        generatedKnowledgePage: true,
        generatedProjection: true,
        projectionKind: 'packet',
      },
    });
    const otherPage = await store.upsertSource({
      connectorId: 'knowledge-projection',
      sourceType: 'document',
      title: 'Other Space Packet',
      canonicalUri: 'knowledge://generated/other-space',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: {
        knowledgeSpaceId: 'project:other',
        generatedKnowledgePage: true,
        generatedProjection: true,
        projectionKind: 'packet',
      },
    });

    const pages = await listGeneratedKnowledgePages({
      artifactStore,
      spaceId: 'default',
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      limit: 20,
      includeMarkdown: false,
    });

    expect(pages.pages.map((page) => page.source.id)).toContain(defaultPage.id);
    expect(pages.pages.map((page) => page.source.id)).not.toContain(otherPage.id);
  });

  test('hides generated pages whose recorded target is stale', async () => {
    const { store, artifactStore } = createStores();
    const staleTarget = await store.upsertNode({
      kind: 'topic',
      slug: 'retired-device',
      title: 'Retired Device',
      status: 'stale',
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'active-fact',
      title: 'Active fact',
      status: 'active',
      metadata: { semanticKind: 'fact', factKind: 'specification' },
    });
    const source = await store.upsertSource({
      connectorId: 'knowledge-projection',
      sourceType: 'document',
      title: 'Retired Device Page',
      canonicalUri: 'knowledge://generated/retired-device',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: {
        generatedKnowledgePage: true,
        generatedProjection: true,
        generatedTargetNodeId: staleTarget.id,
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: fact.id,
      relation: 'supports_fact',
    });

    const pages = await listGeneratedKnowledgePages({
      artifactStore,
      spaceId: 'default',
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      limit: 20,
      includeMarkdown: false,
    });

    expect(pages.pages.map((page) => page.source.id)).not.toContain(source.id);
  });

  test('ignores inactive generated page target edges', async () => {
    const { store, artifactStore } = createStores();
    const target = await store.upsertNode({
      kind: 'topic',
      slug: 'active-target',
      title: 'Active Target',
      status: 'active',
    });
    const source = await store.upsertSource({
      connectorId: 'knowledge-projection',
      sourceType: 'document',
      title: 'Unlinked Page',
      canonicalUri: 'knowledge://generated/unlinked-page',
      tags: ['generated-page'],
      status: 'indexed',
      metadata: {
        generatedKnowledgePage: true,
        generatedProjection: true,
        projectionKind: 'packet',
      },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: target.id,
      relation: 'source_for',
      metadata: { linkStatus: 'unlinked' },
    });

    const pages = await listGeneratedKnowledgePages({
      artifactStore,
      spaceId: 'default',
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      limit: 20,
      includeMarkdown: false,
    });
    const page = pages.pages.find((entry) => entry.source.id === source.id);

    expect(page).toBeDefined();
    expect(page?.target).toBeUndefined();
    expect(page?.subject).toBeUndefined();
  });

  test('renders generated page facts without raw evidence detail', async () => {
    const { store } = createStores();
    const device = await store.upsertNode({
      kind: 'ha_device',
      slug: 'living-room-tv',
      title: 'Living Room TV',
      status: 'active',
    });
    const fact = await store.upsertNode({
      kind: 'fact',
      slug: 'display-feature',
      title: 'Display features',
      status: 'active',
      sourceId: 'manual-source',
      metadata: {
        semanticKind: 'fact',
        factKind: 'specification',
        value: 'Dolby Vision',
        evidence: 'RAW PAGE TABLE SHOULD NOT RENDER',
        sourceId: 'manual-source',
        subjectIds: [device.id],
      },
    });
    const rawOnlyFact = await store.upsertNode({
      kind: 'fact',
      slug: 'raw-evidence-fragment',
      title: 'Raw evidence fragment',
      status: 'active',
      sourceId: 'manual-source',
      metadata: {
        semanticKind: 'fact',
        factKind: 'specification',
        evidence: 'Raw evidence fragment: RAW PAGE TABLE SHOULD NOT RENDER',
        sourceId: 'manual-source',
        subjectIds: [device.id],
      },
    });

    const markdown = renderDevicePassportPage({
      spaceId: 'default',
      device,
      entities: [],
      sources: [],
      issues: [],
      missingFields: [],
      semanticFacts: [fact, rawOnlyFact],
    });

    expect(markdown).toContain('- Display features: Dolby Vision');
    expect(markdown).not.toContain('Raw evidence fragment');
    expect(markdown).not.toContain('RAW PAGE TABLE SHOULD NOT RENDER');
  });

  test('canonical semantic fact ids are source-independent when a subject is known', () => {
    const first = semanticFactId({
      spaceId: 'homeassistant:house-1',
      kind: 'specification',
      title: 'Audio capabilities',
      value: '2 x 10W speakers',
      subjectIds: ['device-tv'],
      fallbackScope: 'source-a',
    });
    const second = semanticFactId({
      spaceId: 'homeassistant:house-1',
      kind: 'specification',
      title: 'Audio capabilities',
      value: '2 x 10W speakers',
      subjectIds: ['device-tv'],
      fallbackScope: 'source-b',
    });

    expect(second).toBe(first);
  });

  test('filters base knowledge maps with multi-select facets before layout', async () => {
    const { store } = createStores();
    const manual = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'manual',
      title: 'Operations Manual',
      canonicalUri: 'manual://operations',
      tags: ['ops', 'manual'],
      status: 'indexed',
    });
    const note = await store.upsertSource({
      connectorId: 'notes',
      sourceType: 'document',
      title: 'Deployment Notes',
      canonicalUri: 'notes://deployment',
      tags: ['deploy'],
      status: 'indexed',
    });
    const topic = await store.upsertNode({ kind: 'topic', slug: 'operations', title: 'Operations', sourceId: manual.id });
    const capability = await store.upsertNode({ kind: 'capability', slug: 'deploy', title: 'Deployment', sourceId: note.id });
    await store.upsertEdge({ fromKind: 'source', fromId: manual.id, toKind: 'node', toId: topic.id, relation: 'documents' });
    await store.upsertEdge({ fromKind: 'source', fromId: note.id, toKind: 'node', toId: capability.id, relation: 'documents' });

    const map = renderKnowledgeMap({
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      issues: store.listIssues(20),
    }, {
      includeSources: true,
      nodeKinds: ['topic', 'capability'],
      sourceTypes: ['manual'],
    });

    expect(map.nodes.map((entry) => entry.id)).toContain(manual.id);
    expect(map.nodes.map((entry) => entry.id)).not.toContain(note.id);
    expect(map.nodes.map((entry) => entry.id)).toContain(topic.id);
    expect(map.nodes.map((entry) => entry.id)).toContain(capability.id);
    expect(map.facets?.sourceTypes.some((entry) => entry.value === 'manual' && entry.count === 1)).toBe(true);
    expect(map.facets?.nodeKinds.some((entry) => entry.value === 'capability')).toBe(true);
  });

  test('keeps extension spaces out of regular knowledge maps, projections, and packets by default', async () => {
    const { store, artifactStore } = createStores();
    const baseSource = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'document',
      title: 'Base Knowledge Manual',
      canonicalUri: 'manual://base-widget',
      summary: 'Base widget setup and operation notes.',
      tags: ['base'],
      status: 'indexed',
    });
    const baseNode = await store.upsertNode({
      kind: 'topic',
      slug: 'base-widget',
      title: 'Base Widget',
      summary: 'Base widget knowledge.',
      metadata: knowledgeSpaceMetadata('default'),
    });
    const haSource = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'Home Assistant LG Passport',
      canonicalUri: 'homeassistant://device/lg-tv',
      summary: 'LG webOS Smart TV Home Graph passport.',
      tags: ['homeassistant'],
      status: 'indexed',
      metadata: { knowledgeSpaceId: 'homeassistant:test', namespace: 'homeassistant:test' },
    });
    const haNode = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-webos-smart-tv',
      title: 'LG webOS Smart TV',
      summary: 'LG 86NANO90UNA Home Graph device.',
      metadata: { knowledgeSpaceId: 'homeassistant:test', namespace: 'homeassistant:test' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: baseSource.id,
      toKind: 'node',
      toId: baseNode.id,
      relation: 'documents',
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: haSource.id,
      toKind: 'node',
      toId: haNode.id,
      relation: 'documents',
    });

    const projectionService = new KnowledgeProjectionService(store, artifactStore);
    const defaultTargets = await projectionService.listTargets(20);
    const defaultBundle = await projectionService.render({ kind: 'bundle', limit: 10 });
    const allBundle = await projectionService.render({ kind: 'bundle', limit: 10, includeAllSpaces: true });
    const haBundle = await projectionService.render({ kind: 'bundle', limit: 10, knowledgeSpaceId: 'homeassistant:test' });
    const defaultMap = renderKnowledgeMap({
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      issues: store.listIssues(20),
    }, { includeSources: true });
    const allMap = renderKnowledgeMap({
      sources: store.listSources(20),
      nodes: store.listNodes(20),
      edges: store.listEdges(),
      issues: store.listIssues(20),
    }, { includeSources: true, includeAllSpaces: true });
    const defaultPacket = buildKnowledgePacketSync(packetContext(store), 'LG webOS Smart TV', [], 10);
    const allPacket = buildKnowledgePacketSync(packetContext(store), 'LG webOS Smart TV', [], 10, { includeAllSpaces: true });

    expect(defaultTargets.map((target) => target.title)).toContain('Base Knowledge Manual');
    expect(defaultTargets.map((target) => target.title)).not.toContain('Home Assistant LG Passport');
    expect(defaultBundle.pages.map((page) => page.content).join('\n')).toContain('Base Knowledge Manual');
    expect(defaultBundle.pages.map((page) => page.content).join('\n')).not.toContain('Home Assistant LG Passport');
    expect(defaultBundle.pages.map((page) => page.content).join('\n')).not.toContain('LG webOS Smart TV');
    expect(allBundle.pages.map((page) => page.content).join('\n')).toContain('Home Assistant LG Passport');
    expect(haBundle.pages.map((page) => page.content).join('\n')).toContain('LG webOS Smart TV');
    expect(haBundle.pages.map((page) => page.content).join('\n')).not.toContain('Base Knowledge Manual');
    expect(defaultMap.nodes.map((entry) => entry.id)).toContain(baseNode.id);
    expect(defaultMap.nodes.map((entry) => entry.id)).not.toContain(haNode.id);
    expect(defaultMap.nodes.map((entry) => entry.id)).not.toContain(haSource.id);
    expect(defaultMap.facets?.nodeKinds.some((entry) => entry.value === 'ha_device')).toBe(false);
    expect(allMap.nodes.map((entry) => entry.id)).toContain(haNode.id);
    expect(allMap.facets?.nodeKinds.some((entry) => entry.value === 'ha_device')).toBe(true);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(haNode.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(haSource.id);
    expect(allPacket?.items.map((item) => item.id)).toContain(haNode.id);
  });

  test('default knowledge views reject unscoped source-derived extension records', async () => {
    const { store, artifactStore } = createStores();
    const baseSource = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'document',
      title: 'Base Knowledge Manual',
      canonicalUri: 'manual://base-widget',
      tags: ['base'],
      status: 'indexed',
    });
    const baseNode = await store.upsertNode({
      kind: 'topic',
      slug: 'default-base-widget',
      title: 'Base Widget',
      sourceId: baseSource.id,
    });
    const haSource = await store.upsertSource({
      connectorId: 'homeassistant',
      sourceType: 'document',
      title: 'Sony BRAVIA repair source',
      canonicalUri: 'https://www.displayspecifications.com/en/model/example',
      tags: ['homeassistant'],
      status: 'indexed',
      metadata: knowledgeSpaceMetadata('homeassistant:test'),
    });
    const leakedNode = await store.upsertNode({
      kind: 'topic',
      slug: 'sony-bravia-xbr-55x850b',
      title: 'BRAVIA XBR-55X850B',
      sourceId: haSource.id,
      metadata: knowledgeSpaceMetadata('homeassistant:test', {
        sourceId: haSource.id,
      }),
    });
    await store.replaceNodeRecord({
      ...leakedNode,
      metadata: {
        sourceId: haSource.id,
        tag: 'BRAVIA XBR-55X850B',
      },
    });
    const haDevice = await store.upsertNode({
      kind: 'ha_device',
      slug: 'lg-86nano90una',
      title: 'LG webOS Smart TV',
      metadata: knowledgeSpaceMetadata('homeassistant:test', {
        manufacturer: 'LG',
        model: '86NANO90UNA',
      }),
    });
    const leakedIssue = await store.upsertIssue({
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: 'No knowledge answer available for: What features does the TV have?',
      sourceId: haSource.id,
      nodeId: leakedNode.id,
      metadata: knowledgeSpaceMetadata('homeassistant:test', {
        query: 'What features does the TV have?',
      }),
    });
    await store.replaceIssueRecord({
      ...leakedIssue,
      metadata: {
        query: 'What features does the TV have?',
      },
    });
    const explicitDefaultGap = await store.upsertNode({
      kind: 'knowledge_gap',
      slug: 'default-scoped-ha-answer-gap',
      title: 'What smart TV features does it have?',
      summary: 'The answer gap was incorrectly written as default while linked to an HA object.',
      metadata: knowledgeSpaceMetadata('default', {
        linkedObjectIds: [haDevice.id],
        subject: 'LG 86NANO90UNA Smart TV Specifications',
      }),
    });
    const explicitDefaultIssue = await store.upsertIssue({
      id: 'sem-answer-gap-issue-default-linked-ha',
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: 'No knowledge answer available for: What smart TV features does it have?',
      nodeId: explicitDefaultGap.id,
      metadata: knowledgeSpaceMetadata('default', {
        linkedObjectIds: [haDevice.id],
        subject: 'LG 86NANO90UNA Smart TV Specifications',
      }),
    });
    await store.replaceNodeRecord({
      ...explicitDefaultGap,
      metadata: knowledgeSpaceMetadata('default', {
        linkedObjectIds: [haDevice.id],
        subject: 'LG 86NANO90UNA Smart TV Specifications',
      }),
    });
    await store.replaceIssueRecord({
      ...explicitDefaultIssue,
      metadata: knowledgeSpaceMetadata('default', {
        linkedObjectIds: [haDevice.id],
        subject: 'LG 86NANO90UNA Smart TV Specifications',
      }),
    });
    const edgeOnlyTopic = await store.upsertNode({
      kind: 'topic',
      slug: 'edge-only-bravia-topic',
      title: 'BRAVIA XBR-55X850B',
      summary: 'Topic tag BRAVIA XBR-55X850B.',
      metadata: { tag: 'BRAVIA XBR-55X850B' },
    });
    const edgeOnlyDomain = await store.upsertNode({
      kind: 'domain',
      slug: 'edge-only-displayspecifications-domain',
      title: 'www.displayspecifications.com',
      summary: 'Knowledge sources cataloged under www.displayspecifications.com.',
      metadata: { hostname: 'www.displayspecifications.com' },
    });
    const orphanCatalogTopic = await store.upsertNode({
      kind: 'topic',
      slug: 'orphan-displayspecifications-topic',
      title: 'DisplaySpecifications',
      summary: 'Topic tag DisplaySpecifications.',
      metadata: { tag: 'DisplaySpecifications' },
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: haSource.id,
      toKind: 'node',
      toId: leakedNode.id,
      relation: 'documents',
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: haSource.id,
      toKind: 'node',
      toId: edgeOnlyTopic.id,
      relation: 'tagged_with',
    });
    await store.upsertEdge({
      fromKind: 'source',
      fromId: haSource.id,
      toKind: 'node',
      toId: edgeOnlyDomain.id,
      relation: 'belongs_to_domain',
    });
    const orphanAnswerGap = await store.upsertNode({
      id: 'sem-answer-gap-orphan-home-assistant',
      kind: 'knowledge_gap',
      slug: 'orphan-home-assistant-answer-gap',
      title: 'BRAVIA XBR-55X850B Home Assistant',
      summary: 'No indexed evidence matched the question.',
      metadata: knowledgeSpaceMetadata('default', {
        semanticKind: 'gap',
        gapKind: 'answer',
        query: 'BRAVIA XBR-55X850B Home Assistant',
        sourceIds: [],
        linkedObjectIds: [],
        visibility: 'refinement',
        displayRole: 'knowledge-gap',
        semantic: true,
      }),
    });
    const orphanAnswerIssue = await store.upsertIssue({
      id: 'sem-answer-gap-issue-orphan-home-assistant',
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: 'No knowledge answer available for: BRAVIA XBR-55X850B Home Assistant',
      nodeId: orphanAnswerGap.id,
      metadata: knowledgeSpaceMetadata('default', {
        query: 'BRAVIA XBR-55X850B Home Assistant',
        sourceIds: [],
        linkedObjectIds: [],
        semantic: true,
      }),
    });

    const service = new KnowledgeService(store, artifactStore, undefined, {
      memoryRegistry: {
        add: async () => {},
        getAll: () => [],
        getStore: () => null,
      },
    });
    const projectionService = new KnowledgeProjectionService(store, artifactStore);

    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).toContain(baseNode.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(leakedNode.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(explicitDefaultGap.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(edgeOnlyTopic.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(edgeOnlyDomain.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(orphanCatalogTopic.id);
    expect(service.queryNodes({ limit: 100 }).items.map((node) => node.id)).not.toContain(orphanAnswerGap.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(leakedNode.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(explicitDefaultGap.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(edgeOnlyTopic.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(edgeOnlyDomain.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(orphanCatalogTopic.id);
    expect(service.queryNodes({ limit: 100, includeAllSpaces: true }).items.map((node) => node.id)).toContain(orphanAnswerGap.id);
    expect(service.queryNodes({ limit: 100, knowledgeSpaceId: 'homeassistant:test' }).items.map((node) => node.id)).toContain(edgeOnlyTopic.id);
    expect(service.queryNodes({ limit: 100, knowledgeSpaceId: 'homeassistant:test' }).items.map((node) => node.id)).toContain(edgeOnlyDomain.id);
    expect(service.queryIssues({ limit: 100 }).items.map((issue) => issue.id)).not.toContain(leakedIssue.id);
    expect(service.queryIssues({ limit: 100 }).items.map((issue) => issue.id)).not.toContain(explicitDefaultIssue.id);
    expect(service.queryIssues({ limit: 100 }).items.map((issue) => issue.id)).not.toContain(orphanAnswerIssue.id);
    expect(service.queryIssues({ limit: 100, includeAllSpaces: true }).items.map((issue) => issue.id)).toContain(leakedIssue.id);
    expect(service.queryIssues({ limit: 100, includeAllSpaces: true }).items.map((issue) => issue.id)).toContain(explicitDefaultIssue.id);
    expect(service.queryIssues({ limit: 100, includeAllSpaces: true }).items.map((issue) => issue.id)).toContain(orphanAnswerIssue.id);

    const defaultTargets = await projectionService.listTargets(100);
    const defaultPacket = buildKnowledgePacketSync(packetContext(store), 'BRAVIA Home Assistant', [], 10);
    const defaultMap = renderKnowledgeMap({
      sources: store.listSources(100),
      nodes: store.listNodes(100),
      edges: store.listEdges(),
      issues: store.listIssues(100),
    }, { includeSources: true });

    expect(defaultTargets.map((target) => target.id)).not.toContain(leakedNode.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(edgeOnlyTopic.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(edgeOnlyDomain.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(orphanCatalogTopic.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(orphanAnswerGap.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(leakedIssue.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(explicitDefaultIssue.id);
    expect(defaultTargets.map((target) => target.id)).not.toContain(orphanAnswerIssue.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(leakedNode.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(leakedIssue.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(explicitDefaultGap.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(edgeOnlyTopic.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(edgeOnlyDomain.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(orphanCatalogTopic.id);
    expect(defaultPacket?.items.map((item) => item.id)).not.toContain(orphanAnswerGap.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(leakedNode.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(leakedIssue.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(explicitDefaultIssue.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(edgeOnlyTopic.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(edgeOnlyDomain.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(orphanCatalogTopic.id);
    expect(defaultMap.nodes.map((node) => node.id)).not.toContain(orphanAnswerGap.id);

    const defaultAnswer = await service.ask({
      query: 'What features does the BRAVIA XBR-55X850B have?',
      includeSources: true,
      includeLinkedObjects: true,
      includeConfidence: true,
    });
    expect(defaultAnswer.results.map((result) => result.id)).not.toContain(leakedNode.id);
    expect(defaultAnswer.answer.sources.map((source) => source.id)).not.toContain(haSource.id);
    expect(defaultAnswer.answer.linkedObjects.map((node) => node.id)).not.toContain(leakedNode.id);
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

function packetContext(store: KnowledgeStore): Parameters<typeof buildKnowledgePacketSync>[0] {
  return {
    store,
    deferUsage: () => {},
    emitIfReady: () => {},
  };
}
