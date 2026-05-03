import type { ArtifactStore } from '../../artifacts/index.js';
import { logger } from '../../utils/logger.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import {
  buildHomeGraphMetadata,
  isGeneratedPageSource,
  mergeSourceStatus,
  readHomeAssistantMetadataString,
  readString,
  readStringArray,
  uniqueStrings,
} from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import {
  compareHomeGraphPageSources,
  homeGraphPageSourceWeight,
  isUsefulHomeGraphPageFact,
  isUsefulHomeGraphPageSource,
  isUsefulHomeGraphPageSourceCandidate,
} from './page-quality.js';
import type { HomeGraphAskResult } from './types.js';

const MAX_ASK_REFRESH_DEVICES = 2;
const MAX_ASK_PAGE_SOURCES_TO_CONSIDER = 16;
const MAX_ASK_PAGE_SOURCES_TO_LINK = 8;
const ASK_FACT_SOURCE_WEIGHT = 0.82;
const ASK_FACT_DESCRIBES_WEIGHT = 0.8;

export async function refreshDevicePagesForHomeGraphAsk(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly answer: HomeGraphAskResult;
}): Promise<{ readonly requested: boolean; readonly refreshed: number }> {
  if ((input.answer.answer.facts?.length ?? 0) === 0 && input.answer.answer.sources.length === 0) return { requested: false, refreshed: 0 };
  const devices = input.answer.answer.linkedObjects.filter((node) => node.kind === 'ha_device').slice(0, MAX_ASK_REFRESH_DEVICES);
  try {
    await persistAnswerFactSubjectLinks({
      store: input.store,
      spaceId: input.spaceId,
      installationId: input.installationId,
      devices,
      facts: input.answer.answer.facts ?? [],
      sources: input.answer.answer.sources ?? [],
    });
  } catch (error) {
    logger.warn('Home Graph Ask page enrichment bookkeeping failed', {
      spaceId: input.spaceId,
      installationId: input.installationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let refreshed = 0;
  for (const device of devices) {
    const deviceId = readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id;
    try {
      await refreshHomeGraphDevicePassport({
        store: input.store,
        artifactStore: input.artifactStore,
        spaceId: input.spaceId,
        installationId: input.installationId,
        input: {
          knowledgeSpaceId: input.spaceId,
          deviceId,
          metadata: { automation: 'ask-refresh' },
        },
      });
      refreshed += 1;
    } catch (error) {
      logger.warn('Home Graph Ask generated page refresh failed', {
        spaceId: input.spaceId,
        installationId: input.installationId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { requested: devices.length > 0, refreshed };
}

async function persistAnswerFactSubjectLinks(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly devices: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
}): Promise<void> {
  if (input.devices.length === 0) return;
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));
  const pageSources: KnowledgeSourceRecord[] = [];
  for (const source of input.sources.slice(0, MAX_ASK_PAGE_SOURCES_TO_CONSIDER)) {
    const existing = input.store.getSource(source.id);
    if (!isUsefulHomeGraphPageSourceCandidate(source, existing)) continue;
    const storedSource = await upsertAnswerPageSource(input, source);
    if (isUsefulHomeGraphPageSource(storedSource)) pageSources.push(storedSource);
  }
  for (const storedSource of pageSources.sort(compareHomeGraphPageSources).slice(0, MAX_ASK_PAGE_SOURCES_TO_LINK)) {
    for (const device of input.devices) {
      await input.store.upsertEdge({
        fromKind: 'source',
        fromId: storedSource.id,
        toKind: 'node',
        toId: device.id,
        relation: 'source_for',
        weight: homeGraphPageSourceWeight(storedSource),
        metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
          linkedBy: 'homegraph-ask-page-refresh',
        }),
      });
    }
  }
  for (const fact of input.facts) {
    if (!isUsefulHomeGraphPageFact(fact) || !fact.sourceId) continue;
    const source = input.store.getSource(fact.sourceId);
    if (!source || source.status === 'stale' || isGeneratedPageSource(source)) continue;
    const targets = answerFactTargetDevices(fact, devicesById);
    if (targets.length === 0) continue;
    const existing = input.store.getNode(fact.id) ?? fact;
    const sourceId = existing.sourceId ?? fact.sourceId;
    const subjectIds = uniqueStrings([
      ...readStringArray(existing.metadata.subjectIds),
      ...readStringArray(existing.metadata.linkedObjectIds),
      ...targets.map((device) => device.id),
    ]).filter((id) => devicesById.has(id));
    const targetHints = uniqueTargetHints([
      ...targets.map((device) => ({
        id: device.id,
        kind: device.kind,
        title: device.title,
        ...(device.summary ? { summary: device.summary } : {}),
      })),
      ...readTargetHints(existing.metadata.targetHints),
    ]).filter((hint) => devicesById.has(readString(hint.id) ?? ''));
    const updatedFact = await input.store.upsertNode({
      id: existing.id,
      kind: existing.kind,
      slug: existing.slug,
      title: existing.title,
      ...(existing.summary ? { summary: existing.summary } : {}),
      aliases: existing.aliases,
      status: existing.status,
      confidence: existing.confidence,
      ...(sourceId ? { sourceId } : {}),
      metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
        ...existing.metadata,
        semanticKind: 'fact',
        subject: targets[0]?.title,
        subjectIds,
        linkedObjectIds: subjectIds,
        targetHints,
        sourceId,
        linkedBy: 'homegraph-ask-page-refresh',
      }),
    });
    await input.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: updatedFact.id,
      relation: 'supports_fact',
      weight: ASK_FACT_SOURCE_WEIGHT,
      metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
        linkedBy: 'homegraph-ask-page-refresh',
      }),
    });
    for (const device of targets) {
      await input.store.upsertEdge({
        fromKind: 'node',
        fromId: updatedFact.id,
        toKind: 'node',
        toId: device.id,
        relation: 'describes',
        weight: ASK_FACT_DESCRIBES_WEIGHT,
        metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
          linkedBy: 'homegraph-ask-page-refresh',
          sourceId: source.id,
        }),
      });
    }
  }
}

async function upsertAnswerPageSource(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
}, source: KnowledgeSourceRecord): Promise<KnowledgeSourceRecord> {
  const existing = input.store.getSource(source.id);
  return input.store.upsertSource({
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    title: source.title ?? existing?.title,
    sourceUri: source.sourceUri ?? source.url ?? existing?.sourceUri ?? existing?.url,
    canonicalUri: source.canonicalUri ?? existing?.canonicalUri,
    summary: source.summary ?? existing?.summary,
    description: source.description ?? existing?.description,
    tags: source.tags.length > 0 ? source.tags : existing?.tags,
    folderPath: source.folderPath ?? existing?.folderPath,
    status: mergeSourceStatus(source.status, existing?.status),
    artifactId: source.artifactId ?? existing?.artifactId,
    contentHash: source.contentHash ?? existing?.contentHash,
    lastCrawledAt: source.lastCrawledAt ?? existing?.lastCrawledAt,
    crawlError: source.crawlError ?? existing?.crawlError,
    sessionId: source.sessionId ?? existing?.sessionId,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      ...(existing?.metadata ?? {}),
      ...source.metadata,
    }),
  });
}

function answerFactTargetDevices(
  fact: KnowledgeNodeRecord,
  devicesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): readonly KnowledgeNodeRecord[] {
  const ids = uniqueStrings([
    ...readStringArray(fact.linkedObjectIds),
    ...readStringArray(fact.subjectIds),
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  const explicit = ids.map((id) => devicesById.get(id)).filter((device): device is KnowledgeNodeRecord => Boolean(device));
  return explicit;
}

function readTargetHints(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function uniqueTargetHints(values: Iterable<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const seen = new Set<string>();
  const result: Record<string, unknown>[] = [];
  for (const value of values) {
    const id = readString(value.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(value);
  }
  return result;
}
