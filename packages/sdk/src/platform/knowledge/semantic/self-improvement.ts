import { yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskTrigger,
  KnowledgeRefinementTaskRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { recoverNoRepairerTasks, recoverStaleActiveTasks } from './self-improvement-recovery.js';
import { sourceKnowledgeSpace, uniqueStrings } from './utils.js';
import { withTimeout } from './timeouts.js';
import { updateRefinementTask, upsertRefinementTaskForGap } from './self-improvement-tasks.js';
import { promoteRepairSources } from './self-improvement-promotion.js';
import { discoverIntrinsicGaps } from './self-improvement-intrinsic-gaps.js';
import {
  buildGapContext,
  classifyGap,
  collectCandidateGaps,
  linkRepairSources,
} from './self-improvement-gap-context.js';
import {
  SELF_IMPROVEMENT_RETRY_DELAY_MS,
  markGapRepairAttempt,
  suppressGap,
} from './self-improvement-gap-state.js';
import { BASE_OBJECT_PROFILES } from './self-improvement-graph.js';

const DEFAULT_REFINEMENT_LIMIT = 12;
const MAX_REFINEMENT_LIMIT = 24;
const DEFAULT_REFINEMENT_RUN_MS = 45_000;
const MAX_REFINEMENT_RUN_MS = 60_000;

interface SelfImproveContext {
  readonly store: KnowledgeStore;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null | undefined;
  readonly activeGapRepairs: Set<string>;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string }) => Promise<unknown>;
}

interface GapRepairOutcome {
  readonly repairableGaps: number;
  readonly skippedGaps: number;
  readonly blockedGaps: number;
  readonly closedGaps: number;
  readonly queuedTasks: number;
  readonly searched: number;
  readonly ingestedSources: number;
  readonly linkedRepairs: number;
  readonly promotedFactCount: number;
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
  readonly errors: readonly { gapId: string; error: string }[];
  readonly nextRepairAttemptAt?: number | undefined;
}
type GapRepairerResult = Awaited<ReturnType<KnowledgeSemanticGapRepairer>>;

interface AbortBudget {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface SelfImproveRunPlan {
  readonly candidates: readonly KnowledgeNodeRecord[];
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly requestedLimit: number;
  readonly cappedLimit: number;
  readonly effectiveLimit: number;
  readonly maxRunMs: number;
  readonly startedAt: number;
  readonly trigger: KnowledgeRefinementTaskTrigger;
}

interface SelfImproveRunState {
  truncated: boolean;
  budgetExhausted: boolean;
  processedGaps: number;
  repairableGaps: number;
  suppressedGaps: number;
  skippedGaps: number;
  blockedGaps: number;
  closedGaps: number;
  queuedTasks: number;
  searched: number;
  ingestedSources: number;
  linkedRepairs: number;
  promotedFactCount: number;
  nextRepairAttemptAt?: number | undefined;
  readonly taskIds: string[];
  readonly ingestedSourceIds: string[];
  readonly acceptedSourceIds: string[];
  readonly errors: { gapId: string; error: string }[];
}

export async function runKnowledgeSemanticSelfImprovement(
  context: SelfImproveContext,
  input: KnowledgeSemanticSelfImproveInput = {},
): Promise<KnowledgeSemanticSelfImproveResult> {
  await context.store.init();
  const sourceIdFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
  const gapIdFilter = input.gapIds?.length ? new Set(input.gapIds) : null;
  const spaceId = resolveSelfImproveSpace(context.store, input);
  const objectProfiles = [...BASE_OBJECT_PROFILES, ...(input.objectProfiles ?? context.objectProfiles ?? [])];
  await recoverStaleActiveTasks(context.store, spaceId);
  if (context.gapRepairer) {
    await recoverNoRepairerTasks(context.store, spaceId);
  }
  const createdGaps = gapIdFilter ? 0 : await discoverIntrinsicGaps(context.store, spaceId, sourceIdFilter, objectProfiles);
  const candidates = collectCandidateGaps(context.store, spaceId, sourceIdFilter, gapIdFilter);
  const plan = createSelfImproveRunPlan(candidates, input);
  const state = createSelfImproveRunState(plan);

  for (const gap of plan.gaps) {
    if (input.signal?.aborted) {
      markRunBudgetExhausted(state);
      break;
    }
    if (Date.now() - plan.startedAt >= plan.maxRunMs) {
      markRunBudgetExhausted(state);
      break;
    }
    state.processedGaps += 1;
    const gapContext = buildGapContext(context.store, spaceId, gap, objectProfiles);
    const task = await upsertRefinementTaskForGap(context.store, spaceId, gapContext, plan.trigger, 'detected', 'Gap was detected for semantic refinement.');
    state.taskIds.push(task.id);
    const classification = classifyGap(gapContext, input.force === true, objectProfiles);
    if (classification.action === 'suppress') {
      await suppressGap(context.store, gap, classification.reason, spaceId);
      await updateRefinementTask(context.store, task, 'suppressed', classification.reason ?? 'Gap was classified as not applicable.');
      state.suppressedGaps += 1;
      continue;
    }
    if (classification.action === 'skip') {
      if (classification.status === 'repaired' || classification.status === 'already_repaired') {
        state.closedGaps += 1;
        await updateRefinementTask(context.store, task, 'closed', classification.reason ?? 'Gap is already repaired.');
        continue;
      }
      if (classification.status === 'active') {
        state.skippedGaps += 1;
        await updateRefinementTask(context.store, task, 'queued', classification.reason ?? 'Gap repair is already active.');
        continue;
      }
      state.blockedGaps += 1;
      if (classification.markAttempt) {
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: classification.status ?? 'skipped',
          reason: classification.reason,
        });
      }
      await updateRefinementTask(context.store, task, 'blocked', classification.reason ?? 'Gap is not currently repairable.');
      continue;
    }
    if (input.deferRepair === true && context.gapRepairer) {
      state.queuedTasks += 1;
      await updateRefinementTask(context.store, task, 'queued', 'Gap repair was queued for background refinement.', {
        deferred: true,
      });
      continue;
    }
    if (!context.gapRepairer) {
      await markNoRepairer(context.store, spaceId, gap, task);
      state.blockedGaps += 1;
      continue;
    }
    const repair = await repairCandidateGap({
      context,
      input,
      spaceId,
      objectProfiles,
      gap,
      gapContext,
      task,
      startedAt: plan.startedAt,
      maxRunMs: plan.maxRunMs,
    });
    applyRepairOutcome(state, repair);
    await yieldToEventLoop();
  }

  return buildSelfImproveResult(plan, state, createdGaps);
}

function createSelfImproveRunPlan(
  candidates: readonly KnowledgeNodeRecord[],
  input: KnowledgeSemanticSelfImproveInput,
): SelfImproveRunPlan {
  const requestedLimit = Math.max(1, input.limit ?? DEFAULT_REFINEMENT_LIMIT);
  const cappedLimit = Math.min(requestedLimit, MAX_REFINEMENT_LIMIT);
  const gaps = candidates.slice(0, cappedLimit);
  return {
    candidates,
    gaps,
    requestedLimit,
    cappedLimit,
    effectiveLimit: gaps.length,
    maxRunMs: Math.min(
      MAX_REFINEMENT_RUN_MS,
      Math.max(5_000, input.maxRunMs ?? DEFAULT_REFINEMENT_RUN_MS),
    ),
    startedAt: Date.now(),
    trigger: input.reason ?? 'manual',
  };
}

function createSelfImproveRunState(plan: SelfImproveRunPlan): SelfImproveRunState {
  return {
    truncated: plan.candidates.length > plan.gaps.length || plan.requestedLimit > plan.cappedLimit,
    budgetExhausted: false,
    processedGaps: 0,
    repairableGaps: 0,
    suppressedGaps: 0,
    skippedGaps: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    promotedFactCount: 0,
    taskIds: [],
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    errors: [],
  };
}

function markRunBudgetExhausted(state: SelfImproveRunState): void {
  state.truncated = true;
  state.budgetExhausted = true;
}

function applyRepairOutcome(state: SelfImproveRunState, repair: GapRepairOutcome): void {
  state.repairableGaps += repair.repairableGaps;
  state.skippedGaps += repair.skippedGaps;
  state.blockedGaps += repair.blockedGaps;
  state.closedGaps += repair.closedGaps;
  state.queuedTasks += repair.queuedTasks;
  state.searched += repair.searched;
  state.ingestedSources += repair.ingestedSources;
  state.linkedRepairs += repair.linkedRepairs;
  state.promotedFactCount += repair.promotedFactCount;
  state.ingestedSourceIds.push(...repair.ingestedSourceIds);
  state.acceptedSourceIds.push(...repair.acceptedSourceIds);
  state.errors.push(...repair.errors);
  state.nextRepairAttemptAt = repair.nextRepairAttemptAt ?? state.nextRepairAttemptAt;
}

async function markNoRepairer(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  task: KnowledgeRefinementTaskRecord,
): Promise<void> {
  await markGapRepairAttempt(store, gap, spaceId, {
    status: 'no_repairer',
    reason: 'No semantic gap repairer is configured.',
  });
  await updateRefinementTask(store, task, 'blocked', 'No semantic gap repairer is configured.');
}

function buildSelfImproveResult(
  plan: SelfImproveRunPlan,
  state: SelfImproveRunState,
  createdGaps: number,
): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: plan.gaps.length,
    candidateGaps: plan.candidates.length,
    processedGaps: state.processedGaps,
    createdGaps,
    repairableGaps: state.repairableGaps,
    suppressedGaps: state.suppressedGaps,
    skippedGaps: state.skippedGaps,
    searched: state.searched,
    ingestedSources: state.ingestedSources,
    linkedRepairs: state.linkedRepairs,
    blockedGaps: state.blockedGaps,
    closedGaps: state.closedGaps,
    queuedTasks: state.queuedTasks,
    requestedLimit: plan.requestedLimit,
    effectiveLimit: plan.effectiveLimit,
    truncated: state.truncated,
    budgetExhausted: state.budgetExhausted,
    taskIds: uniqueStrings(state.taskIds),
    ingestedSourceIds: uniqueStrings(state.ingestedSourceIds),
    acceptedSourceIds: uniqueStrings(state.acceptedSourceIds),
    promotedFactCount: state.promotedFactCount,
    ...(state.nextRepairAttemptAt ? { nextRepairAttemptAt: state.nextRepairAttemptAt } : {}),
    errors: state.errors,
  };
}

async function repairCandidateGap(options: {
  readonly context: SelfImproveContext;
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: ReturnType<typeof buildGapContext>;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly startedAt: number;
  readonly maxRunMs: number;
}): Promise<GapRepairOutcome> {
  const { context, spaceId, gap } = options;
  const repairKey = `${spaceId}:${gap.id}`;
  if (context.activeGapRepairs.has(repairKey)) {
    await updateRefinementTask(context.store, options.task, 'queued', 'Gap repair is already active.');
    return emptyRepairOutcome({ skippedGaps: 1 });
  }
  context.activeGapRepairs.add(repairKey);
  try {
    return await executeGapRepair({
      ...options,
      gapRepairer: context.gapRepairer!,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const nextRepairAttemptAt = isBudgetError(reason)
      ? Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS
      : undefined;
    if (nextRepairAttemptAt) {
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: 'deferred',
        reason,
        nextRepairAttemptAt,
      });
      await updateRefinementTask(context.store, options.task, 'blocked', 'Repair was deferred after exhausting the current run budget.', {
        retryable: true,
        nextRepairAttemptAt,
        error: reason,
      });
      return emptyRepairOutcome({
        repairableGaps: 1,
        queuedTasks: 1,
        blockedGaps: 1,
        nextRepairAttemptAt,
        errors: [{ gapId: gap.id, error: reason }],
      });
    }
    await updateRefinementTask(context.store, options.task, 'failed', reason);
    await markGapRepairAttempt(context.store, gap, spaceId, {
      status: 'failed',
      reason,
    });
    return emptyRepairOutcome({
      repairableGaps: 1,
      queuedTasks: 1,
      errors: [{ gapId: gap.id, error: reason }],
    });
  } finally {
    context.activeGapRepairs.delete(repairKey);
  }
}

async function executeGapRepair(options: {
  readonly context: SelfImproveContext;
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: ReturnType<typeof buildGapContext>;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly startedAt: number;
  readonly maxRunMs: number;
  readonly gapRepairer: KnowledgeSemanticGapRepairer;
}): Promise<GapRepairOutcome> {
  const { context, input, spaceId, objectProfiles, gap, gapContext, startedAt, maxRunMs, gapRepairer } = options;
  let task = await updateRefinementTask(context.store, options.task, 'searching', 'Searching for source-backed repair evidence.', { query: gap.title });
  const remainingMs = Math.max(1_000, startedAt + maxRunMs - Date.now());
  const result = await runGapRepairerWithBudget({
    input,
    spaceId,
    gap,
    gapContext,
    gapRepairer,
    remainingMs,
  });
  const assessment = await recordGapRepairAssessment(context.store, task, gap, result);
  task = assessment.task;
  if (assessment.acceptedSourceIds.length) {
    task = await updateRefinementTask(context.store, task, 'applying', 'Linking accepted repair sources into the graph.');
  }
  return applyGapRepairEvidence({
    context,
    objectProfiles,
    spaceId,
    gap,
    task,
    result,
    acceptedSourceIds: assessment.acceptedSourceIds,
    ingestedSourceIds: assessment.ingestedSourceIds,
    deadlineAt: startedAt + maxRunMs,
  });
}

async function runGapRepairerWithBudget(input: {
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: ReturnType<typeof buildGapContext>;
  readonly gapRepairer: KnowledgeSemanticGapRepairer;
  readonly remainingMs: number;
}): Promise<GapRepairerResult> {
  const { input: runInput, spaceId, gap, gapContext, gapRepairer, remainingMs } = input;
  const budget = createAbortBudget(runInput.signal, remainingMs);
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
      signal: budget.signal,
    }), remainingMs, 'Semantic gap repair exceeded its run budget.');
  } finally {
    budget.dispose();
  }
}

function createAbortBudget(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortBudget {
  const controller = new AbortController();
  const abortRepair = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', abortRepair, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortRepair);
      controller.abort();
    },
  };
}

async function recordGapRepairAssessment(
  store: KnowledgeStore,
  task: KnowledgeRefinementTaskRecord,
  gap: KnowledgeNodeRecord,
  result: GapRepairerResult,
): Promise<{
  readonly task: KnowledgeRefinementTaskRecord;
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
}> {
  const ingestedSourceIds = result?.ingestedSourceIds ?? [];
  const acceptedSourceIds = uniqueStrings([...(result?.acceptedSourceIds ?? []), ...ingestedSourceIds]);
  const updatedTask = await updateRefinementTask(store, task, 'evaluating', result?.reason ?? 'Source discovery completed.', {
    query: result?.query ?? gap.title,
    sourceAssessments: result?.sourceAssessments ?? [],
    ingestedSourceIds,
    acceptedSourceIds,
    skippedUrls: result?.skippedUrls ?? [],
  });
  return { task: updatedTask, ingestedSourceIds, acceptedSourceIds };
}

async function applyGapRepairEvidence(input: {
  readonly context: SelfImproveContext;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly result: GapRepairerResult;
  readonly acceptedSourceIds: readonly string[];
  readonly ingestedSourceIds: readonly string[];
  readonly deadlineAt: number;
}): Promise<GapRepairOutcome> {
  const { context, objectProfiles, spaceId, gap, task, result, acceptedSourceIds, ingestedSourceIds, deadlineAt } = input;
  const linkedRepairs = await linkRepairSources(context.store, spaceId, gap, acceptedSourceIds, result?.query ?? gap.title, objectProfiles);
  let promotedFactCount = 0;
  let repairComplete = false;
  if (acceptedSourceIds.length > 0) {
    const promotion = await promoteRepairSources({ ...context, objectProfiles }, spaceId, gap, acceptedSourceIds, task, deadlineAt);
    promotedFactCount = promotion.promotedFactCount;
    repairComplete = promotion.repairComplete;
  }

  const evidenceSufficient = result?.evidenceSufficient !== false && acceptedSourceIds.length > 0 && repairComplete;
  await markGapRepairAttempt(context.store, gap, spaceId, {
    status: evidenceSufficient ? 'repaired' : acceptedSourceIds.length ? 'deferred' : 'searched_no_sources',
    reason: result?.reason,
    query: result?.query,
    acceptedSourceIds,
    promotedFactCount,
  });

  if (evidenceSufficient) {
    await updateRefinementTask(context.store, task, 'closed', 'Repair sources were accepted and linked to the gap.', {
      acceptedSourceIds,
      ingestedSourceIds,
      promotedFactCount,
    });
    return emptyRepairOutcome({
      repairableGaps: 1,
      queuedTasks: 1,
      searched: result?.searched ? 1 : 0,
      ingestedSources: ingestedSourceIds.length,
      linkedRepairs,
      promotedFactCount,
      ingestedSourceIds,
      acceptedSourceIds,
      closedGaps: 1,
    });
  }

  if (acceptedSourceIds.length > 0) {
    const nextRepairAttemptAt = Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS;
    await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'Accepted source evidence was linked, but the gap still needs corroboration.', {
      acceptedSourceIds,
      promotedFactCount,
      retryable: true,
      nextRepairAttemptAt,
    });
    return emptyRepairOutcome({
      repairableGaps: 1,
      queuedTasks: 1,
      searched: result?.searched ? 1 : 0,
      ingestedSources: ingestedSourceIds.length,
      linkedRepairs,
      promotedFactCount,
      ingestedSourceIds,
      acceptedSourceIds,
      blockedGaps: 1,
      nextRepairAttemptAt,
    });
  }

  await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'No acceptable repair sources were found.');
  return emptyRepairOutcome({
    repairableGaps: 1,
    queuedTasks: 1,
    searched: result?.searched ? 1 : 0,
    blockedGaps: 1,
  });
}

function emptyRepairOutcome(overrides: Partial<GapRepairOutcome> = {}): GapRepairOutcome {
  return {
    repairableGaps: 0,
    skippedGaps: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    promotedFactCount: 0,
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    errors: [],
    ...overrides,
  };
}

function resolveSelfImproveSpace(store: KnowledgeStore, input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const firstSource = input.sourceIds?.map((id) => store.getSource(id)).find((source): source is KnowledgeSourceRecord => Boolean(source));
  if (firstSource) return sourceKnowledgeSpace(firstSource);
  const firstGap = input.gapIds?.map((id) => store.getNode(id)).find((node): node is KnowledgeNodeRecord => Boolean(node));
  return normalizeKnowledgeSpaceId(firstGap ? getKnowledgeSpaceId(firstGap) : undefined);
}

function isBudgetError(message: string): boolean {
  return /\b(timeout|timed out|budget|deadline|exceeded)\b/i.test(message);
}
