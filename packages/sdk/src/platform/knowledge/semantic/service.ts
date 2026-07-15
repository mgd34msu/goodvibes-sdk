import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground, sleep, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { answerKnowledgeQuery } from './answer.js';
import { enrichKnowledgeSource } from './enrichment.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerRefinement,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticEnrichmentResult,
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticLlm,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { readRecord, readString, readStringArray, sourceSemanticHash, sourceSemanticText } from './utils.js';
import { uniqueStrings } from './utils.js';
import { runKnowledgeSemanticSelfImprovement } from './self-improvement.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';

export interface KnowledgeSemanticServiceOptions {
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
  readonly maxLlmSourcesPerReindex?: number | undefined;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null | undefined;
  readonly maxReindexRunMs?: number | undefined;
  readonly backgroundRepairDelayMs?: number | undefined;
  readonly backgroundRepairLimit?: number | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  /**
   * Minimum floor (ms) enforced on EVERY background self-improvement schedule.
   * A background run can never be scheduled sooner than this even when a caller
   * asks for `delayMs=0` — that bare-zero path is what turned an enrichment
   * burst into a CPU-bound hot loop. Default 5000.
   */
  readonly backgroundSelfImproveMinDelayMs?: number | undefined;
  /**
   * After a background run finds ZERO candidate gaps, further self-scheduled
   * runs for that scope are suppressed for this window (ms) — the work backs off
   * to the hourly reindex schedule instead of self-perpetuating. Default
   * 3_600_000 (one hour, matching the reindex cadence).
   */
  readonly backgroundSelfImproveZeroGapBackoffMs?: number | undefined;
  /**
   * Backpressure gate the MemoryGovernor drives: when it returns true the
   * background self-improvement job is paused and new runs are not scheduled
   * (the foreground path is untouched). Wired from the daemon composition.
   */
  readonly isBackgroundPaused?: (() => boolean) | undefined;
}

/** Default floor for background self-improvement scheduling (ms). */
const DEFAULT_SELF_IMPROVE_MIN_DELAY_MS = 5_000;
/** Default zero-gap backoff window; matches the hourly reindex cadence (ms). */
const DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS = 3_600_000;
/** Page size for bounded distinct-space discovery over the full store. */
const SELF_IMPROVE_SPACE_PAGE_SIZE = 500;

/** Per-scope background scheduling state: coalescing flag + zero-gap backoff deadline. */
interface BackgroundRunState {
  pending: boolean;
  zeroGapUntil: number;
}

export class KnowledgeSemanticService {
  private readonly activeGapRepairs = new Set<string>();
  private readonly activeSelfImprovementRuns = new Map<string, Promise<KnowledgeSemanticSelfImproveResult>>();
  /** Per-scope background-scheduling state that debounces bursts and enforces zero-gap backoff. */
  private readonly backgroundRunState = new Map<string, BackgroundRunState>();

  constructor(
    private readonly store: KnowledgeStore,
    private options: KnowledgeSemanticServiceOptions = {},
  ) {}

  /**
   * The configured semantic LLM, or null when unconfigured. Home Graph issue
   * triage prompts through this the same way `enrichment.ts`/`answer-llm.ts` do
   * inside this service; exposing it lets the Home Graph refinement loop share the
   * one model route without re-plumbing a provider registry.
   */
  get llm(): KnowledgeSemanticLlm | null {
    return this.options.llm ?? null;
  }

  setGapRepairer(gapRepairer: KnowledgeSemanticGapRepairer | null | undefined): void {
    this.options = {
      ...this.options,
      gapRepairer: gapRepairer ?? null,
    };
  }

  addObjectProfiles(profiles: readonly KnowledgeObjectProfilePolicy[] | null | undefined): void {
    if (!profiles?.length) return;
    const byId = new Map((this.options.objectProfiles ?? []).map((profile) => [profile.id, profile]));
    for (const profile of profiles) byId.set(profile.id, profile);
    this.options = {
      ...this.options,
      objectProfiles: [...byId.values()],
    };
  }

  async enrichSource(
    sourceId: string,
    input: { readonly force?: boolean | undefined; readonly knowledgeSpaceId?: string | undefined } = {},
  ): Promise<KnowledgeSemanticEnrichmentResult | null> {
    await this.store.init();
    const source = this.store.getSource(sourceId);
    if (!source) return null;
    return enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, input);
  }

  async enrichSources(
    sources: readonly KnowledgeSourceRecord[],
    input: { readonly force?: boolean; readonly knowledgeSpaceId?: string; readonly limit?: number } = {},
  ): Promise<readonly KnowledgeSemanticEnrichmentResult[]> {
    const results: KnowledgeSemanticEnrichmentResult[] = [];
    const selected = sources.slice(0, Math.max(1, input.limit ?? sources.length));
    for (const [index, source] of selected.entries()) {
      await yieldEvery(index);
      const result = await this.enrichSource(source.id, input);
      if (result) results.push(result);
      await yieldToEventLoop();
    }
    return results;
  }

  async reindex(input: {
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
    readonly knowledgeSpaceId?: string | undefined;
  } = {}): Promise<{
    readonly scanned: number;
    readonly enriched: number;
    readonly skipped: number;
    readonly failed: number;
    readonly errors: readonly { readonly sourceId: string; readonly error: string }[];
    readonly selfImprovement: KnowledgeSemanticSelfImproveResult;
  }> {
    await this.store.init();
    const allowed = input.sourceIds?.length ? new Set(input.sourceIds) : null;
    const sources = listSemanticSources(this.store, input.knowledgeSpaceId)
      .filter((source) => !allowed || allowed.has(source.id))
      .slice(0, Math.max(1, input.limit ?? 10_000));
    const maxLlmSources = Math.max(0, this.options.maxLlmSourcesPerReindex ?? 3);
    const maxRunMs = Math.max(100, input.maxRunMs ?? this.options.maxReindexRunMs ?? 45_000);
    const startedAt = Date.now();
    let llmAttempts = 0;
    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    const errors: { sourceId: string; error: string }[] = [];
    for (const [index, source] of sources.entries()) {
      await yieldEvery(index);
      if (Date.now() - startedAt >= maxRunMs) {
        skipped += sources.length - processed;
        break;
      }
      processed += 1;
      try {
        const llm = this.options.llm && llmAttempts < maxLlmSources && sourceCanUseLlmUpgrade(this.store, source)
          ? this.options.llm
          : null;
        if (llm) llmAttempts += 1;
        const result = await enrichKnowledgeSource({ store: this.store, llm }, source, input);
        if (result?.skipped) skipped += 1;
        else if (result) enriched += 1;
      } catch (error) {
        failed += 1;
        errors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) });
      }
      await yieldToEventLoop();
    }
    const selfImprovement = await this.selfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      force: input.force,
      reason: 'reindex',
      limit: input.limit,
      maxRunMs: input.maxRunMs,
      deferRepair: Boolean(this.options.gapRepairer),
    });
    const backgroundRepairLimit = Math.max(1, this.options.backgroundRepairLimit ?? 8);
    this.runSelfImprovementInBackground({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      force: true,
      reason: 'reindex',
      limit: Math.min(Math.max(1, input.limit ?? backgroundRepairLimit), backgroundRepairLimit),
      maxRunMs: 30_000,
    }, this.options.backgroundRepairDelayMs ?? 2_000);
    return { scanned: sources.length, enriched, skipped, failed, errors, selfImprovement };
  }

  async answer(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerResult> {
    await this.store.init();
    let answer = await answerKnowledgeQuery({
      store: this.store,
      llm: this.options.llm,
      objectProfiles: this.options.objectProfiles,
    }, input);
    if (input.autoRepairGaps === false) return answer;
    if (this.options.gapRepairer && answer.answer.gaps.length > 0) {
      const repairSpaceId = answerRepairSpaceId(answer);
      const originalGapIds = answer.answer.gaps
        .filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer')
        .map((gap) => gap.id);
      const foregroundBudgetMs = foregroundAnswerRepairBudget(input, answer);
      const foregroundTaskIds: string[] = [];
      const foregroundStartedAt = Date.now();
      let foregroundRepair = emptySelfImproveResult();
      if (foregroundBudgetMs > 0) {
        foregroundRepair = await this.repairAnswerGaps({
          answer,
          maxRunMs: foregroundBudgetMs,
          limit: Math.min(5, answer.answer.gaps.length),
        });
        foregroundTaskIds.push(...foregroundRepair.taskIds);
        if (foregroundRepair.closedGaps > 0 || foregroundRepair.linkedRepairs > 0 || (foregroundRepair.promotedFactCount ?? 0) > 0) {
          answer = withRefinementTaskIds(
            await answerKnowledgeQuery({
              store: this.store,
              llm: this.options.llm,
              objectProfiles: this.options.objectProfiles,
            }, input),
            foregroundTaskIds,
          );
          if (answerHasUsableEvidence(answer)) {
            return withAnswerRefinement(answer, answerRefinementFromRepair(foregroundRepair, 'repaired', {
              waitedMs: Date.now() - foregroundStartedAt,
              answerCacheInvalidated: true,
            }));
          }
        }
        if (foregroundRepair.skippedGaps > 0 || foregroundRepair.queuedTasks > 0 || (foregroundRepair.acceptedSourceIds?.length ?? 0) > 0) {
          const waited = await this.waitForActiveAnswerGapRepairs(
            repairSpaceId,
            answerGapIdsForRefinement(answer, originalGapIds),
            Math.min(15_000, foregroundBudgetMs),
          );
          if (waited) {
            answer = withRefinementTaskIds(
              await answerKnowledgeQuery({
                store: this.store,
                llm: this.options.llm,
                objectProfiles: this.options.objectProfiles,
              }, input),
              foregroundTaskIds,
            );
            if (answerHasUsableEvidence(answer)) {
              return withAnswerRefinement(answer, answerRefinementFromRepair(foregroundRepair, 'repaired', {
                waitedMs: Date.now() - foregroundStartedAt,
                answerCacheInvalidated: true,
              }));
            }
          }
        }
      }
      const refinementGapIds = answerGapIdsForRefinement(answer, originalGapIds);
      const refinement = await this.selfImprove({
        knowledgeSpaceId: repairSpaceId,
        gapIds: refinementGapIds,
        reason: 'answer',
        limit: Math.max(1, refinementGapIds.length),
        deferRepair: true,
      });
      this.runAnswerRefinementInBackground(repairSpaceId, refinementGapIds);
      const taskIds = uniqueStrings([
        ...foregroundTaskIds,
        ...refinement.taskIds,
        ...this.taskIdsForGaps(repairSpaceId, refinementGapIds),
      ]);
      if (taskIds.length > 0) {
        return withAnswerRefinement(withRefinementTaskIds(answer, taskIds), answerRefinementFromRepair(
          mergeSelfImproveResults(foregroundRepair, refinement),
          repairAnswerStatus(answer, foregroundRepair, refinement),
          {
            waitedMs: Date.now() - foregroundStartedAt,
            answerCacheInvalidated: (foregroundRepair.linkedRepairs > 0 || (foregroundRepair.promotedFactCount ?? 0) > 0),
          },
        ));
      }
    }
    return answer;
  }

  async repairAnswerGaps(input: {
    readonly answer: KnowledgeSemanticAnswerResult;
    readonly maxRunMs?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<KnowledgeSemanticSelfImproveResult> {
    const gaps = input.answer.answer.gaps.filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer');
    if (!this.options.gapRepairer || gaps.length === 0) return emptySelfImproveResult();
    return this.selfImprove({
      knowledgeSpaceId: answerRepairSpaceId(input.answer),
      gapIds: gaps.map((gap) => gap.id),
      reason: 'answer',
      limit: Math.max(1, input.limit ?? gaps.length),
      maxRunMs: input.maxRunMs,
      force: true,
    });
  }

  private runAnswerRefinementInBackground(spaceId: string, gapIds: readonly string[]): void {
    if (!this.options.gapRepairer || gapIds.length === 0) return;
    this.runSelfImprovementInBackground({
      knowledgeSpaceId: spaceId,
      gapIds,
      reason: 'answer',
      limit: Math.max(1, gapIds.length),
      maxRunMs: 30_000,
      force: true,
    });
  }

  private runSelfImprovementInBackground(input: KnowledgeSemanticSelfImproveInput, delayMs = 0): void {
    if (!this.options.gapRepairer) return;
    // Governor backpressure: when the daemon is under memory pressure this job
    // is paused — do not schedule new background runs. The hourly foreground
    // path still runs; only the self-scheduled churn defers.
    if (this.options.isBackgroundPaused?.()) return;
    // One scheduling slot per scope+reason. Coalescing here is what stops a burst
    // of enrichment/answer events from each queuing its own delay-0 run — the hot
    // loop that fanned control-plane events until the daemon OOM'd.
    const key = `${selfImprovementRunKey(input)}|${input.reason ?? 'none'}`;
    const state = this.backgroundRunState.get(key) ?? { pending: false, zeroGapUntil: 0 };
    if (state.pending) return; // a run is already queued for this scope — coalesce
    if (Date.now() < state.zeroGapUntil) return; // last run found no gaps — defer to the hourly schedule
    const minDelayMs = Math.max(0, this.options.backgroundSelfImproveMinDelayMs ?? DEFAULT_SELF_IMPROVE_MIN_DELAY_MS);
    const backoffMs = Math.max(0, this.options.backgroundSelfImproveZeroGapBackoffMs ?? DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS);
    // Enforce the floor: a background run is NEVER scheduled sooner than minDelayMs,
    // even when the caller passes delayMs=0.
    const flooredDelayMs = Math.max(minDelayMs, Math.max(0, delayMs));
    state.pending = true;
    this.backgroundRunState.set(key, state);
    scheduleBackground(() => {
      void this.selfImprove(input)
        .then((result) => {
          const next = this.backgroundRunState.get(key) ?? { pending: false, zeroGapUntil: 0 };
          next.pending = false;
          // Zero candidate gaps ⇒ back off; a run that found nothing must not keep
          // rescheduling itself. A subsequent run that finds gaps clears the window.
          next.zeroGapUntil = (result.candidateGaps ?? 0) === 0 ? Date.now() + backoffMs : 0;
          this.backgroundRunState.set(key, next);
        })
        .catch((error: unknown) => {
          const next = this.backgroundRunState.get(key);
          if (next) next.pending = false;
          logger.warn('Knowledge semantic background self-improvement failed', {
            error: error instanceof Error ? error.message : String(error),
            knowledgeSpaceId: input.knowledgeSpaceId,
            reason: input.reason,
          });
        });
    }, flooredDelayMs);
  }

  async selfImprove(input: KnowledgeSemanticSelfImproveInput = {}): Promise<KnowledgeSemanticSelfImproveResult> {
    await this.store.init();
    if (input.deferRepair !== true) {
      const runKey = selfImprovementRunKey(input);
      const activeRun = this.activeSelfImprovementRuns.get(runKey);
      if (activeRun && !input.gapIds?.length) return activeSelfImproveResult(input);
      const run = this.runSelfImproveUnlocked(input);
      if (!input.gapIds?.length) this.activeSelfImprovementRuns.set(runKey, run);
      try {
        return await run;
      } finally {
        if (this.activeSelfImprovementRuns.get(runKey) === run) this.activeSelfImprovementRuns.delete(runKey);
      }
    }
    return this.runSelfImproveUnlocked(input);
  }

  private async runSelfImproveUnlocked(input: KnowledgeSemanticSelfImproveInput): Promise<KnowledgeSemanticSelfImproveResult> {
    if (!input.knowledgeSpaceId && !input.sourceIds?.length && !input.gapIds?.length) {
      // Distinct-space discovery over the WHOLE store. Paging keeps a single run's
      // allocation bounded to one SELF_IMPROVE_SPACE_PAGE_SIZE page at a time
      // instead of materializing every source+node record at once (the previous
      // Number.MAX_SAFE_INTEGER call, which allocated the full store per run).
      const spaces = uniqueStrings([...this.collectSemanticSpaceIds()]);
      let combined = emptySelfImproveResult();
      for (const [index, spaceId] of spaces.entries()) {
        await yieldEvery(index, 1);
        const result = await runKnowledgeSemanticSelfImprovement({
          store: this.store,
          gapRepairer: this.options.gapRepairer,
          activeGapRepairs: this.activeGapRepairs,
          objectProfiles: this.options.objectProfiles,
          enrichSource: (sourceId, options) => {
            const source = this.store.getSource(sourceId);
            return source ? enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, options) : Promise.resolve(null);
          },
        }, { ...input, knowledgeSpaceId: spaceId });
        combined = mergeSelfImproveResults(combined, result);
      }
      return combined;
    }
    return runKnowledgeSemanticSelfImprovement({
      store: this.store,
      gapRepairer: this.options.gapRepairer,
      activeGapRepairs: this.activeGapRepairs,
      objectProfiles: this.options.objectProfiles,
      enrichSource: (sourceId, options) => {
        const source = this.store.getSource(sourceId);
        return source ? enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, options) : Promise.resolve(null);
      },
    }, input);
  }

  /**
   * Collect every distinct non-stale knowledge-space id across all sources and
   * nodes, reading the store one bounded page at a time. Each page allocates at
   * most SELF_IMPROVE_SPACE_PAGE_SIZE records; the loop stops when a short page
   * signals the end. Behavior matches the old full-materialization scan (all
   * spaces are discovered) with a bounded per-run footprint.
   */
  private collectSemanticSpaceIds(): Set<string> {
    const spaceIds = new Set<string>();
    for (let offset = 0; ; offset += SELF_IMPROVE_SPACE_PAGE_SIZE) {
      const page = this.store.listSourcesPage(offset, SELF_IMPROVE_SPACE_PAGE_SIZE);
      for (const source of page) {
        if (source.status !== 'stale') spaceIds.add(getKnowledgeSpaceId(source));
      }
      if (page.length < SELF_IMPROVE_SPACE_PAGE_SIZE) break;
    }
    for (let offset = 0; ; offset += SELF_IMPROVE_SPACE_PAGE_SIZE) {
      const page = this.store.listNodesPage(offset, SELF_IMPROVE_SPACE_PAGE_SIZE);
      for (const node of page) {
        if (node.status !== 'stale') spaceIds.add(getKnowledgeSpaceId(node));
      }
      if (page.length < SELF_IMPROVE_SPACE_PAGE_SIZE) break;
    }
    return spaceIds;
  }

  private taskIdsForGaps(spaceId: string, gapIds: readonly string[]): readonly string[] {
    const wanted = new Set(gapIds);
    if (wanted.size === 0) return [];
    return this.store.listRefinementTasks(100, { spaceId })
      .filter((task) => task.gapId && wanted.has(task.gapId))
      .map((task) => task.id);
  }

  private async waitForActiveAnswerGapRepairs(
    spaceId: string,
    gapIds: readonly string[],
    maxWaitMs: number,
  ): Promise<boolean> {
    if (gapIds.length === 0 || maxWaitMs <= 0) return false;
    const keys = gapIds.map((gapId) => `${spaceId}:${gapId}`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      const active = keys.some((key) => this.activeGapRepairs.has(key));
      if (!active) return true;
      await yieldToEventLoop();
      await sleep(100);
    }
    return false;
  }
}

function listSemanticSources(
  store: KnowledgeStore,
  spaceId: string | undefined,
): KnowledgeSourceRecord[] {
  if (!spaceId) return store.listSources(Number.MAX_SAFE_INTEGER).filter(isSemanticSourceCandidate);
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (normalized === 'homeassistant') {
    return store.listSources(Number.MAX_SAFE_INTEGER)
      .filter((source) => isSemanticSourceCandidate(source) && isHomeAssistantKnowledgeSpace(normalizeKnowledgeSpaceId(getKnowledgeSpaceId(source))));
  }
  return store.listSourcesInSpace(normalized).filter(isSemanticSourceCandidate);
}

function isSemanticSourceCandidate(source: KnowledgeSourceRecord): boolean {
  return source.status !== 'stale' && !isGeneratedKnowledgeSource(source);
}

function answerRepairSpaceId(answer: KnowledgeSemanticAnswerResult): string {
  for (const gap of answer.answer.gaps) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(gap));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  for (const source of answer.answer.sources) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(source));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  for (const node of answer.answer.linkedObjects) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(node));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  return answer.spaceId;
}

function foregroundAnswerRepairBudget(
  input: KnowledgeSemanticAnswerInput,
  answer: KnowledgeSemanticAnswerResult,
): number {
  if (!answerNeedsForegroundRepair(input, answer)) return 0;
  const requested = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
    ? input.timeoutMs
    : 45_000;
  if (requested < 12_000) return 0;
  return Math.max(3_000, Math.min(20_000, requested - 5_000));
}

function answerNeedsForegroundRepair(
  input: KnowledgeSemanticAnswerInput,
  answer: KnowledgeSemanticAnswerResult,
): boolean {
  const subjectScoped = input.strictCandidates === true
    || (input.linkedObjects?.length ?? 0) > 0
    || answer.answer.linkedObjects.length > 0
    || answer.answer.gaps.some((gap) => readStringArray(readRecord(gap.metadata).linkedObjectIds).length > 0);
  if (!subjectScoped) return false;
  return answer.answer.facts.length === 0 || answer.answer.sources.length === 0 || answer.answer.confidence < 50;
}

function answerHasUsableEvidence(answer: KnowledgeSemanticAnswerResult): boolean {
  return answer.answer.gaps.length === 0
    && answer.answer.facts.length > 0
    && answer.answer.sources.length > 0
    && answer.answer.confidence >= 50;
}

function withRefinementTaskIds(
  answer: KnowledgeSemanticAnswerResult,
  taskIds: readonly string[],
): KnowledgeSemanticAnswerResult {
  const ids = uniqueStrings([...(answer.answer.refinementTaskIds ?? []), ...taskIds]);
  if (ids.length === 0) return answer;
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinementTaskIds: ids,
    },
  };
}

function answerGapIdsForRefinement(
  answer: KnowledgeSemanticAnswerResult,
  originalGapIds: readonly string[],
): readonly string[] {
  const currentGapIds = answer.answer.gaps
    .filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer')
    .map((gap) => gap.id);
  return currentGapIds.length > 0 ? currentGapIds : originalGapIds;
}

function withAnswerRefinement(
  answer: KnowledgeSemanticAnswerResult,
  refinement: KnowledgeSemanticAnswerRefinement,
): KnowledgeSemanticAnswerResult {
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinement,
    },
  };
}

function repairAnswerStatus(
  answer: KnowledgeSemanticAnswerResult,
  foreground: KnowledgeSemanticSelfImproveResult,
  queued: KnowledgeSemanticSelfImproveResult,
): KnowledgeSemanticAnswerRefinement['status'] {
  if (answerHasUsableEvidence(answer)) return 'repaired';
  if ((foreground.acceptedSourceIds?.length ?? 0) > 0 || (foreground.promotedFactCount ?? 0) > 0) return 'incomplete';
  if (queued.queuedTasks > 0 || foreground.queuedTasks > 0 || foreground.skippedGaps > 0) return 'active';
  return 'deferred';
}

function answerRefinementFromRepair(
  repair: KnowledgeSemanticSelfImproveResult,
  status: KnowledgeSemanticAnswerRefinement['status'],
  options: {
    readonly waitedMs?: number | undefined;
    readonly answerCacheInvalidated?: boolean | undefined;
  } = {},
): KnowledgeSemanticAnswerRefinement {
  const acceptedSourceIds = repair.acceptedSourceIds ?? [];
  const promotedFactCount = repair.promotedFactCount ?? 0;
  const reason = repair.errors[0]?.error
    ?? (repair.budgetExhausted ? 'Repair did not finish within the current run budget.' : undefined);
  return {
    status,
    ...(reason ? { reason } : {}),
    repairStatus: status === 'repaired' ? 'repaired' : status === 'active' ? 'active' : 'deferred',
    refinementTaskIds: repair.taskIds,
    acceptedSourceIds,
    promotedFactCount,
    ...(repair.nextRepairAttemptAt ? { nextRepairAttemptAt: repair.nextRepairAttemptAt } : {}),
    ...(typeof options.waitedMs === 'number' ? { waitedMs: options.waitedMs } : {}),
    ...(options.answerCacheInvalidated ? { answerCacheInvalidated: true } : {}),
  };
}

function activeSelfImproveResult(input: KnowledgeSemanticSelfImproveInput): KnowledgeSemanticSelfImproveResult {
  const requestedLimit = Math.max(1, input.limit ?? 1);
  return {
    ...emptySelfImproveResult(),
    skippedGaps: 1,
    requestedLimit,
    effectiveLimit: 0,
    coalesced: true,
    truncated: true,
    budgetExhausted: true,
  };
}

function selfImprovementRunKey(input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return `space:${normalizeKnowledgeSpaceId(input.knowledgeSpaceId)}`;
  if (input.sourceIds?.length) return `sources:${uniqueStrings(input.sourceIds).sort().join(',')}`;
  return 'global';
}

function sourceCanUseLlmUpgrade(store: KnowledgeStore, source: KnowledgeSourceRecord): boolean {
  const extraction = store.getExtractionBySourceId(source.id);
  const text = sourceSemanticText(source, extraction);
  if (text.length < 40) return false;
  const existingSemantic = readRecord(store.getSemanticEnrichmentState(source.id)?.metadata);
  return existingSemantic.textHash !== sourceSemanticHash(source, extraction)
    || readString(existingSemantic.extractor) !== 'llm';
}

function emptySelfImproveResult(): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: 0,
    candidateGaps: 0,
    processedGaps: 0,
    createdGaps: 0,
    repairableGaps: 0,
    suppressedGaps: 0,
    skippedGaps: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    requestedLimit: 0,
    effectiveLimit: 0,
    truncated: false,
    budgetExhausted: false,
    taskIds: [],
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    promotedFactCount: 0,
    errors: [],
  };
}

function mergeSelfImproveResults(
  left: KnowledgeSemanticSelfImproveResult,
  right: KnowledgeSemanticSelfImproveResult,
): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: left.scannedGaps + right.scannedGaps,
    candidateGaps: (left.candidateGaps ?? 0) + (right.candidateGaps ?? 0),
    processedGaps: (left.processedGaps ?? 0) + (right.processedGaps ?? 0),
    createdGaps: left.createdGaps + right.createdGaps,
    repairableGaps: left.repairableGaps + right.repairableGaps,
    suppressedGaps: left.suppressedGaps + right.suppressedGaps,
    skippedGaps: left.skippedGaps + right.skippedGaps,
    searched: left.searched + right.searched,
    ingestedSources: left.ingestedSources + right.ingestedSources,
    linkedRepairs: left.linkedRepairs + right.linkedRepairs,
    blockedGaps: left.blockedGaps + right.blockedGaps,
    closedGaps: left.closedGaps + right.closedGaps,
    queuedTasks: left.queuedTasks + right.queuedTasks,
    requestedLimit: (left.requestedLimit ?? 0) + (right.requestedLimit ?? 0),
    effectiveLimit: (left.effectiveLimit ?? 0) + (right.effectiveLimit ?? 0),
    coalesced: Boolean(left.coalesced || right.coalesced),
    truncated: Boolean(left.truncated || right.truncated),
    budgetExhausted: Boolean(left.budgetExhausted || right.budgetExhausted),
    taskIds: uniqueStrings([...left.taskIds, ...right.taskIds]),
    ingestedSourceIds: uniqueStrings([...left.ingestedSourceIds, ...right.ingestedSourceIds]),
    acceptedSourceIds: uniqueStrings([...(left.acceptedSourceIds ?? []), ...(right.acceptedSourceIds ?? [])]),
    promotedFactCount: (left.promotedFactCount ?? 0) + (right.promotedFactCount ?? 0),
    nextRepairAttemptAt: maxDefined(left.nextRepairAttemptAt, right.nextRepairAttemptAt),
    errors: [...left.errors, ...right.errors],
  };
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left !== 'number') return right;
  if (typeof right !== 'number') return left;
  return Math.max(left, right);
}
