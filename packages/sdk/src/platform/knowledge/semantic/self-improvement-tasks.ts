import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
  KnowledgeRefinementTaskTrigger,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { readString, readStringArray, semanticHash, semanticMetadata, uniqueStrings } from './utils.js';

export interface RefinementTaskGapContext {
  readonly gap: KnowledgeNodeRecord;
  readonly sources: readonly { readonly id: string }[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
}

export async function upsertRefinementTaskForGap(
  store: KnowledgeStore,
  spaceId: string,
  context: RefinementTaskGapContext,
  trigger: KnowledgeRefinementTaskTrigger,
  state: KnowledgeRefinementTaskState,
  message: string,
  data: Record<string, unknown> = {},
): Promise<KnowledgeRefinementTaskRecord> {
  const subject = context.linkedObjects[0]!;
  const id = `kref-${semanticHash(spaceId, context.gap.id)}`;
  const existing = store.getRefinementTask(id);
  const attemptCount = existing?.attemptCount ?? 0;
  return store.upsertRefinementTask({
    id,
    spaceId,
    ...(subject ? {
      subjectKind: 'node',
      subjectId: subject.id,
      subjectTitle: subjectTitle(subject),
      subjectType: subject.kind,
    } : {}),
    gapId: context.gap.id,
    state,
    trigger,
    priority: refinementPriority(context.gap),
    budget: {
      maxSearches: 5,
      maxSources: 5,
      maxLlmCalls: 1,
    },
    attemptCount,
    appendTrace: [trace(state, message, data)],
    metadata: semanticMetadata(spaceId, {
      gapTitle: context.gap.title,
      gapKind: readString(context.gap.metadata.gapKind) ?? 'unknown',
      sourceIds: context.sources.map((source) => source.id),
      linkedObjectIds: context.linkedObjects.map((node) => node.id),
      policyVersion: 'knowledge-refinement-v2',
    }),
  });
}

export async function updateRefinementTask(
  store: KnowledgeStore,
  task: KnowledgeRefinementTaskRecord,
  state: KnowledgeRefinementTaskState,
  message: string,
  data: Record<string, unknown> = {},
): Promise<KnowledgeRefinementTaskRecord> {
  const nextRepairAttemptAt = readNumber(data.nextRepairAttemptAt) ?? task.nextRepairAttemptAt;
  const metadata = refinementTaskMetadata(task, data, nextRepairAttemptAt);
  return store.upsertRefinementTask({
    id: task.id,
    spaceId: task.spaceId,
    subjectKind: task.subjectKind,
    subjectId: task.subjectId,
    subjectTitle: task.subjectTitle,
    subjectType: task.subjectType,
    gapId: task.gapId,
    issueId: task.issueId,
    state,
    priority: task.priority,
    trigger: task.trigger,
    budget: task.budget,
    attemptCount: state === 'searching' ? task.attemptCount + 1 : task.attemptCount,
    ...(state === 'blocked' || state === 'failed' ? { blockedReason: message } : {}),
    ...(typeof nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt } : {}),
    acceptedSourceIds: readStringArray(metadata.acceptedSourceIds),
    ingestedSourceIds: readStringArray(metadata.ingestedSourceIds),
    rejectedSourceUrls: readStringArray(metadata.rejectedSourceUrls),
    ...(typeof readNumber(metadata.promotedFactCount) === 'number' ? { promotedFactCount: readNumber(metadata.promotedFactCount) } : {}),
    sourceAssessments: readSourceAssessments(metadata.sourceAssessments),
    appendTrace: [trace(state, message, data)],
    metadata,
  });
}

function refinementTaskMetadata(
  task: KnowledgeRefinementTaskRecord,
  data: Record<string, unknown>,
  nextRepairAttemptAt: number | undefined,
): Record<string, unknown> {
  const sourceAssessments = readSourceAssessments(data.sourceAssessments);
  const acceptedSourceIds = uniqueStrings([
    ...readStringArray(task.metadata.acceptedSourceIds),
    ...readStringArray(data.acceptedSourceIds),
  ]);
  const ingestedSourceIds = uniqueStrings([
    ...readStringArray(task.metadata.ingestedSourceIds),
    ...readStringArray(data.ingestedSourceIds),
  ]);
  const rejectedSourceUrls = uniqueStrings([
    ...readStringArray(task.metadata.rejectedSourceUrls),
    ...readStringArray(task.metadata.skippedUrls),
    ...readStringArray(data.rejectedSourceUrls),
    ...readStringArray(data.skippedUrls),
  ]);
  return {
    ...task.metadata,
    ...('query' in data ? { lastQuery: data.query } : {}),
    ...(acceptedSourceIds.length > 0 ? { acceptedSourceIds } : {}),
    ...(ingestedSourceIds.length > 0 ? { ingestedSourceIds } : {}),
    ...(rejectedSourceUrls.length > 0 ? { rejectedSourceUrls, skippedUrls: rejectedSourceUrls } : {}),
    ...(typeof readNumber(data.promotedFactCount) === 'number' ? { promotedFactCount: readNumber(data.promotedFactCount) } : {}),
    ...(typeof readNumber(data.targetPromotedFactCount) === 'number' ? { targetPromotedFactCount: readNumber(data.targetPromotedFactCount) } : {}),
    ...(sourceAssessments.length > 0 ? { sourceAssessments } : {}),
    ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
    ...(typeof data.deferred === 'boolean' ? { deferred: data.deferred } : {}),
    ...(typeof nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt } : {}),
  };
}

function trace(
  state: KnowledgeRefinementTaskState,
  message: string,
  data: Record<string, unknown> = {},
): KnowledgeRefinementTaskRecord['trace'][number] {
  return {
    at: Date.now(),
    state,
    message,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

function refinementPriority(gap: KnowledgeNodeRecord): KnowledgeRefinementTaskRecord['priority'] {
  const severity = readString(gap.metadata.severity);
  const kind = readString(gap.metadata.gapKind);
  if (severity === 'error') return 'urgent';
  if (severity === 'warning' || kind === 'intrinsic_features') return 'high';
  return 'normal';
}

function subjectTitle(subject: KnowledgeNodeRecord): string {
  return [
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
    subject.title,
  ].filter(Boolean).join(' ');
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readSourceAssessments(value: unknown): NonNullable<KnowledgeRefinementTaskRecord['sourceAssessments']> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is NonNullable<KnowledgeRefinementTaskRecord['sourceAssessments']>[number] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.url === 'string'
      && typeof record.accepted === 'boolean'
      && typeof record.confidence === 'number'
      && Array.isArray(record.reasons);
  });
}
