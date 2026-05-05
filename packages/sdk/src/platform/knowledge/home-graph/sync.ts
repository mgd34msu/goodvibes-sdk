import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { yieldEvery } from '../cooperative.js';
import { autoLinkHomeGraphSources } from './auto-link.js';
import { upsertIntegrationDocumentationCandidates } from './documentation.js';
import { generateAutomaticHomeGraphPages } from './generated-pages.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  buildHomeGraphNodeInput,
  edgeIsActive,
  homeGraphNodeId,
  homeGraphSourceId,
  isGeneratedPageSource,
  namespacedCanonicalUri,
  normalizeHomeGraphObjectInput,
  readRecord,
  resolveHomeGraphSpace,
} from './helpers.js';
import { linkHomeGraphSnapshotObjectReferences } from './link-node.js';
import { refreshHomeGraphQualityIssues } from './quality.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphObjectInput, HomeGraphSnapshotInput, HomeGraphSyncResult } from './types.js';

const SNAPSHOT_NODE_KINDS = new Set<string>([
  'ha_home',
  'ha_entity',
  'ha_device',
  'ha_area',
  'ha_automation',
  'ha_script',
  'ha_scene',
  'ha_label',
  'ha_integration',
]);

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
    const activeSnapshotNodeIds = new Set([home.id]);
    const groups = await upsertSnapshotObjects(store, spaceId, installationId, snapshot, home.id, source.id, activeSnapshotNodeIds);
    await retireMissingSnapshotRecords(store, spaceId, installationId, source.id, activeSnapshotNodeIds, snapshotRetirementObjectKinds(snapshot));
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
    status: 'active',
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
  activeNodeIds: Set<string>,
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
      const node = await store.upsertNode({ ...nodeInput, sourceId, status: 'active', confidence: 90 });
      activeNodeIds.add(node.id);
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

async function retireMissingSnapshotRecords(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  currentSnapshotSourceId: string,
  activeNodeIds: ReadonlySet<string>,
  retirableObjectKinds: ReadonlySet<string>,
): Promise<void> {
  const staleAt = Date.now();
  const retiredNodeIds = new Set<string>();
  for (const node of store.listNodesInSpace(spaceId)) {
    if (!isSnapshotOwnedNode(node, installationId, retirableObjectKinds)) continue;
    if (activeNodeIds.has(node.id)) continue;
    if (node.status === 'stale') continue;
    retiredNodeIds.add(node.id);
    await markNodeStale(store, spaceId, installationId, node, 'missing-from-latest-home-assistant-snapshot', staleAt);
  }

  for (const source of store.listSourcesInSpace(spaceId)) {
    if (!isPreviousSnapshotSource(source, currentSnapshotSourceId, installationId)) continue;
    if (source.status === 'stale') continue;
    await markSourceStale(store, spaceId, installationId, source, 'superseded-by-newer-home-assistant-snapshot', staleAt);
  }

  if (retiredNodeIds.size > 0) {
    await retireGeneratedRecordsForStaleSnapshotNodes(store, spaceId, installationId, retiredNodeIds, staleAt);
  }
}

async function retireGeneratedRecordsForStaleSnapshotNodes(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  retiredNodeIds: ReadonlySet<string>,
  staleAt: number,
): Promise<void> {
  const nodes = store.listNodesInSpace(spaceId);
  const edges = store.listEdges();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const generatedTargetIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'node'
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
      && retiredNodeIds.has(edge.toId)) {
      generatedTargetIds.add(edge.fromId);
    }
  }

  for (const nodeId of generatedTargetIds) {
    const node = nodesById.get(nodeId);
    if (!node || node.status === 'stale') continue;
    await markNodeStale(store, spaceId, installationId, node, 'target-missing-from-latest-home-assistant-snapshot', staleAt);
  }

  const staleTargetIds = new Set([...retiredNodeIds, ...generatedTargetIds]);
  for (const source of store.listSourcesInSpace(spaceId)) {
    if (source.status === 'stale') continue;
    if (!isGeneratedPageSource(source)) continue;
    const targetsStaleNode = edges.some((edge) => (
      edgeIsActive(edge)
      && edge.fromKind === 'source'
      && edge.fromId === source.id
      && edge.toKind === 'node'
      && staleTargetIds.has(edge.toId)
    ));
    if (!targetsStaleNode) continue;
    await markSourceStale(store, spaceId, installationId, source, 'target-missing-from-latest-home-assistant-snapshot', staleAt);
  }
}

async function markNodeStale(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  node: KnowledgeNodeRecord,
  staleReason: string,
  staleAt: number,
): Promise<void> {
  await store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: node.title,
    summary: node.summary,
    aliases: node.aliases,
    status: 'stale',
    confidence: node.confidence,
    sourceId: node.sourceId,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      ...node.metadata,
      staleReason,
      staleAt,
    }),
  });
}

async function markSourceStale(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  source: KnowledgeSourceRecord,
  staleReason: string,
  staleAt: number,
): Promise<void> {
  await store.upsertSource({
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    title: source.title,
    sourceUri: source.sourceUri,
    canonicalUri: source.canonicalUri,
    summary: source.summary,
    description: source.description,
    tags: source.tags,
    folderPath: source.folderPath,
    status: 'stale',
    artifactId: source.artifactId,
    contentHash: source.contentHash,
    lastCrawledAt: source.lastCrawledAt,
    crawlError: source.crawlError,
    sessionId: source.sessionId,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      ...source.metadata,
      staleReason,
      staleAt,
    }),
  });
}

function snapshotRetirementObjectKinds(input: HomeGraphSnapshotInput): ReadonlySet<string> {
  const kinds = new Set<string>();
  if (input.entities) kinds.add('entity');
  if (input.devices) kinds.add('device');
  if (input.areas) kinds.add('area');
  if (input.automations) kinds.add('automation');
  if (input.scripts) kinds.add('script');
  if (input.scenes) kinds.add('scene');
  if (input.labels) kinds.add('label');
  if (input.integrations) kinds.add('integration');
  return kinds;
}

function isSnapshotOwnedNode(
  node: KnowledgeNodeRecord,
  installationId: string,
  retirableObjectKinds: ReadonlySet<string>,
): boolean {
  if (!SNAPSHOT_NODE_KINDS.has(node.kind)) return false;
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const objectKind = typeof homeAssistant.objectKind === 'string' ? homeAssistant.objectKind : undefined;
  return homeAssistant.installationId === installationId
    && Boolean(objectKind && retirableObjectKinds.has(objectKind));
}

function isPreviousSnapshotSource(
  source: KnowledgeSourceRecord,
  currentSnapshotSourceId: string,
  installationId: string,
): boolean {
  if (source.id === currentSnapshotSourceId) return false;
  const homeAssistant = readRecord(source.metadata.homeAssistant);
  return homeAssistant.installationId === installationId
    && source.connectorId === HOME_GRAPH_CONNECTOR_ID
    && source.metadata.homeGraphSourceKind === 'snapshot';
}
