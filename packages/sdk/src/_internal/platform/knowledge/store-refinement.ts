import type { SQLiteStore } from '../state/sqlite-store.js';
import { nowMs, stableText } from './store-schema.js';
import type {
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskUpsertInput,
} from './types.js';

export async function upsertKnowledgeRefinementTask(
  sqlite: SQLiteStore,
  refinementTasks: Map<string, KnowledgeRefinementTaskRecord>,
  input: KnowledgeRefinementTaskUpsertInput,
  createId: () => string,
): Promise<KnowledgeRefinementTaskRecord> {
  const existing = input.id ? refinementTasks.get(input.id) : null;
  const now = nowMs();
  const _subjectKind = stableText(input.subjectKind);
  const _subjectId = stableText(input.subjectId);
  const _subjectTitle = stableText(input.subjectTitle);
  const _subjectType = stableText(input.subjectType);
  const _gapId = stableText(input.gapId);
  const _issueId = stableText(input.issueId);
  const _blockedReason = stableText(input.blockedReason);
  const nextRepairAttemptAt = readNumber(input.nextRepairAttemptAt)
    ?? readNumber(input.metadata?.nextRepairAttemptAt)
    ?? existing?.nextRepairAttemptAt;
  const inputAcceptedSourceIds = input.acceptedSourceIds ?? [];
  const inputIngestedSourceIds = input.ingestedSourceIds ?? [];
  const inputRejectedSourceUrls = input.rejectedSourceUrls ?? [];
  const inputSourceAssessments = input.sourceAssessments ?? [];
  const metadata = {
    ...(existing?.metadata ?? {}),
    ...(input.metadata ?? {}),
    ...(inputAcceptedSourceIds.length > 0 ? { acceptedSourceIds: [...inputAcceptedSourceIds] } : {}),
    ...(inputIngestedSourceIds.length > 0 ? { ingestedSourceIds: [...inputIngestedSourceIds] } : {}),
    ...(inputRejectedSourceUrls.length > 0 ? { rejectedSourceUrls: [...inputRejectedSourceUrls] } : {}),
    ...(typeof input.promotedFactCount === 'number' ? { promotedFactCount: input.promotedFactCount } : {}),
    ...(inputSourceAssessments.length > 0 ? { sourceAssessments: [...inputSourceAssessments] } : {}),
    ...(typeof nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt } : {}),
  };
  const replacementTrace = input.trace ? [...input.trace] : existing?.trace ?? [];
  const trace = [...replacementTrace, ...(input.appendTrace ?? [])].slice(-80);
  const record: KnowledgeRefinementTaskRecord = {
    id: existing?.id ?? input.id ?? createId(),
    spaceId: input.spaceId,
    ...(_subjectKind !== null ? { subjectKind: _subjectKind as KnowledgeRefinementTaskRecord['subjectKind'] } : existing?.subjectKind ? { subjectKind: existing.subjectKind } : {}),
    ...(_subjectId !== null ? { subjectId: _subjectId } : existing?.subjectId ? { subjectId: existing.subjectId } : {}),
    ...(_subjectTitle !== null ? { subjectTitle: _subjectTitle } : existing?.subjectTitle ? { subjectTitle: existing.subjectTitle } : {}),
    ...(_subjectType !== null ? { subjectType: _subjectType } : existing?.subjectType ? { subjectType: existing.subjectType } : {}),
    ...(_gapId !== null ? { gapId: _gapId } : existing?.gapId ? { gapId: existing.gapId } : {}),
    ...(_issueId !== null ? { issueId: _issueId } : existing?.issueId ? { issueId: existing.issueId } : {}),
    state: input.state,
    priority: input.priority ?? existing?.priority ?? 'normal',
    trigger: input.trigger,
    budget: {
      ...(existing?.budget ?? {}),
      ...(input.budget ?? {}),
    },
    attemptCount: Math.max(0, Math.trunc(input.attemptCount ?? existing?.attemptCount ?? 0)),
    ...(_blockedReason !== null ? { blockedReason: _blockedReason } : existing?.blockedReason && input.state === existing.state ? { blockedReason: existing.blockedReason } : {}),
    ...(typeof nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt } : {}),
    ...taskSourceFields(metadata),
    trace,
    metadata,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_refinement_tasks (
      id, space_id, subject_kind, subject_id, subject_title, subject_type, gap_id,
      issue_id, state, priority, trigger, budget, attempt_count, blocked_reason,
      trace, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.spaceId,
    record.subjectKind ?? null,
    record.subjectId ?? null,
    record.subjectTitle ?? null,
    record.subjectType ?? null,
    record.gapId ?? null,
    record.issueId ?? null,
    record.state,
    record.priority,
    record.trigger,
    JSON.stringify(record.budget),
    record.attemptCount,
    record.blockedReason ?? null,
    JSON.stringify(record.trace),
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
  refinementTasks.set(record.id, record);
  await sqlite.save();
  return record;
}

function taskSourceFields(metadata: Record<string, unknown>): Pick<KnowledgeRefinementTaskRecord, 'acceptedSourceIds' | 'ingestedSourceIds' | 'rejectedSourceUrls' | 'promotedFactCount' | 'sourceAssessments'> {
  const acceptedSourceIds = readStringArray(metadata.acceptedSourceIds);
  const ingestedSourceIds = readStringArray(metadata.ingestedSourceIds);
  const rejectedSourceUrls = readStringArray(metadata.rejectedSourceUrls);
  const promotedFactCount = readNumber(metadata.promotedFactCount);
  const sourceAssessments = readSourceAssessments(metadata.sourceAssessments);
  return {
    ...(acceptedSourceIds.length > 0 ? { acceptedSourceIds } : {}),
    ...(ingestedSourceIds.length > 0 ? { ingestedSourceIds } : {}),
    ...(rejectedSourceUrls.length > 0 ? { rejectedSourceUrls } : {}),
    ...(typeof promotedFactCount === 'number' ? { promotedFactCount } : {}),
    ...(sourceAssessments.length > 0 ? { sourceAssessments } : {}),
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
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
