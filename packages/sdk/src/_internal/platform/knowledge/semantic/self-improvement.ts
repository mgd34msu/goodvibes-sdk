import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { recoverNoRepairerTasks, recoverStaleActiveTasks } from './self-improvement-recovery.js';
import { readRecord, readString, semanticHash, semanticMetadata, semanticSlug, sourceKnowledgeSpace, uniqueStrings } from './utils.js';
import { withTimeout } from './timeouts.js';
import { updateRefinementTask, upsertRefinementTaskForGap } from './self-improvement-tasks.js';
import { promoteRepairSources } from './self-improvement-promotion.js';
import { canonicalRepairSubjectNodes, repairSubjectIds } from './repair-subjects.js';

const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFINEMENT_LIMIT = 12;
const MAX_REFINEMENT_LIMIT = 24;
const DEFAULT_REFINEMENT_RUN_MS = 45_000;
const MAX_REFINEMENT_RUN_MS = 60_000;

interface SelfImproveContext {
  readonly store: KnowledgeStore;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null;
  readonly activeGapRepairs: Set<string>;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string }) => Promise<unknown>;
}

interface GapContext {
  readonly gap: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
  readonly repairSourceIds: readonly string[];
}

export async function runKnowledgeSemanticSelfImprovement(
  context: SelfImproveContext,
  input: KnowledgeSemanticSelfImproveInput = {},
): Promise<KnowledgeSemanticSelfImproveResult> {
  await context.store.init();
  const sourceIdFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
  const gapIdFilter = input.gapIds?.length ? new Set(input.gapIds) : null;
  const spaceId = resolveSelfImproveSpace(context.store, input);
  await recoverStaleActiveTasks(context.store, spaceId);
  if (context.gapRepairer) {
    await recoverNoRepairerTasks(context.store, spaceId);
  }
  const createdGaps = await discoverIntrinsicGaps(context.store, spaceId, sourceIdFilter);
  const candidates = collectCandidateGaps(context.store, spaceId, sourceIdFilter, gapIdFilter);
  const requestedLimit = Math.max(1, input.limit ?? DEFAULT_REFINEMENT_LIMIT);
  const cappedLimit = Math.min(requestedLimit, MAX_REFINEMENT_LIMIT);
  const maxRunMs = Math.min(
    MAX_REFINEMENT_RUN_MS,
    Math.max(5_000, input.maxRunMs ?? DEFAULT_REFINEMENT_RUN_MS),
  );
  const startedAt = Date.now();
  const gaps = candidates.slice(0, cappedLimit);
  const effectiveLimit = gaps.length;
  let truncated = candidates.length > gaps.length || requestedLimit > cappedLimit;
  let budgetExhausted = false;
  let processedGaps = 0;
  let repairableGaps = 0;
  let suppressedGaps = 0;
  let skippedGaps = 0;
  let blockedGaps = 0;
  let closedGaps = 0;
  let queuedTasks = 0;
  let searched = 0;
  let ingestedSources = 0;
  let linkedRepairs = 0;
  let promotedFactCount = 0;
  let nextRepairAttemptAt: number | undefined;
  const taskIds: string[] = [];
  const ingestedSourceIds: string[] = [];
  const acceptedSourceIds: string[] = [];
  const errors: { gapId: string; error: string }[] = [];
  const trigger = input.reason ?? 'manual';

  for (const gap of gaps) {
    if (Date.now() - startedAt >= maxRunMs) {
      truncated = true;
      budgetExhausted = true;
      break;
    }
    processedGaps += 1;
    const gapContext = buildGapContext(context.store, spaceId, gap);
    let task = await upsertRefinementTaskForGap(context.store, spaceId, gapContext, trigger, 'detected', 'Gap was detected for semantic refinement.');
    taskIds.push(task.id);
    const classification = classifyGap(gapContext, input.force === true);
    if (classification.action === 'suppress') {
      await suppressGap(context.store, gap, classification.reason, spaceId);
      await updateRefinementTask(context.store, task, 'suppressed', classification.reason ?? 'Gap was classified as not applicable.');
      suppressedGaps += 1;
      continue;
    }
    if (classification.action === 'skip') {
      if (classification.status === 'repaired' || classification.status === 'already_repaired') {
        closedGaps += 1;
        await updateRefinementTask(context.store, task, 'closed', classification.reason ?? 'Gap is already repaired.');
        continue;
      }
      if (classification.status === 'active') {
        skippedGaps += 1;
        await updateRefinementTask(context.store, task, 'queued', classification.reason ?? 'Gap repair is already active.');
        continue;
      }
      blockedGaps += 1;
      if (classification.markAttempt) {
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: classification.status ?? 'skipped',
          reason: classification.reason,
        });
      }
      await updateRefinementTask(context.store, task, 'blocked', classification.reason ?? 'Gap is not currently repairable.');
      continue;
    }
    if (input.deferRepair === true) {
      if (!context.gapRepairer) {
        blockedGaps += 1;
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: 'no_repairer',
          reason: 'No semantic gap repairer is configured.',
        });
        await updateRefinementTask(context.store, task, 'blocked', 'No semantic gap repairer is configured.');
        continue;
      }
      queuedTasks += 1;
      await updateRefinementTask(context.store, task, 'queued', 'Gap repair was queued for background refinement.', {
        deferred: true,
      });
      continue;
    }
    if (!context.gapRepairer) {
      blockedGaps += 1;
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: 'no_repairer',
        reason: 'No semantic gap repairer is configured.',
      });
      await updateRefinementTask(context.store, task, 'blocked', 'No semantic gap repairer is configured.');
      continue;
    }
    const gapRepairer = context.gapRepairer;
    const repairKey = `${spaceId}:${gap.id}`;
    if (context.activeGapRepairs.has(repairKey)) {
      skippedGaps += 1;
      await updateRefinementTask(context.store, task, 'queued', 'Gap repair is already active.');
      continue;
    }
    repairableGaps += 1;
    queuedTasks += 1;
    context.activeGapRepairs.add(repairKey);
    try {
      task = await updateRefinementTask(context.store, task, 'searching', 'Searching for source-backed repair evidence.', { query: gap.title });
      const remainingMs = Math.max(1_000, startedAt + maxRunMs - Date.now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      const result = await (async () => {
        try {
          return await withTimeout(gapRepairer({
            spaceId,
            query: gap.title,
            gaps: [gap],
            sources: gapContext.sources,
            linkedObjects: gapContext.linkedObjects,
            facts: gapContext.facts,
            maxSources: 5,
            deadlineAt: Date.now() + remainingMs,
            signal: controller.signal,
          }), remainingMs, 'Semantic gap repair exceeded its run budget.');
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      })();
      if (result?.searched) searched += 1;
      ingestedSources += result?.ingestedSourceIds.length ?? 0;
      ingestedSourceIds.push(...(result?.ingestedSourceIds ?? []));
      const gapAcceptedSourceIds = uniqueStrings([...(result?.acceptedSourceIds ?? []), ...(result?.ingestedSourceIds ?? [])]);
      acceptedSourceIds.push(...gapAcceptedSourceIds);
      let gapPromotedFactCount = 0;
      task = await updateRefinementTask(context.store, task, 'evaluating', result?.reason ?? 'Source discovery completed.', {
        query: result?.query ?? gap.title,
        sourceAssessments: result?.sourceAssessments ?? [],
        ingestedSourceIds: result?.ingestedSourceIds ?? [],
        acceptedSourceIds: gapAcceptedSourceIds,
        skippedUrls: result?.skippedUrls ?? [],
      });
      if (gapAcceptedSourceIds.length) {
        task = await updateRefinementTask(context.store, task, 'applying', 'Linking accepted repair sources into the graph.');
      }
      linkedRepairs += await linkRepairSources(context.store, spaceId, gap, gapAcceptedSourceIds, result?.query ?? gap.title);
      if (gapAcceptedSourceIds.length > 0) {
        gapPromotedFactCount = await promoteRepairSources(context, spaceId, gap, gapAcceptedSourceIds, task, startedAt + maxRunMs);
        promotedFactCount += gapPromotedFactCount;
      }
      const evidenceSufficient = result?.evidenceSufficient !== false && gapAcceptedSourceIds.length > 0 && gapPromotedFactCount > 0;
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: evidenceSufficient ? 'repaired' : gapAcceptedSourceIds.length ? 'deferred' : 'searched_no_sources',
        reason: result?.reason,
        query: result?.query,
      });
      if (evidenceSufficient) {
        closedGaps += 1;
        await updateRefinementTask(context.store, task, 'closed', 'Repair sources were accepted and linked to the gap.', {
          acceptedSourceIds: gapAcceptedSourceIds,
          ingestedSourceIds: result?.ingestedSourceIds ?? [],
          promotedFactCount: gapPromotedFactCount,
        });
      } else if (gapAcceptedSourceIds.length) {
        blockedGaps += 1;
        nextRepairAttemptAt = Date.now() + RETRY_DELAY_MS;
        await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'Accepted source evidence was linked, but the gap still needs corroboration.', {
          acceptedSourceIds: gapAcceptedSourceIds,
          promotedFactCount: gapPromotedFactCount,
          retryable: true,
          nextRepairAttemptAt,
        });
      } else {
        blockedGaps += 1;
        await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'No acceptable repair sources were found.');
      }
    } catch (error) {
      errors.push({ gapId: gap.id, error: error instanceof Error ? error.message : String(error) });
      const reason = error instanceof Error ? error.message : String(error);
      const budgetError = isBudgetError(reason);
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: budgetError ? 'deferred' : 'failed',
        reason,
      });
      if (budgetError) {
        blockedGaps += 1;
        nextRepairAttemptAt = Date.now() + RETRY_DELAY_MS;
        await updateRefinementTask(context.store, task, 'blocked', 'Repair was deferred after exhausting the current run budget.', {
          retryable: true,
          nextRepairAttemptAt,
          error: reason,
        });
      } else {
        await updateRefinementTask(context.store, task, 'failed', reason);
      }
    } finally {
      context.activeGapRepairs.delete(repairKey);
    }
    await yieldToEventLoop();
  }

  return {
    scannedGaps: gaps.length,
    candidateGaps: candidates.length,
    processedGaps,
    createdGaps,
    repairableGaps,
    suppressedGaps,
    skippedGaps,
    searched,
    ingestedSources,
    linkedRepairs,
    blockedGaps,
    closedGaps,
    queuedTasks,
    requestedLimit,
    effectiveLimit,
    truncated,
    budgetExhausted,
    taskIds: uniqueStrings(taskIds),
    ingestedSourceIds: uniqueStrings(ingestedSourceIds),
    acceptedSourceIds: uniqueStrings(acceptedSourceIds),
    promotedFactCount,
    ...(nextRepairAttemptAt ? { nextRepairAttemptAt } : {}),
    errors,
  };
}

function resolveSelfImproveSpace(store: KnowledgeStore, input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const firstSource = input.sourceIds?.map((id) => store.getSource(id)).find((source): source is KnowledgeSourceRecord => Boolean(source));
  if (firstSource) return sourceKnowledgeSpace(firstSource);
  const firstGap = input.gapIds?.map((id) => store.getNode(id)).find((node): node is KnowledgeNodeRecord => Boolean(node));
  return normalizeKnowledgeSpaceId(firstGap ? getKnowledgeSpaceId(firstGap) : undefined);
}

async function discoverIntrinsicGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
): Promise<number> {
  const edges = store.listEdges();
  const sourcesById = new Map(store.listSources(10_000)
    .filter((source) => source.status === 'indexed')
    .filter((source) => !isGeneratedKnowledgeSource(source))
    .filter((source) => getKnowledgeSpaceId(source) === spaceId)
    .filter((source) => !sourceIdFilter || sourceIdFilter.has(source.id))
    .map((source) => [source.id, source]));
  const nodesById = new Map(store.listNodes(10_000).filter((node) => getKnowledgeSpaceId(node) === spaceId).map((node) => [node.id, node]));
  const createdIds = new Set<string>();
  let created = 0;
  let sourceIndex = 0;
  for (const source of sourcesById.values()) {
    await yieldEvery(sourceIndex++);
    const linkedObjects = linkedObjectsForSource(source.id, edges, nodesById);
    const facts = factsForSource(source.id, edges, nodesById);
    for (const [subjectIndex, subject] of linkedObjects.filter(isConcreteRepairSubject).entries()) {
      await yieldEvery(subjectIndex, 16);
      if (!shouldCreateIntrinsicFeatureGap(subject, facts, source)) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, [source], createdIds)) created += 1;
    }
  }
  if (!sourceIdFilter) {
    let subjectIndex = 0;
    for (const subject of nodesById.values()) {
      await yieldEvery(subjectIndex++);
      if (!isConcreteRepairSubject(subject)) continue;
      const sourceList = sourcesForObject(subject.id, edges, sourcesById);
      const facts = [
        ...sourceList.flatMap((source) => factsForSource(source.id, edges, nodesById)),
        ...factsForObject(subject.id, edges, nodesById),
      ];
      const coverage = factCoverage(facts);
      if (coverage.coreFactCount >= 4 && coverage.coveredAreas.size >= 3) continue;
      if (!hasSpecificIdentity(subject, sourceList[0])) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, sourceList, createdIds)) created += 1;
    }
  }
  return created;
}

async function upsertIntrinsicFeatureGap(
  store: KnowledgeStore,
  spaceId: string,
  subject: KnowledgeNodeRecord,
  sources: readonly KnowledgeSourceRecord[],
  createdIds: Set<string>,
): Promise<boolean> {
  const id = `sem-intrinsic-gap-${semanticHash(spaceId, subject.id, 'features-specifications')}`;
  if (createdIds.has(id)) return false;
  createdIds.add(id);
  const existing = store.getNode(id);
  if (existing?.status === 'active' && readString(existing.metadata.repairStatus) === 'repaired') return false;
  const title = `What are the complete features and specifications for ${subjectTitle(subject)}?`;
  const primarySource = sources[0];
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
}

function collectCandidateGaps(
  store: KnowledgeStore,
  spaceId: string,
  sourceIdFilter: ReadonlySet<string> | null,
  gapIdFilter: ReadonlySet<string> | null,
): KnowledgeNodeRecord[] {
  const edges = store.listEdges();
  return store.listNodes(10_000)
    .filter((node) => node.kind === 'knowledge_gap' && node.status === 'active')
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .filter((node) => !gapIdFilter || gapIdFilter.has(node.id))
    .filter((node) => !sourceIdFilter || gapMatchesSourceFilter(node, sourceIdFilter, edges))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
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

function buildGapContext(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord): GapContext {
  const edges = store.listEdges();
  const sourcesById = new Map(store.listSources(10_000).filter((source) => getKnowledgeSpaceId(source) === spaceId).map((source) => [source.id, source]));
  const nodesById = new Map(store.listNodes(10_000).filter((node) => getKnowledgeSpaceId(node) === spaceId).map((node) => [node.id, node]));
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

function classifyGap(
  context: GapContext,
  force: boolean,
): { readonly action: 'repair' | 'skip' | 'suppress'; readonly reason?: string; readonly status?: string; readonly markAttempt?: boolean } {
  const status = readString(context.gap.metadata.repairStatus);
  const nextAttemptAt = readNumber(context.gap.metadata.nextRepairAttemptAt);
  if (!force && status === 'repaired') return { action: 'skip', reason: 'Gap already has linked repair sources.', status: 'repaired' };
  if (!force && nextAttemptAt && nextAttemptAt > Date.now()) return { action: 'skip', reason: 'Gap repair retry window has not elapsed.', status: 'retry_wait', markAttempt: true };
  if (!force && hasRepairEdge(context) && hasRepairFactEvidence(context)) return { action: 'skip', reason: 'Gap already has promoted repair facts.', status: 'already_repaired' };
  if (isNotApplicableGap(context)) return { action: 'suppress', reason: 'The gap is not applicable to the linked subject.' };
  if (!hasConcreteSubject(context)) {
    return { action: 'skip', reason: 'Gap has no concrete source or subject for automatic repair.', status: 'needs_context', markAttempt: true };
  }
  if (context.sources.length === 0 && context.linkedObjects.length === 0) {
    return { action: 'skip', reason: 'Gap has no source context for automatic repair.', status: 'needs_context', markAttempt: true };
  }
  return { action: 'repair' };
}

function hasRepairEdge(context: GapContext): boolean {
  return context.repairSourceIds.length > 0;
}

function hasRepairFactEvidence(context: GapContext): boolean {
  const repairSourceIds = new Set(context.repairSourceIds);
  return context.facts.some((fact) => fact.sourceId && repairSourceIds.has(fact.sourceId) && readString(fact.metadata.extractor) === 'repair-promotion');
}

function isNotApplicableGap(context: GapContext): boolean {
  const text = `${context.gap.title} ${context.gap.summary ?? ''}`.toLowerCase();
  if (text.includes('battery')) {
    return context.linkedObjects.some((node) => node.metadata.batteryPowered === false || readString(node.metadata.batteryType) === 'none');
  }
  return false;
}

function hasConcreteSubject(context: GapContext): boolean {
  return context.linkedObjects.some((node) => {
    if (isConcreteRepairSubject(node)) return true;
    return Boolean(readString(node.metadata.manufacturer) && readString(node.metadata.model));
  }) || context.sources.some((source) => Boolean(source.title || source.sourceUri || source.canonicalUri));
}

async function suppressGap(store: KnowledgeStore, gap: KnowledgeNodeRecord, reason: string | undefined, spaceId: string): Promise<void> {
  await store.upsertNode({
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: 'stale',
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...gap.metadata,
      repairStatus: 'not_applicable',
      repairReason: reason,
      repairedAt: Date.now(),
    },
  });
  for (const issue of store.listIssues(10_000).filter((entry) => entry.nodeId === gap.id && entry.status === 'open')) {
    await resolveIssue(store, issue, spaceId, reason ?? 'Gap was classified as not applicable.');
  }
}

async function markGapRepairAttempt(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  spaceId: string,
  details: { readonly status: string; readonly reason?: string; readonly query?: string },
): Promise<void> {
  await store.upsertNode({
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: gap.status,
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...gap.metadata,
      repairStatus: details.status,
      ...(details.reason ? { repairReason: details.reason } : {}),
      ...(details.query ? { repairQuery: details.query } : {}),
      lastRepairAttemptAt: Date.now(),
      nextRepairAttemptAt: details.status === 'searched_no_sources' || details.status === 'failed' || details.status === 'deferred'
        ? Date.now() + RETRY_DELAY_MS
        : undefined,
      knowledgeSpaceId: spaceId,
    },
  });
  if (details.status === 'repaired') {
    for (const issue of store.listIssues(10_000).filter((entry) => entry.nodeId === gap.id && entry.status === 'open')) {
      await resolveIssue(store, issue, spaceId, details.reason ?? 'Gap was repaired with accepted source-backed evidence.');
    }
  }
}

async function linkRepairSources(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  query: string,
): Promise<number> {
  let linked = 0;
  const linkedObjectIds = repairSubjectIdsForGap(store, spaceId, gap);
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

function repairSubjectIdsForGap(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord): string[] {
  const edges = store.listEdges();
  const nodesById = new Map(store.listNodes(10_000)
    .filter((node) => getKnowledgeSpaceId(node) === spaceId)
    .map((node) => [node.id, node]));
  const sourceIds = uniqueStrings([
    gap.sourceId,
    ...readStringArray(gap.metadata.sourceIds),
    ...edges
      .filter((edge) => edge.toKind === 'node' && edge.toId === gap.id && edge.fromKind === 'source')
      .map((edge) => edge.fromId),
  ]);
  return repairSubjectIds({
    text: `${gap.title} ${gap.summary ?? ''}`,
    nodes: [
      ...readStringArray(gap.metadata.linkedObjectIds).map((nodeId) => nodesById.get(nodeId)),
      ...edges
        .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
        .map((edge) => nodesById.get(edge.fromId)),
      ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ],
  });
}

function isBudgetError(message: string): boolean {
  return /\b(timeout|timed out|budget|deadline|exceeded)\b/i.test(message);
}

async function resolveIssue(store: KnowledgeStore, issue: KnowledgeIssueRecord, spaceId: string, reason: string): Promise<void> {
  await store.upsertIssue({
    id: issue.id,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    status: 'resolved',
    sourceId: issue.sourceId,
    nodeId: issue.nodeId,
    metadata: semanticMetadata(spaceId, {
      ...issue.metadata,
      resolution: {
        reason,
        resolvedBy: 'semantic-self-improvement',
        resolvedAt: Date.now(),
      },
    }),
  });
}

function linkedObjectsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.status !== 'stale')
    .filter((node) => node.metadata.semanticKind !== 'fact' && node.metadata.semanticKind !== 'gap' && node.kind !== 'wiki_page'));
}

function factsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

function sourcesForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>,
): KnowledgeSourceRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === objectId)
    .map((edge) => sourcesById.get(edge.fromId))
    .filter((source): source is KnowledgeSourceRecord => Boolean(source))
    .filter((source) => source.status === 'indexed' && !isGeneratedKnowledgeSource(source)));
}

function factsForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  const directlyDescribing = edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === objectId && edge.relation === 'describes')
    .map((edge) => nodesById.get(edge.fromId));
  return uniqueById(directlyDescribing
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

function shouldCreateIntrinsicFeatureGap(
  subject: KnowledgeNodeRecord,
  facts: readonly KnowledgeNodeRecord[],
  source?: KnowledgeSourceRecord,
): boolean {
  if (!isConcreteRepairSubject(subject)) return false;
  if (!hasSpecificIdentity(subject, source)) return false;
  const coverage = factCoverage(facts);
  return coverage.coreFactCount < 4 || coverage.coveredAreas.size < 3;
}

function isConcreteRepairSubject(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (typeof node.metadata.semanticKind === 'string') return false;
  if (['ha_device', 'ha_integration', 'service', 'provider', 'capability'].includes(node.kind)) return true;
  if (node.kind !== 'knowledge_entity') return false;
  const entityKind = readString(node.metadata.entityKind)?.toLowerCase() ?? '';
  return /\b(device|product|service|appliance|controller|platform|provider|tool)\b/.test(entityKind);
}

function hasSpecificIdentity(subject: KnowledgeNodeRecord, source?: KnowledgeSourceRecord): boolean {
  if (readString(subject.metadata.model)) return true;
  if (readString(subject.metadata.manufacturer) && readString(subject.metadata.model)) return true;
  const text = `${subject.title} ${subject.aliases.join(' ')} ${source?.title ?? ''}`;
  return /\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/.test(text);
}

function factCoverage(facts: readonly KnowledgeNodeRecord[]): { readonly coreFactCount: number; readonly coveredAreas: Set<string> } {
  const coveredAreas = new Set<string>();
  let coreFactCount = 0;
  for (const fact of facts) {
    const kind = readString(fact.metadata.factKind);
    if (!['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(kind ?? '')) continue;
    coreFactCount += 1;
    const text = `${fact.title} ${fact.summary ?? ''} ${fact.aliases.join(' ')} ${JSON.stringify(fact.metadata)}`.toLowerCase();
    for (const [area, pattern] of [
      ['display', /\b(display|screen|resolution|hdr|dolby vision|refresh|panel)\b/],
      ['ports', /\b(hdmi|usb|ethernet|port|input|output|earc|arc)\b/],
      ['audio', /\b(audio|speaker|dolby|pcm|sound)\b/],
      ['network', /\b(wi-?fi|bluetooth|ethernet|network|wireless)\b/],
      ['smart', /\b(app|webos|smart|assistant|voice|stream)\b/],
      ['control', /\b(remote|rs-?232|control|automation|api)\b/],
    ] as const) {
      if (pattern.test(text)) coveredAreas.add(area);
    }
  }
  return { coreFactCount, coveredAreas };
}

function subjectTitle(subject: KnowledgeNodeRecord): string {
  return uniqueStrings([
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
    subject.title,
  ]).join(' ');
}

function uniqueById<T extends { readonly id: string }>(items: readonly (T | undefined)[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => typeof entry === 'string' ? entry : undefined));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
