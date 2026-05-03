import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import { canonicalRepairSubjectNodes, repairSubjectIds } from './repair-subjects.js';
import {
  factsForObject,
  factsForSource,
  isConcreteRepairSubject,
  isUsableSelfImprovementFact,
  linkedObjectsForSource,
  matchingObjectProfiles,
  repairTargetFactCount,
  sourcesForObject,
  uniqueById,
} from './self-improvement-graph.js';
import { readString, readStringArray, semanticMetadata, uniqueStrings } from './utils.js';

export interface GapContext {
  readonly gap: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly repairSourceIds: readonly string[];
}

export interface GapClassification {
  readonly action: 'repair' | 'skip' | 'suppress';
  readonly reason?: string;
  readonly status?: string;
  readonly markAttempt?: boolean;
}

export function collectCandidateGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
  gapIdFilter: ReadonlySet<string> | null,
): KnowledgeNodeRecord[] {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  return [...graph.nodesById.values()]
    .filter((node) => node.kind === 'knowledge_gap' && node.status === 'active')
    .filter((node) => !gapIdFilter || gapIdFilter.has(node.id))
    .filter((node) => !sourceIdFilter || gapMatchesSourceFilter(node, sourceIdFilter, edges))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

export function buildGapContext(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): GapContext {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const sourcesById = graph.sourcesById;
  const nodesById = graph.nodesById;
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  const directSources = sourceIds.map((id) => sourcesById.get(id)).filter((source): source is KnowledgeSourceRecord => Boolean(source));
  const linkedObjects = canonicalRepairSubjectNodes({
    text: `${gap.title} ${gap.summary ?? ''}`,
    objectProfiles,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((id) => nodesById.get(id)).filter((node): node is KnowledgeNodeRecord => Boolean(node)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId))
        .filter((node): node is KnowledgeNodeRecord => Boolean(node)),
    ],
  });
  const sources = uniqueById([
    ...directSources,
    ...linkedObjects.flatMap((object) => sourcesForObject(object.id, edges, sourcesById)),
  ]);
  const facts = uniqueById([
    ...sources.flatMap((source) => factsForSource(source.id, edges, nodesById)),
    ...linkedObjects.flatMap((object) => factsForObject(object.id, edges, nodesById)),
  ]);
  const repairSourceIds = uniqueStrings(edges
    .filter((edge) => edge.fromKind === 'source'
      && edge.toKind === 'node'
      && edge.toId === gap.id
      && edge.relation === 'repairs_gap')
    .map((edge) => edge.fromId));
  return { gap, sources, linkedObjects, facts, repairSourceIds };
}

export function classifyGap(
  context: GapContext,
  force: boolean,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): GapClassification {
  const status = readString(context.gap.metadata.repairStatus);
  const nextAttemptAt = readNumber(context.gap.metadata.nextRepairAttemptAt);
  const repairedWithFacts = status === 'repaired' && hasRepairFactEvidence(context);
  if (!force && repairedWithFacts) return { action: 'skip', reason: 'Gap already has promoted repair facts.', status: 'repaired' };
  if (!force && status !== 'repaired' && nextAttemptAt && nextAttemptAt > Date.now()) return { action: 'skip', reason: 'Gap repair retry window has not elapsed.', status: 'retry_wait', markAttempt: true };
  if (!force && hasRepairEdge(context) && hasRepairFactEvidence(context)) return { action: 'skip', reason: 'Gap already has promoted repair facts.', status: 'already_repaired' };
  if (isNotApplicableGap(context, objectProfiles)) return { action: 'suppress', reason: 'The gap is not applicable to the linked subject.' };
  if (!hasConcreteSubject(context, objectProfiles)) {
    return { action: 'skip', reason: 'Gap has no concrete source or subject for automatic repair.', status: 'needs_context', markAttempt: true };
  }
  if (context.sources.length === 0 && context.linkedObjects.length === 0) {
    return { action: 'skip', reason: 'Gap has no source context for automatic repair.', status: 'needs_context', markAttempt: true };
  }
  return { action: 'repair' };
}

export async function linkRepairSources(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  query: string,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): Promise<number> {
  let linked = 0;
  const linkedObjectIds = repairSubjectIdsForGap(store, spaceId, gap, objectProfiles);
  for (const sourceId of sourceIds) {
    if (!store.getSource(sourceId)) continue;
    await store.upsertEdge({
      fromKind: 'source',
      fromId: sourceId,
      toKind: 'node',
      toId: gap.id,
      relation: 'repairs_gap',
      weight: 0.8,
      metadata: semanticMetadata(spaceId, {
        query,
        repairedAt: Date.now(),
      }),
    });
    linked += 1;
    for (const nodeId of linkedObjectIds) {
      await store.upsertEdge({
        fromKind: 'source',
        fromId: sourceId,
        toKind: 'node',
        toId: nodeId,
        relation: 'source_for',
        weight: 0.78,
        metadata: semanticMetadata(spaceId, {
          query,
          linkedBy: 'semantic-gap-repair',
          repairedAt: Date.now(),
        }),
      });
    }
  }
  return linked;
}

function gapMatchesSourceFilter(
  gap: KnowledgeNodeRecord,
  sourceIdFilter: ReadonlySet<string>,
  edges: readonly KnowledgeEdgeRecord[],
): boolean {
  if (gap.sourceId && sourceIdFilter.has(gap.sourceId)) return true;
  if (readStringArray(gap.metadata.sourceIds).some((sourceId) => sourceIdFilter.has(sourceId))) return true;
  return edges.some((edge) => (
    edge.fromKind === 'source'
    && sourceIdFilter.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.toId === gap.id
  ));
}

function hasRepairEdge(context: GapContext): boolean {
  return context.repairSourceIds.length > 0;
}

function hasRepairFactEvidence(context: GapContext): boolean {
  const repairSourceIds = new Set(context.repairSourceIds);
  const subjectIds = new Set(context.linkedObjects.map((node) => node.id));
  const usableFacts = context.facts.filter((fact) => (
    fact.sourceId
    && repairSourceIds.has(fact.sourceId)
    && readString(fact.metadata.extractor) === 'repair-promotion'
    && isUsableSelfImprovementFact(fact, subjectIds)
  ));
  return usableFacts.length >= repairTargetFactCount(context.gap);
}

function isNotApplicableGap(context: GapContext, objectProfiles: readonly KnowledgeObjectProfilePolicy[]): boolean {
  const text = `${context.gap.title} ${context.gap.summary ?? ''}`.toLowerCase();
  const suppressedByProfile = matchingObjectProfiles(context.linkedObjects, objectProfiles)
    .flatMap((profile) => profile.suppressedGapKinds ?? [])
    .some((kind) => kind.trim().length > 0 && text.includes(kind.trim().toLowerCase()));
  if (suppressedByProfile) return true;
  if (text.includes('battery')) {
    return context.linkedObjects.length > 0
      && !/\b(remote|controller|accessory|handset)\b/.test(text)
      && context.linkedObjects.every((node) => !batteryCanBeIntrinsicToSubject(node));
  }
  return false;
}

function batteryCanBeIntrinsicToSubject(node: KnowledgeNodeRecord): boolean {
  if (node.metadata.batteryPowered === true) return true;
  const batteryType = readString(node.metadata.batteryType);
  if (batteryType && batteryType !== 'none') return true;
  const text = `${node.kind} ${node.title} ${node.summary ?? ''} ${node.aliases.join(' ')} ${JSON.stringify(node.metadata)}`.toLowerCase();
  return /\b(battery|button|keypad|leak sensor|motion sensor|contact sensor|door sensor|window sensor|remote|lock|thermostat|phone|watch|handheld|portable|ble beacon|ibeacon|tag)\b/.test(text);
}

function hasConcreteSubject(context: GapContext, objectProfiles: readonly KnowledgeObjectProfilePolicy[]): boolean {
  return context.linkedObjects.some((node) => {
    if (isConcreteRepairSubject(node, objectProfiles)) return true;
    return Boolean(readString(node.metadata.manufacturer) && readString(node.metadata.model));
  }) || context.sources.some((source) => Boolean(source.title || source.url || source.sourceUri || source.canonicalUri));
}

function repairSubjectIdsForGap(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): string[] {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const nodesById = graph.nodesById;
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  return repairSubjectIds({
    text: `${gap.title} ${gap.summary ?? ''}`,
    objectProfiles,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((nodeId) => nodesById.get(nodeId)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ],
  });
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
