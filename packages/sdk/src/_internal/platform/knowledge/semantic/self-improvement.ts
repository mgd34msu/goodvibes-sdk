import { isGeneratedKnowledgeSource } from '../generated-projections.js';
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
import {
  readRecord,
  readString,
  semanticHash,
  semanticMetadata,
  semanticSlug,
  sourceKnowledgeSpace,
  uniqueStrings,
} from './utils.js';

const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

interface SelfImproveContext {
  readonly store: KnowledgeStore;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null;
  readonly activeGapRepairs: Set<string>;
}

interface GapContext {
  readonly gap: KnowledgeNodeRecord;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly facts: readonly KnowledgeNodeRecord[];
}

export async function runKnowledgeSemanticSelfImprovement(
  context: SelfImproveContext,
  input: KnowledgeSemanticSelfImproveInput = {},
): Promise<KnowledgeSemanticSelfImproveResult> {
  await context.store.init();
  const sourceIdFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
  const gapIdFilter = input.gapIds?.length ? new Set(input.gapIds) : null;
  const spaceId = resolveSelfImproveSpace(context.store, input);
  const createdGaps = await discoverIntrinsicGaps(context.store, spaceId, sourceIdFilter);
  const gaps = collectCandidateGaps(context.store, spaceId, sourceIdFilter, gapIdFilter)
    .slice(0, Math.max(1, input.limit ?? 24));
  let repairableGaps = 0;
  let suppressedGaps = 0;
  let skippedGaps = 0;
  let searched = 0;
  let ingestedSources = 0;
  let linkedRepairs = 0;
  const errors: { gapId: string; error: string }[] = [];

  for (const gap of gaps) {
    const gapContext = buildGapContext(context.store, spaceId, gap);
    const classification = classifyGap(gapContext, input.force === true);
    if (classification.action === 'suppress') {
      await suppressGap(context.store, gap, classification.reason, spaceId);
      suppressedGaps += 1;
      continue;
    }
    if (classification.action === 'skip') {
      skippedGaps += 1;
      if (classification.markAttempt) {
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: classification.status ?? 'skipped',
          reason: classification.reason,
        });
      }
      continue;
    }
    repairableGaps += 1;
    if (!context.gapRepairer) {
      skippedGaps += 1;
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: 'no_repairer',
        reason: 'No semantic gap repairer is configured.',
      });
      continue;
    }
    const repairKey = `${spaceId}:${gap.id}`;
    if (context.activeGapRepairs.has(repairKey)) {
      skippedGaps += 1;
      continue;
    }
    context.activeGapRepairs.add(repairKey);
    try {
      const result = await context.gapRepairer({
        spaceId,
        query: gap.title,
        gaps: [gap],
        sources: gapContext.sources,
        linkedObjects: gapContext.linkedObjects,
        facts: gapContext.facts,
      });
      if (result?.searched) searched += 1;
      ingestedSources += result?.ingestedSourceIds.length ?? 0;
      linkedRepairs += await linkRepairSources(context.store, spaceId, gap, result?.ingestedSourceIds ?? [], result?.query ?? gap.title);
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: result?.ingestedSourceIds.length ? 'repaired' : 'searched_no_sources',
        reason: result?.reason,
        query: result?.query,
      });
    } catch (error) {
      errors.push({ gapId: gap.id, error: error instanceof Error ? error.message : String(error) });
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      context.activeGapRepairs.delete(repairKey);
    }
  }

  return {
    scannedGaps: gaps.length,
    createdGaps,
    repairableGaps,
    suppressedGaps,
    skippedGaps,
    searched,
    ingestedSources,
    linkedRepairs,
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
  for (const source of sourcesById.values()) {
    const linkedObjects = linkedObjectsForSource(source.id, edges, nodesById);
    const facts = factsForSource(source.id, edges, nodesById);
    for (const subject of linkedObjects.filter(isConcreteRepairSubject)) {
      if (!shouldCreateIntrinsicFeatureGap(subject, facts, source)) continue;
      if (await upsertIntrinsicFeatureGap(store, spaceId, subject, [source], createdIds)) created += 1;
    }
  }
  if (!sourceIdFilter) {
    for (const subject of nodesById.values()) {
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
  const linkedObjects = uniqueById([
    ...readStringArray(gap.metadata.linkedObjectIds).map((id) => nodesById.get(id)).filter((node): node is KnowledgeNodeRecord => Boolean(node)),
    ...sourceIds.flatMap((sourceId) => linkedObjectsForSource(sourceId, edges, nodesById)),
    ...edges
      .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === gap.id)
      .map((edge) => nodesById.get(edge.fromId))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node)),
  ]);
  const sources = uniqueById([
    ...directSources,
    ...linkedObjects.flatMap((object) => sourcesForObject(object.id, edges, sourcesById)),
  ]);
  const facts = uniqueById([
    ...sources.flatMap((source) => factsForSource(source.id, edges, nodesById)),
    ...linkedObjects.flatMap((object) => factsForObject(object.id, edges, nodesById)),
  ]);
  return { gap, sources, linkedObjects, facts };
}

function classifyGap(
  context: GapContext,
  force: boolean,
): { readonly action: 'repair' | 'skip' | 'suppress'; readonly reason?: string; readonly status?: string; readonly markAttempt?: boolean } {
  const status = readString(context.gap.metadata.repairStatus);
  const nextAttemptAt = readNumber(context.gap.metadata.nextRepairAttemptAt);
  if (!force && status === 'repaired') return { action: 'skip', reason: 'Gap already has linked repair sources.' };
  if (!force && nextAttemptAt && nextAttemptAt > Date.now()) return { action: 'skip', reason: 'Gap repair retry window has not elapsed.' };
  if (hasRepairEdge(context)) return { action: 'skip', reason: 'Gap already has a repair source.' };
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
  return context.sources.some((source) => source.metadata.sourceDiscovery && readRecord(source.metadata.sourceDiscovery).purpose === 'semantic-gap-repair')
    || context.facts.some((fact) => readString(fact.metadata.repairStatus) === 'repaired');
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
      nextRepairAttemptAt: details.status === 'searched_no_sources' || details.status === 'failed'
        ? Date.now() + RETRY_DELAY_MS
        : undefined,
      knowledgeSpaceId: spaceId,
    },
  });
}

async function linkRepairSources(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  sourceIds: readonly string[],
  query: string,
): Promise<number> {
  let linked = 0;
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
  }
  return linked;
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
