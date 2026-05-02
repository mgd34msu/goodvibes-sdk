import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import {
  materializeGeneratedKnowledgeProjection,
} from '../generated-projections.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  edgeIsActive,
  homeGraphNodeId,
  homeGraphSourceId,
  isGeneratedPageSource,
  namespacedCanonicalUri,
  readRecord,
  uniqueStrings,
} from './helpers.js';
import {
  findHomeAssistantNode,
  missingDevicePassportFields,
  readHomeGraphState,
  renderHomeGraphState,
  safeHomeGraphFilename,
  sourcesLinkedToNode,
} from './state.js';
import {
  issuesForScope,
  renderDevicePassportPage,
  renderPacketPage,
  renderRoomPage,
} from './rendering.js';
import {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  isUsefulHomeGraphSourceBackedNote,
  isUsefulHomeGraphPageFact,
} from '../semantic/fact-quality.js';
import { normalizeWhitespace, sourceSemanticText } from '../semantic/utils.js';
import type {
  HomeGraphDevicePassportResult,
  HomeGraphGeneratedPagesSummary,
  HomeGraphProjectionInput,
  HomeGraphProjectionResult,
  HomeGraphSnapshotInput,
} from './types.js';

export interface HomeGraphPageContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
}

export const HOME_GRAPH_PAGE_POLICY_VERSION = 'homegraph-pages-v7';
const DEFAULT_SYNC_DEVICE_PASSPORT_LIMIT = 32;
const DEFAULT_SYNC_ROOM_PAGE_LIMIT = 12;
const DEFAULT_SYNC_PAGE_RUN_MS = 15_000;
const MAX_FOREGROUND_SYNC_DEVICE_PASSPORTS = 32;
const MAX_FOREGROUND_SYNC_ROOM_PAGES = 12;
const MAX_FOREGROUND_SYNC_PAGE_RUN_MS = 30_000;

export async function generateAutomaticHomeGraphPages(
  context: HomeGraphPageContext & { readonly input: HomeGraphSnapshotInput },
): Promise<HomeGraphGeneratedPagesSummary> {
  const requested = context.input.pageAutomation ?? {};
  return generateHomeGraphPagesForCurrentState(context, {
    ...requested,
    maxDevicePassports: clampForegroundLimit(
      requested.maxDevicePassports,
      DEFAULT_SYNC_DEVICE_PASSPORT_LIMIT,
      MAX_FOREGROUND_SYNC_DEVICE_PASSPORTS,
    ),
    maxRoomPages: clampForegroundLimit(
      requested.maxRoomPages,
      DEFAULT_SYNC_ROOM_PAGE_LIMIT,
      MAX_FOREGROUND_SYNC_ROOM_PAGES,
    ),
    maxRunMs: clampForegroundLimit(
      requested.maxRunMs,
      DEFAULT_SYNC_PAGE_RUN_MS,
      MAX_FOREGROUND_SYNC_PAGE_RUN_MS,
    ),
  });
}

export async function refreshAutomaticHomeGraphPages(
  context: HomeGraphPageContext,
): Promise<HomeGraphGeneratedPagesSummary> {
  return generateHomeGraphPagesForCurrentState(context, {});
}

async function generateHomeGraphPagesForCurrentState(
  context: HomeGraphPageContext,
  options: HomeGraphSnapshotInput['pageAutomation'],
): Promise<HomeGraphGeneratedPagesSummary> {
  const effectiveOptions = options ?? {};
  const summary = createGeneratedPagesSummary();
  if (effectiveOptions.enabled === false) return summary;
  const deadlineAt = typeof effectiveOptions.maxRunMs === 'number' && Number.isFinite(effectiveOptions.maxRunMs)
    ? Date.now() + Math.max(1_000, Math.trunc(effectiveOptions.maxRunMs))
    : undefined;

  const state = readHomeGraphState(context.store, context.spaceId);
  if (effectiveOptions.devicePassports !== false) {
    const allDevices = prioritizeNodesForGeneratedPages(
      state.nodes.filter((node) => node.kind === 'ha_device' && node.status !== 'stale'),
    );
    const devices = limitRecords(allDevices, effectiveOptions.maxDevicePassports);
    summary.deferredDevicePassports += Math.max(0, allDevices.length - devices.length);
    for (const [index, device] of devices.entries()) {
      if (deadlineReached(deadlineAt)) {
        summary.deferredDevicePassports += devices.length - index;
        break;
      }
      await yieldEvery(index, 2);
      const deviceId = readHomeAssistantObjectId(device, 'objectId', 'deviceId') ?? device.id;
      try {
        const page = await refreshHomeGraphDevicePassport({
          ...context,
          input: {
            knowledgeSpaceId: context.spaceId,
            deviceId,
            metadata: { automation: 'snapshot-sync' },
          },
        });
        summary.devicePassports += 1;
        if (page.artifactCreated) summary.artifacts += 1;
        if (page.source) summary.sources += 1;
      } catch (error) {
        summary.errors.push({
          kind: 'device-passport',
          targetId: deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await yieldToEventLoop();
    }
  }

  if (effectiveOptions.roomPages !== false) {
    const allRooms = prioritizeNodesForGeneratedPages(
      state.nodes.filter((node) => (node.kind === 'ha_area' || node.kind === 'ha_room') && node.status !== 'stale'),
    );
    const rooms = limitRecords(allRooms, effectiveOptions.maxRoomPages);
    summary.deferredRoomPages += Math.max(0, allRooms.length - rooms.length);
    for (const [index, room] of rooms.entries()) {
      if (deadlineReached(deadlineAt)) {
        summary.deferredRoomPages += rooms.length - index;
        break;
      }
      await yieldEvery(index, 2);
      const areaId = readHomeAssistantObjectId(room, 'objectId', 'areaId') ?? room.id;
      try {
        const page = await generateHomeGraphRoomPage({
          ...context,
          input: {
            knowledgeSpaceId: context.spaceId,
            areaId,
            title: room.title,
            metadata: { automation: 'snapshot-sync' },
          },
        });
        summary.roomPages += 1;
        if (page.artifactCreated) summary.artifacts += 1;
        if (page.source) summary.sources += 1;
      } catch (error) {
        summary.errors.push({
          kind: 'room-page',
          targetId: areaId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await yieldToEventLoop();
    }
  }

  summary.truncated = summary.deferredDevicePassports > 0 || summary.deferredRoomPages > 0;
  return summary;
}

function deadlineReached(deadlineAt: number | undefined): boolean {
  return typeof deadlineAt === 'number' && Date.now() >= deadlineAt;
}

export async function refreshHomeGraphDevicePassport(
  context: HomeGraphPageContext & { readonly input: HomeGraphProjectionInput },
): Promise<HomeGraphDevicePassportResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  if (!input.deviceId) throw new Error('refreshDevicePassport requires deviceId.');
  const state = readHomeGraphState(store, spaceId);
  const device = findHomeAssistantNode(state.nodes, 'ha_device', input.deviceId);
  if (!device) throw new Error(`Unknown Home Assistant device: ${input.deviceId}`);
  const entities = state.nodes.filter((node) => (
    node.kind === 'ha_entity' && state.edges.some((edge) => (
      edgeIsActive(edge)
      && edge.fromKind === 'node'
      && edge.fromId === node.id
      && edge.toKind === 'node'
      && edge.toId === device.id
      && edge.relation === 'belongs_to_device'
    ))
  ));
  const sources = sourcesLinkedToNode(device.id, state).filter((source) => !isGeneratedPageSource(source));
  const semanticFacts = semanticFactsLinkedToSources(sources, state.nodes, state.edges);
  const sourceBackedNotes = sourceBackedNotesFromLinkedSources(store, sources);
  const scopedNodeIds = new Set([device.id, ...entities.map((node) => node.id)]);
  const issues = issuesForScope(state.issues, state.edges, scopedNodeIds, sources);
  const missingFields = missingDevicePassportFields(device, sources);
  const passport = await store.upsertNode({
    id: homeGraphNodeId(spaceId, 'ha_device_passport', input.deviceId),
    kind: 'ha_device_passport',
    slug: `${device.slug}-passport`,
    title: `${device.title} passport`,
    summary: `Living device profile for ${device.title}.`,
    aliases: [`${device.title} passport`],
    confidence: 80,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeAssistant: { installationId, objectKind: 'device_passport', objectId: input.deviceId },
      deviceId: input.deviceId,
      missingFields,
      refreshedAt: Date.now(),
    }),
  });
  await store.upsertEdge({
    fromKind: 'node',
    fromId: passport.id,
    toKind: 'node',
    toId: device.id,
    relation: 'source_for',
    metadata: buildHomeGraphMetadata(spaceId, installationId),
  });
  const markdown = renderDevicePassportPage({ spaceId, device, entities, sources, issues, missingFields, semanticFacts, sourceBackedNotes });
  const generated = await materializeGeneratedMarkdown({
    store,
    artifactStore,
    spaceId,
    installationId,
    filename: `${safeHomeGraphFilename(device.title)}-passport.md`,
    markdown,
    projectionKind: 'device-passport',
    canonicalValue: `device-passport:${input.deviceId}`,
    title: `${device.title} passport`,
    summary: `Living device profile for ${device.title}.`,
    tags: ['homeassistant', 'home-graph', 'generated-page', 'device-passport'],
    targetNodeId: passport.id,
    metadata: {
      ...(input.metadata ?? {}),
      deviceId: input.deviceId,
    },
  });
  return {
    ok: true,
    spaceId,
    title: `${device.title} passport`,
    markdown,
    artifact: generated.artifact,
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    device,
    passport,
    missingFields,
    artifactCreated: generated.artifactCreated,
  };
}

export async function generateHomeGraphRoomPage(
  context: HomeGraphPageContext & { readonly input: HomeGraphProjectionInput },
): Promise<HomeGraphProjectionResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  const state = readHomeGraphState(store, spaceId);
  const areaId = input.areaId ?? input.roomId;
  const title = input.title ?? resolveRoomTitle(state.nodes, areaId) ?? 'Home Graph Room';
  const markdown = renderRoomPage({ ...state, title }, areaId);
  const filename = `${safeHomeGraphFilename(title)}.md`;
  const targetNode = areaId
    ? findHomeAssistantNode(state.nodes, 'ha_area', areaId) ?? findHomeAssistantNode(state.nodes, 'ha_room', areaId)
    : undefined;
  const generated = await materializeGeneratedMarkdown({
    store,
    artifactStore,
    spaceId,
    installationId,
    filename,
    markdown,
    projectionKind: 'room-page',
    canonicalValue: `room-page:${areaId ?? 'home'}`,
    title,
    summary: `Living Home Graph room page for ${title}.`,
    tags: ['homeassistant', 'home-graph', 'generated-page', 'room-page'],
    ...(targetNode ? { targetNodeId: targetNode.id } : {}),
    metadata: {
      ...(input.metadata ?? {}),
      ...(areaId ? { areaId } : {}),
    },
  });
  return {
    ok: true,
    spaceId,
    title,
    markdown,
    artifact: generated.artifact,
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    artifactCreated: generated.artifactCreated,
  };
}

export async function generateHomeGraphPacket(
  context: HomeGraphPageContext & { readonly input: HomeGraphProjectionInput },
): Promise<HomeGraphProjectionResult & { readonly artifactCreated: boolean }> {
  const { store, artifactStore, spaceId, installationId, input } = context;
  const title = input.title ?? `${input.packetKind ?? 'home'} packet`;
  const markdown = renderPacketPage(renderHomeGraphState(store, spaceId, title), input);
  const generated = await materializeGeneratedMarkdown({
    store,
    artifactStore,
    spaceId,
    installationId,
    filename: `${safeHomeGraphFilename(title)}.md`,
    markdown,
    projectionKind: 'packet',
    canonicalValue: `packet:${input.packetKind ?? 'home'}:${input.sharingProfile ?? 'default'}`,
    title,
    summary: `Generated ${title} packet for ${input.sharingProfile ?? 'default'} sharing.`,
    tags: ['homeassistant', 'home-graph', 'generated-page', 'packet'],
    metadata: {
      ...(input.metadata ?? {}),
      packetKind: input.packetKind ?? 'home',
      sharingProfile: input.sharingProfile ?? 'default',
      includeFields: input.includeFields ? [...input.includeFields] : [],
      excludeFields: input.excludeFields ? [...input.excludeFields] : [],
    },
  });
  return { ok: true, spaceId, title, markdown, artifact: generated.artifact, source: generated.source, artifactCreated: generated.artifactCreated };
}

async function materializeGeneratedMarkdown(input: HomeGraphPageContext & {
  readonly filename: string;
  readonly markdown: string;
  readonly projectionKind: 'device-passport' | 'room-page' | 'packet';
  readonly canonicalValue: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly targetNodeId?: string;
  readonly relation?: string;
}): Promise<{
  readonly artifact: HomeGraphProjectionResult['artifact'];
  readonly source: KnowledgeSourceRecord;
  readonly linked?: KnowledgeEdgeRecord;
  readonly artifactCreated: boolean;
}> {
  const generatedAt = Date.now();
  const regeneration = readRecord(input.metadata).automation === 'snapshot-sync' ? 'automatic' : 'manual';
  const metadata = {
    ...(input.metadata ?? {}),
    homeGraphSourceKind: 'generated-page',
    homeGraphGeneratedPage: true,
    projectionKind: input.projectionKind,
    generatedAt,
    pagePolicyVersion: HOME_GRAPH_PAGE_POLICY_VERSION,
    pageEditable: true,
    regeneration,
  };
  const homeGraphMetadata = buildHomeGraphMetadata(input.spaceId, input.installationId, metadata);
  const generated = await materializeGeneratedKnowledgeProjection({
    store: input.store,
    artifactStore: input.artifactStore,
    connectorId: HOME_GRAPH_CONNECTOR_ID,
    sourceId: homeGraphSourceId(input.spaceId, 'generated-page', input.canonicalValue),
    sourceType: 'document',
    canonicalUri: namespacedCanonicalUri(input.spaceId, 'generated-page', input.canonicalValue),
    title: input.title,
    summary: input.summary,
    tags: uniqueStrings(input.tags),
    filename: input.filename,
    markdown: input.markdown,
    projectionKind: input.projectionKind,
    metadata: homeGraphMetadata,
    sourceMetadata: homeGraphMetadata,
    artifactMetadata: homeGraphMetadata,
    edgeMetadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      homeGraphGeneratedPage: true,
      projectionKind: input.projectionKind,
    }),
    ...(input.targetNodeId
      ? { target: { kind: 'node' as const, id: input.targetNodeId, relation: input.relation ?? 'source_for' } }
      : {}),
  });
  return {
    artifact: projectionArtifact(generated.artifact),
    source: generated.source,
    ...(generated.linked ? { linked: generated.linked } : {}),
    artifactCreated: generated.artifactCreated,
  };
}

function projectionArtifact(artifact: ArtifactDescriptor): HomeGraphProjectionResult['artifact'] {
  return {
    id: artifact.id,
    mimeType: artifact.mimeType,
    filename: artifact.filename,
    createdAt: artifact.createdAt,
    metadata: artifact.metadata,
  };
}

function createGeneratedPagesSummary(): {
  devicePassports: number;
  roomPages: number;
  artifacts: number;
  sources: number;
  deferredDevicePassports: number;
  deferredRoomPages: number;
  truncated: boolean;
  errors: {
    kind: 'device-passport' | 'room-page';
    targetId: string;
    error: string;
  }[];
} {
  return {
    devicePassports: 0,
    roomPages: 0,
    artifacts: 0,
    sources: 0,
    deferredDevicePassports: 0,
    deferredRoomPages: 0,
    truncated: false,
    errors: [],
  };
}

function compareByTitle(left: KnowledgeNodeRecord, right: KnowledgeNodeRecord): number {
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function prioritizeNodesForGeneratedPages(nodes: readonly KnowledgeNodeRecord[]): readonly KnowledgeNodeRecord[] {
  return [...nodes].sort((left, right) => (
    generatedPagePriority(right) - generatedPagePriority(left)
    || compareByTitle(left, right)
  ));
}

function generatedPagePriority(node: KnowledgeNodeRecord): number {
  const metadata = readRecord(node.metadata.homeAssistant);
  const objectKind = String(metadata.objectKind ?? '').toLowerCase();
  const domain = String(metadata.domain ?? node.metadata.domain ?? '').toLowerCase();
  const title = `${node.title} ${node.summary ?? ''}`.toLowerCase();
  let score = 0;
  if (objectKind === 'device') score += 8;
  if (domain === 'media_player' || domain === 'climate' || domain === 'lock' || domain === 'cover') score += 8;
  if (domain === 'sensor' || domain === 'binary_sensor') score += 2;
  if (/(tv|receiver|speaker|thermostat|lock|garage|camera|printer|router|iphone|espresso|appliance)/.test(title)) score += 6;
  if (/(home assistant|plugin|add-on|addon|conversation|tts|stt|task|backup|hacs|theme|card)/.test(title)) score -= 8;
  return score;
}

function semanticFactsLinkedToSources(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): KnowledgeNodeRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const factIds = new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'source'
    && sourceIds.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.relation === 'supports_fact'
  )).map((edge) => edge.toId));
  return nodes.filter((node) => factIds.has(node.id) && isUsefulHomeGraphPageFact(node));
}

function sourceBackedNotesFromLinkedSources(
  store: KnowledgeStore,
  sources: readonly KnowledgeSourceRecord[],
): string[] {
  const notes: string[] = [];
  for (const source of sources) {
    const extraction = store.getExtractionBySourceId(source.id);
    notes.push(...extractSourceBackedNotes(sourceSemanticText(source, extraction)));
  }
  return uniqueStrings(notes).slice(0, 24);
}

function extractSourceBackedNotes(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?:[.!?]\s+|\n+)/)
    .map((part) => normalizeWhitespace(part.replace(/^[-*•]\s*/, '')))
    .filter((part) => part.length >= 24 && part.length <= 420)
    .filter((part) => hasConcreteFeatureSignal(part))
    .filter((part) => isUsefulHomeGraphSourceBackedNote(part))
    .filter((part) => !isLowValueFeatureOrSpecText(part));
}

function limitRecords<T>(records: readonly T[], limit: number | undefined): readonly T[] {
  if (typeof limit !== 'number') return records;
  if (!Number.isFinite(limit)) return records;
  return records.slice(0, Math.max(0, Math.trunc(limit)));
}

function clampForegroundLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

function readHomeAssistantObjectId(node: KnowledgeNodeRecord, ...keys: readonly string[]): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  for (const key of keys) {
    const value = homeAssistant[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function resolveRoomTitle(nodes: readonly KnowledgeNodeRecord[], areaId: string | undefined): string | undefined {
  if (!areaId) return undefined;
  return (
    findHomeAssistantNode(nodes, 'ha_area', areaId)
    ?? findHomeAssistantNode(nodes, 'ha_room', areaId)
  )?.title;
}
