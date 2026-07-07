import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeRefinementTaskRecord } from '../types.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import {
  runHomeGraphIssueTriage,
  type HomeGraphTriageOptions,
  type HomeGraphTriageResult,
} from './triage.js';
import type { HomeGraphSpaceInput } from './types.js';

export async function listHomeGraphRefinementTasks(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number | undefined;
  readonly state?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly gapId?: string | undefined;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly tasks: readonly KnowledgeRefinementTaskRecord[] }> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  return {
    ok: true,
    spaceId,
    tasks: input.store.listRefinementTasks(input.limit ?? 100, {
      spaceId,
      state: input.state,
      subjectKind: input.subjectId ? 'node' : undefined,
      subjectId: input.subjectId,
      gapId: input.gapId,
    }),
  };
}

export async function getHomeGraphRefinementTask(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly taskId: string;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly task: KnowledgeRefinementTaskRecord | null }> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const task = input.store.getRefinementTask(input.taskId);
  return { ok: true, spaceId, task: task?.spaceId === spaceId ? task : null };
}

export async function runHomeGraphRefinement(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly gapIds?: readonly string[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
  readonly force?: boolean | undefined;
  /**
   * Run the LLM issue-triage pass over open device-quality issues. `true` uses
   * defaults; an object customizes thresholds/limits/rules. Omitted → unchanged
   * gap-refinement behavior for existing callers.
   */
  readonly triage?: HomeGraphTriageOptions | boolean | undefined;
  /** Skip the gap self-improvement pass (e.g. a triage-only run). */
  readonly skipGapRefinement?: boolean | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly spaceId: string;
  readonly error?: string | undefined;
  readonly result?: Awaited<ReturnType<KnowledgeSemanticService['selfImprove']>> | undefined;
  readonly triage?: HomeGraphTriageResult | undefined;
}> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);

  const triageRequested = input.triage !== undefined && input.triage !== false;
  const triage = triageRequested
    ? await runHomeGraphIssueTriage({
        store: input.store,
        ...(input.semanticService ? { semanticService: input.semanticService } : {}),
        ...(input.installationId ? { installationId: input.installationId } : {}),
        ...(input.knowledgeSpaceId ? { knowledgeSpaceId: input.knowledgeSpaceId } : {}),
        options: typeof input.triage === 'object' ? input.triage : {},
      })
    : undefined;

  if (input.skipGapRefinement === true) {
    return { ok: true, spaceId, ...(triage ? { triage } : {}) };
  }

  if (!input.semanticService) {
    return { ok: false, spaceId, error: 'Semantic refinement is not configured.', ...(triage ? { triage } : {}) };
  }
  const result = await input.semanticService.selfImprove({
    knowledgeSpaceId: spaceId,
    gapIds: input.gapIds,
    sourceIds: input.sourceIds,
    limit: input.limit,
    maxRunMs: input.maxRunMs,
    force: input.force,
    reason: 'manual',
  });
  return { ok: true, spaceId, result, ...(triage ? { triage } : {}) };
}

export async function cancelHomeGraphRefinementTask(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly taskId: string;
}) {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const task = input.store.getRefinementTask(input.taskId);
  if (!task || task.spaceId !== spaceId) return { ok: false, spaceId, error: 'Unknown Home Graph refinement task.' };
  const cancelled = await input.store.upsertRefinementTask({
    id: task.id,
    spaceId: task.spaceId,
    subjectKind: task.subjectKind,
    subjectId: task.subjectId,
    subjectTitle: task.subjectTitle,
    subjectType: task.subjectType,
    gapId: task.gapId,
    issueId: task.issueId,
    state: 'cancelled',
    priority: task.priority,
    trigger: task.trigger,
    budget: task.budget,
    attemptCount: task.attemptCount,
    appendTrace: [{ at: Date.now(), state: 'cancelled', message: 'Home Graph refinement task was cancelled by request.' }],
    metadata: task.metadata,
  });
  return { ok: true, spaceId, task: cancelled };
}
