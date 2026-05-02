import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
  KnowledgeRefinementTaskTrigger,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { readString, semanticHash, semanticMetadata } from './utils.js';

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
  const subject = context.linkedObjects[0];
  const id = `kref-${semanticHash(spaceId, context.gap.id, subject?.id ?? 'unscoped')}`;
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
      policyVersion: 'knowledge-refinement-v1',
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
    appendTrace: [trace(state, message, data)],
    metadata: task.metadata,
  });
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
