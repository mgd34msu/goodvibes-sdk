import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ArtifactStore } from '../packages/sdk/src/platform/artifacts/index.js';
import { compileKnowledgeSource } from '../packages/sdk/src/platform/knowledge/ingest.js';
import type { KnowledgeIngestContext } from '../packages/sdk/src/platform/knowledge/ingest-context.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge ingest compilation', () => {
  test('compiles source, section, folder, session, artifact, and outbound link edges in one source pass', async () => {
    const { store, context } = createContext();
    const linked = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'url',
      title: 'Linked Reference',
      canonicalUri: 'https://docs.example.com/linked',
      tags: [],
      status: 'indexed',
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'url',
      title: 'Device Manual',
      canonicalUri: 'https://docs.example.com/source',
      tags: ['devices'],
      folderPath: 'wiki/devices',
      status: 'indexed',
      artifactId: 'artifact-manual',
      sessionId: 'session-1',
    });
    const extraction = await store.upsertExtraction({
      sourceId: source.id,
      artifactId: source.artifactId,
      extractorId: 'html',
      format: 'html',
      summary: 'Device manual.',
      sections: ['Features', 'devices'],
      links: ['https://docs.example.com/linked'],
      structure: { searchText: 'Features include local control and HDMI eARC.' },
    });

    await compileKnowledgeSource(context, source, extraction);
    const edges = store.listEdges();

    expect(edges.some((edge) => edge.fromId === source.id && edge.toId === 'artifact-manual' && edge.relation === 'snapshotted_as')).toBe(true);
    expect(edges.some((edge) => edge.fromId === source.id && edge.relation === 'belongs_to_domain')).toBe(true);
    expect(edges.some((edge) => edge.fromId === source.id && edge.relation === 'tagged_with')).toBe(true);
    expect(edges.some((edge) => edge.fromId === source.id && edge.relation === 'cataloged_in_folder')).toBe(true);
    expect(edges.some((edge) => edge.fromId === source.id && edge.toId === linked.id && edge.relation === 'links_to_source')).toBe(true);
    expect(edges.some((edge) => edge.fromId === source.id && edge.toId === 'session-1' && edge.relation === 'ingested_during')).toBe(true);
    const topicNodes = store.listNodes(50).filter((node) => node.kind === 'topic' && (node.title === 'Features' || node.title === 'devices'));
    expect(topicNodes.map((node) => node.title)).toContain('Features');
    expect(topicNodes.filter((node) => node.title === 'devices')).toHaveLength(1);
  });

  test('skips missing artifact ids and malformed canonical urls without creating placeholder edges', async () => {
    const { store, context } = createContext();
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'url',
      title: 'Malformed Source',
      sourceUri: 'not a valid url',
      canonicalUri: 'not a valid url',
      tags: [],
      status: 'indexed',
    });
    const extraction = await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'text',
      format: 'text',
      sections: [],
      links: [],
      structure: {},
    });

    await compileKnowledgeSource(context, source, extraction);

    expect(store.listEdges().some((edge) => edge.relation === 'snapshotted_as')).toBe(false);
    expect(store.listEdges().some((edge) => edge.relation === 'belongs_to_domain')).toBe(false);
  });

  test('dedupes empty sections and outbound links during compilation', async () => {
    const { store, context } = createContext();
    const linked = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'url',
      title: 'Linked Reference',
      canonicalUri: 'https://docs.example.com/linked',
      tags: [],
      status: 'indexed',
    });
    const source = await store.upsertSource({
      connectorId: 'manual',
      sourceType: 'url',
      title: 'Device Manual',
      canonicalUri: 'https://docs.example.com/source',
      tags: [],
      status: 'indexed',
    });
    const extraction = await store.upsertExtraction({
      sourceId: source.id,
      extractorId: 'html',
      format: 'html',
      sections: ['', '  ', 'Features', 'Features', 'features'],
      links: [
        'https://docs.example.com/linked?utm_source=noise',
        'https://docs.example.com/linked',
        'not a url',
      ],
      structure: { searchText: { malformed: true } },
    });

    await compileKnowledgeSource(context, source, extraction);

    const edges = store.listEdges();
    const sectionNodes = store.listNodes(50).filter((node) => node.kind === 'topic' && node.title === 'Features');
    const outboundLinks = edges.filter((edge) => edge.fromId === source.id && edge.toId === linked.id && edge.relation === 'links_to_source');
    expect(sectionNodes).toHaveLength(1);
    expect(outboundLinks).toHaveLength(1);
    expect(store.listNodes(50).some((node) => node.kind === 'topic' && node.slug === 'item')).toBe(false);
  });
});

function createContext(): {
  readonly store: KnowledgeStore;
  readonly context: KnowledgeIngestContext;
} {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-compile-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  return {
    store,
    context: {
      store,
      artifactStore,
      connectorRegistry: {} as never,
      emitIfReady: () => {},
      syncReviewedMemory: async () => {},
      lint: async () => [],
      listConnectors: () => [],
    },
  };
}
