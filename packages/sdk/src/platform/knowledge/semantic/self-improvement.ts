import { yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type {
  KnowledgeNodeRecord,
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
import {
  BASE_OBJECT_PROFILES,
} from './self-improvement-graph.js';

const DEFAULT_REFINEMENT_LIMIT = 12;
const MAX_REFINEMENT_LIMIT = 24;
const DEFAULT_REFINEMENT_RUN_MS = 45_000;
const MAX_REFINEMENT_RUN_MS = 60_000;

interface SelfImproveContext {
  readonly store: KnowledgeStore;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null;
  readonly activeGapRepairs: Set<string>;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[];
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string }) => Promise<unknown>;
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
    if (input.signal?.aborted) {
      truncated = true;
      budgetExhausted = true;
      break;
    }
    if (Date.now() - startedAt >= maxRunMs) {
      truncated = true;
      budgetExhausted = true;
      break;
    }
    processedGaps += 1;
    const gapContext = buildGapContext(context.store, spaceId, gap, objectProfiles);
    let task = await upsertRefinementTaskForGap(context.store, spaceId, gapContext, trigger, 'detected', 'Gap was detected for semantic refinement.');
    taskIds.push(task.id);
    const classification = classifyGap(gapContext, input.force === true, objectProfiles);
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
      const abortRepair = () => controller.abort();
      if (input.signal?.aborted) {
        controller.abort();
      } else {
        input.signal?.addEventListener('abort', abortRepair, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), remainingMs);
      timer.unref?.();
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
          input.signal?.removeEventListener('abort', abortRepair);
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
      linkedRepairs += await linkRepairSources(context.store, spaceId, gap, gapAcceptedSourceIds, result?.query ?? gap.title, objectProfiles);
      let gapRepairComplete = false;
      if (gapAcceptedSourceIds.length > 0) {
        const promotion = await promoteRepairSources({ ...context, objectProfiles }, spaceId, gap, gapAcceptedSourceIds, task, startedAt + maxRunMs);
        gapPromotedFactCount = promotion.promotedFactCount;
        gapRepairComplete = promotion.repairComplete;
        promotedFactCount += gapPromotedFactCount;
      }
      const evidenceSufficient = result?.evidenceSufficient !== false && gapAcceptedSourceIds.length > 0 && gapRepairComplete;
      await markGapRepairAttempt(context.store, gap, spaceId, {
        status: evidenceSufficient ? 'repaired' : gapAcceptedSourceIds.length ? 'deferred' : 'searched_no_sources',
        reason: result?.reason,
        query: result?.query,
        acceptedSourceIds: gapAcceptedSourceIds,
        promotedFactCount: gapPromotedFactCount,
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
        nextRepairAttemptAt = Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS;
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
      if (budgetError) {
        blockedGaps += 1;
        nextRepairAttemptAt = Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS;
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: 'deferred',
          reason,
          nextRepairAttemptAt,
        });
        await updateRefinementTask(context.store, task, 'blocked', 'Repair was deferred after exhausting the current run budget.', {
          retryable: true,
          nextRepairAttemptAt,
          error: reason,
        });
      } else {
        await updateRefinementTask(context.store, task, 'failed', reason);
        await markGapRepairAttempt(context.store, gap, spaceId, {
          status: 'failed',
          reason,
        });
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

function isBudgetError(message: string): boolean {
  return /\b(timeout|timed out|budget|deadline|exceeded)\b/i.test(message);
}
