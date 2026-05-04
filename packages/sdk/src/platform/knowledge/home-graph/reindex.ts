import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { isGeneratedPageSource, readHomeAssistantMetadataString, uniqueStrings } from './helpers.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { readHomeGraphSearchState } from './search.js';
import { readHomeGraphState } from './state.js';
import { homeGraphExtractionNeedsRepair } from './search.js';
import {
  HOME_GRAPH_PAGE_POLICY_VERSION,
  refreshHomeGraphDevicePassport,
  type HomeGraphPageContext,
} from './generated-pages.js';
import type {
  HomeGraphAutoLinkResult,
} from './auto-link.js';
import type {
  HomeGraphGeneratedPagesSummary,
  HomeGraphReindexInput,
  HomeGraphReindexResult,
} from './types.js';

export interface HomeGraphReindexContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly extract: (
    source: KnowledgeSourceRecord,
    artifact: ArtifactDescriptor,
    spaceId: string,
    installationId: string,
  ) => Promise<KnowledgeExtractionRecord | undefined>;
  readonly autoLinkExistingSources: (
    spaceId: string,
    installationId: string,
    sourceIds?: readonly string[],
  ) => Promise<readonly HomeGraphAutoLinkResult[]>;
  readonly refreshQualityIssues: (spaceId: string, installationId: string) => Promise<readonly KnowledgeIssueRecord[]>;
}

export function coalescedHomeGraphReindexResult(
  store: KnowledgeStore,
  input: HomeGraphReindexInput,
): HomeGraphReindexResult {
  const { spaceId } = resolveReadableHomeGraphSpace(store, input);
  return {
    ok: true,
    spaceId,
    scanned: 0,
    reparsed: 0,
    skipped: 0,
    failed: 0,
    sources: [],
    failures: [],
    coalesced: true,
    truncated: true,
    budgetExhausted: true,
  };
}

export async function runHomeGraphReindex(
  context: HomeGraphReindexContext,
  input: HomeGraphReindexInput = {},
): Promise<HomeGraphReindexResult> {
  await context.store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(context.store, input);
  const state = readHomeGraphSearchState(context.store, spaceId);
  const allSourceCount = readHomeGraphState(context.store, spaceId).sources.length;
  const startedAt = Date.now();
  const maxRunMs = clampPositive(input.maxRunMs, 90_000, 15_000, 180_000);
  const sources = state.sources.filter((source) => !isGeneratedPageSource(source));
  const skippedGeneratedPageArtifactCount = Math.max(0, allSourceCount - sources.length);
  const reindex = await reindexHomeGraphSources({
    spaceId,
    sources,
    extractionBySourceId: state.extractionBySourceId,
    artifactStore: context.artifactStore,
    maxRunMs: Math.min(maxRunMs, 30_000),
    limit: input.limit,
    extract: (source, artifact) => context.extract(source, artifact, spaceId, installationId),
  });
  await yieldToEventLoop();
  const relinkedSourceIds = reindex.sources.map((source) => source.id);
  const linked = relinkedSourceIds.length > 0 || input.force === true
    ? await context.autoLinkExistingSources(spaceId, installationId, input.force === true ? undefined : relinkedSourceIds)
    : [];
  await yieldToEventLoop();
  const changedSourceIds = uniqueStrings([
    ...reindex.sources.map((source) => source.id),
    ...linked.map((item) => item.edge.fromKind === 'source' ? item.edge.fromId : undefined),
  ]);
  const forcedSourceIds = input.force === true && changedSourceIds.length === 0
    ? sources.slice(0, clampPositive(input.semanticLimit, 8, 1, 24)).map((source) => source.id)
    : [];
  const semanticSourceIds = changedSourceIds.length > 0 ? changedSourceIds : forcedSourceIds;
  const remainingMs = Math.max(5_000, maxRunMs - (Date.now() - startedAt));
  const semantic = semanticSourceIds.length > 0
    ? await context.semanticService?.reindex({
        knowledgeSpaceId: spaceId,
        sourceIds: semanticSourceIds,
        limit: semanticSourceIds.length,
        maxRunMs: Math.min(remainingMs, clampPositive(input.semanticMaxRunMs, 20_000, 5_000, 45_000)),
        force: input.force === true,
      })
    : undefined;
  await yieldToEventLoop();
  const qualityIssues = await context.refreshQualityIssues(spaceId, installationId);
  await yieldToEventLoop();
  const currentState = readHomeGraphState(context.store, spaceId);
  const generated = input.refreshPages === false
    ? emptyGeneratedPagesSummary()
    : await refreshHomeGraphPagesForSources({
        store: context.store,
        artifactStore: context.artifactStore,
        spaceId,
        installationId,
      }, currentState.sources, changedSourceIds, clampPositive(input.generatedPageLimit, 256, 1, 512));
  const refreshedGeneratedPageCount = generated.devicePassports + generated.roomPages;
  return {
    ...reindex,
    changedSourceCount: changedSourceIds.length,
    forcedSourceCount: forcedSourceIds.length,
    skippedGeneratedPageArtifactCount,
    refreshedGeneratedPageCount,
    generatedPagePolicyVersion: HOME_GRAPH_PAGE_POLICY_VERSION,
    ...(linked.length > 0 ? { linked } : {}),
    ...(semantic ? { semantic } : {}),
    qualityIssues,
    generated,
  };
}

export async function reindexHomeGraphSources(input: {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
  readonly artifactStore: ArtifactStore;
  readonly extract: (source: KnowledgeSourceRecord, artifact: ArtifactDescriptor) => Promise<KnowledgeExtractionRecord | undefined>;
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
}): Promise<HomeGraphReindexResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const failures: Array<{ readonly sourceId: string; readonly error: string }> = [];
  const maxRunMs = clampPositive(input.maxRunMs, 30_000, 1_000, 120_000);
  const startedAt = Date.now();
  const candidates = input.sources.slice(0, clampPositive(input.limit, input.sources.length, 1, 10_000));
  let scanned = 0;
  let reparsed = 0;
  let skipped = 0;
  let failed = 0;
  let truncated = input.sources.length > candidates.length;
  let budgetExhausted = false;
  for (const [index, source] of candidates.entries()) {
    await yieldEvery(index);
    if (Date.now() - startedAt >= maxRunMs) {
      truncated = true;
      budgetExhausted = true;
      break;
    }
    const artifactId = typeof source.artifactId === 'string' ? source.artifactId : undefined;
    if (!artifactId) continue;
    scanned += 1;
    const current = input.extractionBySourceId.get(source.id);
    if (!homeGraphExtractionNeedsRepair(current)) {
      skipped += 1;
      continue;
    }
    const artifact = input.artifactStore.get(artifactId);
    if (!artifact) {
      if (isGeneratedPageSource(source)) {
        skipped += 1;
        continue;
      }
      failed += 1;
      failures.push({ sourceId: source.id, error: `Unknown artifact: ${artifactId}` });
      continue;
    }
    const extraction = await input.extract(source, artifact);
    if (!extraction) {
      failed += 1;
      failures.push({ sourceId: source.id, error: 'Artifact extraction failed.' });
      continue;
    }
    reparsed += 1;
    sources.push(source);
    await yieldToEventLoop();
  }
  return { ok: true, spaceId: input.spaceId, scanned, reparsed, skipped, failed, sources, failures, truncated, budgetExhausted };
}

async function refreshHomeGraphPagesForSources(
  context: HomeGraphPageContext,
  sources: readonly KnowledgeSourceRecord[],
  sourceIds: readonly string[],
  limit: number,
): Promise<HomeGraphGeneratedPagesSummary> {
  const summary = emptyGeneratedPagesSummary();
  const state = readHomeGraphState(context.store, context.spaceId);
  const devices = uniqueStrings([
    ...devicesLinkedToSources(state, sourceIds),
    ...devicesWithStaleGeneratedPages(state, sources),
  ]).slice(0, limit);
  if (devices.length === 0) return summary;
  for (const [index, deviceId] of devices.entries()) {
    await yieldEvery(index, 2);
    try {
      const page = await refreshHomeGraphDevicePassport({
        ...context,
        input: {
          knowledgeSpaceId: context.spaceId,
          deviceId,
          metadata: { automation: 'reindex' },
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
  return summary;
}

function devicesLinkedToSources(
  state: ReturnType<typeof readHomeGraphState>,
  sourceIds: readonly string[],
): string[] {
  const wantedSources = new Set(sourceIds);
  if (wantedSources.size === 0) return [];
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const factIds = new Set<string>();
  const deviceIds = new Set<string>();
  for (const edge of state.edges) {
    if (edge.fromKind !== 'source' || !wantedSources.has(edge.fromId) || edge.toKind !== 'node') continue;
    const node = nodesById.get(edge.toId);
    if ((edge.relation === 'source_for' || edge.relation === 'has_manual' || edge.relation === 'repairs_gap') && node?.kind === 'ha_device') {
      const deviceId = readHomeAssistantMetadataString(node, 'objectId', 'deviceId') ?? node.id;
      deviceIds.add(deviceId);
    }
    if (edge.relation === 'supports_fact' && node?.kind === 'fact') factIds.add(node.id);
  }
  for (const edge of state.edges) {
    if (edge.fromKind !== 'node' || !factIds.has(edge.fromId) || edge.toKind !== 'node' || edge.relation !== 'describes') continue;
    const device = nodesById.get(edge.toId);
    if (device?.kind === 'ha_device') deviceIds.add(readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id);
  }
  return [...deviceIds];
}

function devicesWithStaleGeneratedPages(
  state: ReturnType<typeof readHomeGraphState>,
  sources: readonly KnowledgeSourceRecord[],
): string[] {
  const stalePageIds = new Set(sources
    .filter(isGeneratedPageSource)
    .filter((source) => source.metadata.projectionKind === 'device-passport')
    .filter((source) => source.metadata.pagePolicyVersion !== HOME_GRAPH_PAGE_POLICY_VERSION)
    .map((source) => source.id));
  if (stalePageIds.size === 0) return [];
  return state.edges
    .filter((edge) => edge.fromKind === 'source' && stalePageIds.has(edge.fromId) && edge.toKind === 'node')
    .filter((edge) => edge.relation === 'source_for')
    .map((edge) => state.nodes.find((node) => node.id === edge.toId && node.kind === 'ha_device_passport'))
    .filter((passport): passport is KnowledgeNodeRecord => Boolean(passport))
    .map((passport) => readHomeAssistantMetadataString(passport, 'objectId', 'deviceId'))
    .filter((deviceId): deviceId is string => Boolean(deviceId));
}

function emptyGeneratedPagesSummary(): {
  devicePassports: number;
  roomPages: number;
  artifacts: number;
  sources: number;
  errors: { kind: 'device-passport' | 'room-page'; targetId: string; error: string }[];
} {
  return { devicePassports: 0, roomPages: 0, artifacts: 0, sources: 0, errors: [] };
}

function clampPositive(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  const effective = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, Math.trunc(effective)));
}
