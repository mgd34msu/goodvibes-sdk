import type { ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeIssueRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { isGeneratedPageSource, uniqueStrings } from './helpers.js';
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
  readonly semanticService?: KnowledgeSemanticService;
  readonly extract: (
    source: KnowledgeSourceRecord,
    artifact: ArtifactDescriptor,
    spaceId: string,
    installationId: string,
  ) => Promise<KnowledgeExtractionRecord | undefined>;
  readonly autoLinkExistingSources: (spaceId: string, installationId: string) => Promise<readonly HomeGraphAutoLinkResult[]>;
  readonly refreshQualityIssues: (spaceId: string, installationId: string) => Promise<readonly KnowledgeIssueRecord[]>;
}

export async function runHomeGraphReindex(
  context: HomeGraphReindexContext,
  input: HomeGraphReindexInput = {},
): Promise<HomeGraphReindexResult> {
  await context.store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(context.store, input);
  const state = readHomeGraphSearchState(context.store, spaceId);
  const startedAt = Date.now();
  const maxRunMs = clampPositive(input.maxRunMs, 90_000, 15_000, 180_000);
  const sources = state.sources.filter((source) => !isGeneratedPageSource(source));
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
  const linked = await context.autoLinkExistingSources(spaceId, installationId);
  await yieldToEventLoop();
  const changedSourceIds = uniqueStrings([
    ...reindex.sources.map((source) => source.id),
    ...linked.map((item) => item.edge.fromKind === 'source' ? item.edge.fromId : undefined),
  ]);
  const semanticSourceIds = changedSourceIds.length > 0
    ? changedSourceIds
    : input.force === true
      ? sources.slice(0, clampPositive(input.semanticLimit, 8, 1, 24)).map((source) => source.id)
      : [];
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
  return {
    ...reindex,
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
  readonly limit?: number;
  readonly maxRunMs?: number;
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
  for (const source of candidates) {
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
  for (const deviceId of devices) {
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
  return state.edges
    .filter((edge) => edge.fromKind === 'source' && wantedSources.has(edge.fromId) && edge.toKind === 'node')
    .filter((edge) => edge.relation === 'source_for' || edge.relation === 'has_manual' || edge.relation === 'repairs_gap')
    .map((edge) => state.nodes.find((node) => node.id === edge.toId && node.kind === 'ha_device'))
    .map((node) => readHomeAssistantObjectId(node) ?? node?.id)
    .filter((deviceId): deviceId is string => Boolean(deviceId));
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
    .map((passport) => readHomeAssistantObjectId(passport))
    .filter((deviceId): deviceId is string => Boolean(deviceId));
}

function readHomeAssistantObjectId(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const metadata = (node as { readonly metadata?: unknown }).metadata;
  const ha = metadata && typeof metadata === 'object' ? (metadata as { readonly homeAssistant?: unknown }).homeAssistant : undefined;
  if (!ha || typeof ha !== 'object') return undefined;
  const objectId = (ha as { readonly objectId?: unknown; readonly deviceId?: unknown }).objectId;
  const deviceId = (ha as { readonly objectId?: unknown; readonly deviceId?: unknown }).deviceId;
  return typeof objectId === 'string' && objectId ? objectId : typeof deviceId === 'string' && deviceId ? deviceId : undefined;
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

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
