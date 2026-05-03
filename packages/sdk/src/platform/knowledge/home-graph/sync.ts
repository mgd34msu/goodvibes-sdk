import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { yieldEvery } from '../cooperative.js';
import { autoLinkHomeGraphSources } from './auto-link.js';
import { upsertIntegrationDocumentationCandidates } from './documentation.js';
import { generateAutomaticHomeGraphPages } from './generated-pages.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  buildHomeGraphNodeInput,
  homeGraphNodeId,
  homeGraphSourceId,
  namespacedCanonicalUri,
  normalizeHomeGraphObjectInput,
  resolveHomeGraphSpace,
} from './helpers.js';
import { linkHomeGraphSnapshotObjectReferences } from './link-node.js';
import { refreshHomeGraphQualityIssues } from './quality.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphObjectInput, HomeGraphSnapshotInput, HomeGraphSyncResult } from './types.js';

export async function runHomeGraphSnapshotSync(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly snapshot: HomeGraphSnapshotInput;
}): Promise<HomeGraphSyncResult> {
  const { store, artifactStore, snapshot } = input;
  return await store.batch(async () => {
    const { spaceId, installationId } = resolveHomeGraphSpace(snapshot);
    const capturedAt = snapshot.capturedAt ?? Date.now();
    const source = await store.upsertSource({
      id: homeGraphSourceId(spaceId, 'snapshot', String(capturedAt)),
      connectorId: HOME_GRAPH_CONNECTOR_ID,
      sourceType: 'dataset',
      title: snapshot.title ?? 'Home Assistant snapshot',
      canonicalUri: namespacedCanonicalUri(spaceId, 'snapshot', String(capturedAt)),
      summary: 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.',
      tags: ['homeassistant', 'home-graph', 'snapshot'],
      status: 'indexed',
      lastCrawledAt: capturedAt,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        ...(snapshot.metadata ?? {}),
        homeGraphSourceKind: 'snapshot',
        capturedAt,
      }),
    });
    const home = await upsertHomeNode(store, spaceId, installationId, snapshot);
    const beforeState = readHomeGraphState(store, spaceId);
    const beforeNodeIds = new Set(beforeState.nodes.map((node) => node.id));
    const beforeEdgeIds = new Set(beforeState.edges.map((edge) => edge.id));
    const groups = await upsertSnapshotObjects(store, spaceId, installationId, snapshot, home.id, source.id);
    await autoLinkExistingSources(store, spaceId, installationId);
    const issues = await refreshHomeGraphQualityIssues(store, spaceId, installationId);
    const generated = await generateAutomaticHomeGraphPages({
      store,
      artifactStore,
      spaceId,
      installationId,
      input: snapshot,
    });
    const after = readHomeGraphState(store, spaceId);
    return {
      ok: true,
      spaceId,
      installationId,
      source,
      home,
      created: {
        nodes: after.nodes.filter((node) => !beforeNodeIds.has(node.id)).length,
        edges: after.edges.filter((edge) => !beforeEdgeIds.has(edge.id)).length,
        issues: issues.length,
      },
      generated,
      counts: groups,
    };
  });
}

async function autoLinkExistingSources(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
): Promise<void> {
  const state = readHomeGraphState(store, spaceId);
  const extractionBySourceId = new Map(state.extractions.map((extraction) => [extraction.sourceId, extraction]));
  await autoLinkHomeGraphSources({
    store,
    spaceId,
    installationId,
    sources: state.sources,
    extractionBySourceId,
    state,
  });
}

async function upsertHomeNode(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  input: HomeGraphSnapshotInput,
): Promise<KnowledgeNodeRecord> {
  return store.upsertNode({
    id: homeGraphNodeId(spaceId, 'ha_home', input.homeId ?? installationId),
    kind: 'ha_home',
    slug: `${spaceId.replace(/[^a-z0-9]+/gi, '-')}-home`,
    title: input.title ?? 'Home Assistant',
    summary: 'Home Assistant installation captured in the GoodVibes Home Graph.',
    aliases: [installationId],
    confidence: 100,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeAssistant: { installationId, objectKind: 'home', objectId: input.homeId ?? installationId },
    }),
  });
}

async function upsertSnapshotObjects(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  input: HomeGraphSnapshotInput,
  homeNodeId: string,
  sourceId: string,
): Promise<HomeGraphSyncResult['counts']> {
  const counts = {
    entities: 0,
    devices: 0,
    areas: 0,
    automations: 0,
    scripts: 0,
    scenes: 0,
    labels: 0,
    integrations: 0,
  };
  const upsertGroup = async (kind: Parameters<typeof buildHomeGraphNodeInput>[2], objects: readonly HomeGraphObjectInput[] | undefined) => {
    let count = 0;
    for (const [index, rawObject] of (objects ?? []).entries()) {
      await yieldEvery(index, 16);
      const object = normalizeHomeGraphObjectInput(kind, rawObject);
      const nodeInput = buildHomeGraphNodeInput(spaceId, installationId, kind, object);
      const node = await store.upsertNode({ ...nodeInput, sourceId, confidence: 90 });
      await store.upsertEdge({
        fromKind: 'node',
        fromId: node.id,
        toKind: 'node',
        toId: homeNodeId,
        relation: 'source_for',
        metadata: buildHomeGraphMetadata(spaceId, installationId),
      });
      await linkHomeGraphSnapshotObjectReferences(store, { spaceId, installationId, node, object });
      if (node.kind === 'ha_integration') {
        await upsertIntegrationDocumentationCandidates(store, spaceId, installationId, node, object);
      }
      count += 1;
      await yieldEvery(count, 16);
    }
    return count;
  };
  counts.areas = await upsertGroup('area', input.areas);
  counts.integrations = await upsertGroup('integration', input.integrations);
  counts.devices = await upsertGroup('device', input.devices);
  counts.entities = await upsertGroup('entity', input.entities);
  counts.automations = await upsertGroup('automation', input.automations);
  counts.scripts = await upsertGroup('script', input.scripts);
  counts.scenes = await upsertGroup('scene', input.scenes);
  counts.labels = await upsertGroup('label', input.labels);
  return counts;
}
