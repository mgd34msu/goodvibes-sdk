import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import { answerKnowledgeQuery } from './answer.js';
import { enrichKnowledgeSource } from './enrichment.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticEnrichmentResult,
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticLlm,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { readRecord, readString, sourceSemanticHash, sourceSemanticText } from './utils.js';
import { uniqueStrings } from './utils.js';
import { runKnowledgeSemanticSelfImprovement } from './self-improvement.js';

export interface KnowledgeSemanticServiceOptions {
  readonly llm?: KnowledgeSemanticLlm | null;
  readonly maxLlmSourcesPerReindex?: number;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null;
  readonly maxReindexRunMs?: number;
  readonly backgroundRepairDelayMs?: number;
  readonly backgroundRepairLimit?: number;
}

export class KnowledgeSemanticService {
  private readonly activeGapRepairs = new Set<string>();
  private activeSelfImprovementRun: Promise<KnowledgeSemanticSelfImproveResult> | null = null;

  constructor(
    private readonly store: KnowledgeStore,
    private options: KnowledgeSemanticServiceOptions = {},
  ) {}

  setGapRepairer(gapRepairer: KnowledgeSemanticGapRepairer | null | undefined): void {
    this.options = {
      ...this.options,
      gapRepairer: gapRepairer ?? null,
    };
  }

  async enrichSource(
    sourceId: string,
    input: { readonly force?: boolean; readonly knowledgeSpaceId?: string } = {},
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
    readonly sourceIds?: readonly string[];
    readonly limit?: number;
    readonly maxRunMs?: number;
    readonly force?: boolean;
    readonly knowledgeSpaceId?: string;
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
    const sources = this.store.listSources(10_000)
      .filter((source) => !allowed || allowed.has(source.id))
      .filter((source) => !input.knowledgeSpaceId || getKnowledgeSpaceId(source) === input.knowledgeSpaceId)
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
    this.runSelfImprovementInBackground({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      force: true,
      reason: 'reindex',
      limit: Math.min(Math.max(1, input.limit ?? this.options.backgroundRepairLimit ?? 3), this.options.backgroundRepairLimit ?? 3),
      maxRunMs: 15_000,
    }, this.options.backgroundRepairDelayMs ?? 2_000);
    return { scanned: sources.length, enriched, skipped, failed, errors, selfImprovement };
  }

  async answer(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerResult> {
    await this.store.init();
    let answer = await answerKnowledgeQuery({ store: this.store, llm: this.options.llm }, input);
    if (input.autoRepairGaps === false) return answer;
    if (this.options.gapRepairer && answer.answer.gaps.length > 0) {
      const repairSpaceId = answerRepairSpaceId(answer);
      const foregroundBudgetMs = foregroundAnswerRepairBudget(input, answer);
      const foregroundTaskIds: string[] = [];
      if (foregroundBudgetMs > 0) {
        const repaired = await this.repairAnswerGaps({
          answer,
          maxRunMs: foregroundBudgetMs,
          limit: Math.min(5, answer.answer.gaps.length),
        });
        foregroundTaskIds.push(...repaired.taskIds);
        if (repaired.closedGaps > 0 || repaired.linkedRepairs > 0) {
          answer = withRefinementTaskIds(
            await answerKnowledgeQuery({ store: this.store, llm: this.options.llm }, input),
            foregroundTaskIds,
          );
          if (answer.answer.gaps.length === 0 || answerHasUsableEvidence(answer)) return answer;
        }
        if (repaired.skippedGaps > 0 || repaired.queuedTasks > 0) {
          const waited = await this.waitForActiveAnswerGapRepairs(repairSpaceId, answer.answer.gaps.map((gap) => gap.id), Math.min(15_000, foregroundBudgetMs));
          if (waited) {
            answer = withRefinementTaskIds(
              await answerKnowledgeQuery({ store: this.store, llm: this.options.llm }, input),
              foregroundTaskIds,
            );
            if (answer.answer.gaps.length === 0 || answerHasUsableEvidence(answer)) return answer;
          }
        }
      }
      const refinement = await this.selfImprove({
        knowledgeSpaceId: repairSpaceId,
        gapIds: answer.answer.gaps.map((gap) => gap.id),
        reason: 'answer',
        limit: Math.max(1, answer.answer.gaps.length),
        deferRepair: true,
      });
      this.runAnswerRefinementInBackground(repairSpaceId, answer.answer.gaps.map((gap) => gap.id));
      const taskIds = uniqueStrings([
        ...foregroundTaskIds,
        ...refinement.taskIds,
        ...this.taskIdsForGaps(repairSpaceId, answer.answer.gaps.map((gap) => gap.id)),
      ]);
      if (taskIds.length > 0) {
        return withRefinementTaskIds(answer, taskIds);
      }
    }
    return answer;
  }

  async repairAnswerGaps(input: {
    readonly answer: KnowledgeSemanticAnswerResult;
    readonly maxRunMs?: number;
    readonly limit?: number;
  }): Promise<KnowledgeSemanticSelfImproveResult> {
    const gaps = input.answer.answer.gaps;
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
    setTimeout(() => {
      void this.selfImprove(input).catch(() => {});
    }, Math.max(0, delayMs));
  }

  async selfImprove(input: KnowledgeSemanticSelfImproveInput = {}): Promise<KnowledgeSemanticSelfImproveResult> {
    await this.store.init();
    if (input.deferRepair !== true) {
      if (this.activeSelfImprovementRun && !input.gapIds?.length) return activeSelfImproveResult(input);
      const run = this.runSelfImproveUnlocked(input);
      if (!input.gapIds?.length) this.activeSelfImprovementRun = run;
      try {
        return await run;
      } finally {
        if (this.activeSelfImprovementRun === run) this.activeSelfImprovementRun = null;
      }
    }
    return this.runSelfImproveUnlocked(input);
  }

  private async runSelfImproveUnlocked(input: KnowledgeSemanticSelfImproveInput): Promise<KnowledgeSemanticSelfImproveResult> {
    if (!input.knowledgeSpaceId && !input.sourceIds?.length && !input.gapIds?.length) {
      const spaces = uniqueStrings([
        ...this.store.listSources(10_000).map((source) => getKnowledgeSpaceId(source)),
        ...this.store.listNodes(10_000).map((node) => getKnowledgeSpaceId(node)),
      ]);
      let combined = emptySelfImproveResult();
      for (const [index, spaceId] of spaces.entries()) {
        await yieldEvery(index, 1);
        const result = await runKnowledgeSemanticSelfImprovement({
          store: this.store,
          gapRepairer: this.options.gapRepairer,
          activeGapRepairs: this.activeGapRepairs,
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
      enrichSource: (sourceId, options) => {
        const source = this.store.getSource(sourceId);
        return source ? enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, options) : Promise.resolve(null);
      },
    }, input);
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }
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
  const repairSpaceId = answerRepairSpaceId(answer);
  const homeAssistantScoped = repairSpaceId === 'homeassistant' || repairSpaceId.startsWith('homeassistant:');
  if (!input.strictCandidates && !homeAssistantScoped) return false;
  return answer.answer.facts.length === 0 || answer.answer.sources.length === 0 || answer.answer.confidence < 50;
}

function answerHasUsableEvidence(answer: KnowledgeSemanticAnswerResult): boolean {
  return answer.answer.facts.length > 0 && answer.answer.sources.length > 0 && answer.answer.confidence >= 50;
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

function sourceCanUseLlmUpgrade(store: KnowledgeStore, source: KnowledgeSourceRecord): boolean {
  const extraction = store.getExtractionBySourceId(source.id);
  const text = sourceSemanticText(source, extraction);
  if (text.length < 40) return false;
  const existingSemantic = readRecord(source.metadata.semanticEnrichment);
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
    errors: [...left.errors, ...right.errors],
  };
}
