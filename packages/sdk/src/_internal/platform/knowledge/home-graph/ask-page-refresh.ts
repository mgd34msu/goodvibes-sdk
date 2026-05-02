import type { ArtifactStore } from '../../artifacts/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { isUsefulHomeGraphPageFact } from '../semantic/fact-quality.js';
import { buildHomeGraphMetadata, isGeneratedPageSource, readRecord } from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import type { HomeGraphAskResult } from './types.js';

export async function refreshDevicePagesForHomeGraphAsk(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly answer: HomeGraphAskResult;
}): Promise<{ readonly requested: boolean; readonly refreshed: number }> {
  if ((input.answer.answer.facts?.length ?? 0) === 0 && input.answer.answer.sources.length === 0) return { requested: false, refreshed: 0 };
  const devices = input.answer.answer.linkedObjects.filter((node) => node.kind === 'ha_device').slice(0, 2);
  try {
    await persistAnswerFactSubjectLinks({
      store: input.store,
      spaceId: input.spaceId,
      installationId: input.installationId,
      devices,
      facts: input.answer.answer.facts ?? [],
    });
  } catch {
    // Ask should still return even if page enrichment bookkeeping fails.
  }
  let refreshed = 0;
  for (const device of devices) {
    const deviceId = readHomeAssistantObjectId(device) ?? device.id;
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
    } catch {
      // Ask should never fail solely because a generated page refresh failed.
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
}): Promise<void> {
  if (input.devices.length === 0 || input.facts.length === 0) return;
  const devicesById = new Map(input.devices.map((device) => [device.id, device]));
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
      weight: 0.82,
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
        weight: 0.8,
        metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
          linkedBy: 'homegraph-ask-page-refresh',
          sourceId: source.id,
        }),
      });
    }
  }
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
  if (explicit.length > 0) return explicit;
  return devicesById.size === 1 ? [...devicesById.values()] : [];
}

function readHomeAssistantObjectId(node: { readonly id: string; readonly metadata: Record<string, unknown> }): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const value = homeAssistant.objectId ?? homeAssistant.deviceId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function readTargetHints(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
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
