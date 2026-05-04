import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { yieldEvery } from '../cooperative.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { buildKnowledgeSemanticGraphIndex } from './graph-index.js';
import {
  factCoverage,
  factsForObject,
  factsForSource,
  hasSpecificIdentity,
  isConcreteRepairSubject,
  isUsableSelfImprovementFact,
  linkedObjectsForSource,
  repairTargetFactCount,
  sourcesForObject,
  subjectTitle,
} from './self-improvement-graph.js';
import {
  readString,
  readStringArray,
  semanticHash,
  semanticMetadata,
  semanticSlug,
} from './utils.js';

export async function discoverIntrinsicGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): Promise<number> {
  const graph = buildKnowledgeSemanticGraphIndex(store, spaceId);
  const edges = graph.edges;
  const sourcesById = new Map([...graph.sourcesById.values()]
    .filter((source) => source.status === 'indexed')
    .filter((source) => !isGeneratedKnowledgeSource(source))
    .filter((source) => !sourceIdFilter || sourceIdFilter.has(source.id))
    .map((source) => [source.id, source]));
  const nodesById = graph.nodesById;
  const createdIds = new Set<string>();
  let created = 0;
  let sourceIndex = 0;

  for (const source of sourcesById.values()) {
    await yieldEvery(sourceIndex++);
    const linkedObjects = linkedObjectsForSource(source.id, edges, nodesById);
    const facts = factsForSource(source.id, edges, nodesById);
    for (const [subjectIndex, subject] of linkedObjects.filter((node) => isConcreteRepairSubject(node, objectProfiles)).entries()) {
      await yieldEvery(subjectIndex, 16);
      if (!shouldCreateIntrinsicFeatureGap(subject, facts, objectProfiles, source)) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, facts, [source], createdIds)) created += 1;
    }
  }

  if (!sourceIdFilter) {
    let subjectIndex = 0;
    for (const subject of nodesById.values()) {
      await yieldEvery(subjectIndex++);
      if (!isConcreteRepairSubject(subject, objectProfiles)) continue;
      const sourceList = sourcesForObject(subject.id, edges, sourcesById);
      const facts = [
        ...sourceList.flatMap((source) => factsForSource(source.id, edges, nodesById)),
        ...factsForObject(subject.id, edges, nodesById),
      ];
      const coverage = factCoverage(facts);
      if (coverage.coreFactCount >= 4 && coverage.coveredAreas.size >= 3) continue;
      if (!hasSpecificIdentity(subject, sourceList[0])) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, facts, sourceList, createdIds)) created += 1;
    }
  }

  return created;
}

async function upsertIntrinsicFeatureGap(
  store: KnowledgeStore,
  spaceId: string,
  subject: KnowledgeNodeRecord,
  facts: readonly KnowledgeNodeRecord[],
  sources: readonly KnowledgeSourceRecord[],
  createdIds: Set<string>,
): Promise<boolean> {
  const id = `sem-intrinsic-gap-${semanticHash(spaceId, subject.id, 'features-specifications')}`;
  if (createdIds.has(id)) return false;
  createdIds.add(id);
  const existing = store.getNode(id);
  const subjectIds = new Set([subject.id]);
  const existingRepaired = existing
    ? existing.status === 'active'
      && readString(existing.metadata.repairStatus) === 'repaired'
      && facts.filter((fact) => isUsableSelfImprovementFact(fact, subjectIds)).length >= repairTargetFactCount(existing)
    : false;
  if (existingRepaired) return false;

  const title = `What are the complete features and specifications for ${subjectTitle(subject)}?`;
  const primarySource = sources[0]!;
  return store.batch(async () => {
    const gap = await store.upsertNode({
      id,
      kind: 'knowledge_gap',
      slug: semanticSlug(`${spaceId}-intrinsic-gap-${subject.title}`),
      title,
      summary: `The current source-backed facts for ${subjectTitle(subject)} do not yet cover the full feature/specification profile.`,
      aliases: [subject.title, ...subject.aliases].slice(0, 8),
      confidence: 75,
      ...(primarySource ? { sourceId: primarySource.id } : {}),
      metadata: semanticMetadata(spaceId, {
        semanticKind: 'gap',
        gapKind: 'intrinsic_features',
        subject: subject.title,
        sourceIds: sources.map((source) => source.id),
        linkedObjectIds: [subject.id],
        repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
        ...((readStringArray(existing?.metadata.acceptedSourceIds).length > 0) ? { acceptedSourceIds: readStringArray(existing?.metadata.acceptedSourceIds) } : {}),
        ...(typeof existing?.metadata.promotedFactCount === 'number' ? { promotedFactCount: existing.metadata.promotedFactCount } : {}),
        ...(typeof existing?.metadata.nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt: existing.metadata.nextRepairAttemptAt } : {}),
        createdBy: 'semantic-self-improvement',
      }),
    });
    for (const source of sources) {
      await store.upsertEdge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: gap.id,
        relation: 'has_gap',
        metadata: semanticMetadata(spaceId, { intrinsic: true }),
      });
    }
    await store.upsertEdge({
      fromKind: 'node',
      fromId: subject.id,
      toKind: 'node',
      toId: gap.id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { intrinsic: true }),
    });
    await store.upsertIssue({
      id: `sem-intrinsic-gap-issue-${semanticHash(spaceId, subject.id, 'features-specifications')}`,
      severity: 'info',
      code: 'knowledge.intrinsic_gap',
      message: title,
      status: 'open',
      ...(primarySource ? { sourceId: primarySource.id } : {}),
      nodeId: gap.id,
      metadata: semanticMetadata(spaceId, {
        namespace: `knowledge:${spaceId}:semantic`,
        subjectId: subject.id,
        gapKind: 'intrinsic_features',
      }),
    });
    return !existing;
  });
}

function shouldCreateIntrinsicFeatureGap(
  subject: KnowledgeNodeRecord,
  facts: readonly KnowledgeNodeRecord[],
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
  source?: KnowledgeSourceRecord,
): boolean {
  if (!isConcreteRepairSubject(subject, objectProfiles)) return false;
  if (!hasSpecificIdentity(subject, source)) return false;
  const coverage = factCoverage(facts);
  return coverage.coreFactCount < 4 || coverage.coveredAreas.size < 3;
}
