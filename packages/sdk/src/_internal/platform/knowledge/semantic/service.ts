import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { getKnowledgeSpaceId } from '../spaces.js';
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
}

export class KnowledgeSemanticService {
  private readonly activeGapRepairs = new Set<string>();

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
    for (const source of sources.slice(0, Math.max(1, input.limit ?? sources.length))) {
      const result = await this.enrichSource(source.id, input);
      if (result) results.push(result);
    }
    return results;
  }

  async reindex(input: {
    readonly sourceIds?: readonly string[];
    readonly limit?: number;
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
      .slice(0, Math.max(1, input.limit ?? 10_000));
    const maxLlmSources = Math.max(0, this.options.maxLlmSourcesPerReindex ?? 3);
    let llmAttempts = 0;
    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    const errors: { sourceId: string; error: string }[] = [];
    for (const source of sources) {
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
    }
    const selfImprovement = await this.selfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      force: input.force,
      reason: 'reindex',
      limit: input.limit,
    });
    return { scanned: sources.length, enriched, skipped, failed, errors, selfImprovement };
  }

  async answer(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerResult> {
    await this.store.init();
    const answer = await answerKnowledgeQuery({ store: this.store, llm: this.options.llm }, input);
    this.queueGapRepair(answer);
    return answer;
  }

  async selfImprove(input: KnowledgeSemanticSelfImproveInput = {}): Promise<KnowledgeSemanticSelfImproveResult> {
    await this.store.init();
    if (!input.knowledgeSpaceId && !input.sourceIds?.length && !input.gapIds?.length) {
      const spaces = uniqueStrings([
        ...this.store.listSources(10_000).map((source) => getKnowledgeSpaceId(source)),
        ...this.store.listNodes(10_000).map((node) => getKnowledgeSpaceId(node)),
      ]);
      let combined = emptySelfImproveResult();
      for (const spaceId of spaces) {
        const result = await runKnowledgeSemanticSelfImprovement({
          store: this.store,
          gapRepairer: this.options.gapRepairer,
          activeGapRepairs: this.activeGapRepairs,
        }, { ...input, knowledgeSpaceId: spaceId });
        combined = mergeSelfImproveResults(combined, result);
      }
      return combined;
    }
    return runKnowledgeSemanticSelfImprovement({
      store: this.store,
      gapRepairer: this.options.gapRepairer,
      activeGapRepairs: this.activeGapRepairs,
    }, input);
  }

  private queueGapRepair(answer: KnowledgeSemanticAnswerResult): void {
    if (!this.options.gapRepairer || answer.answer.gaps.length === 0 || answer.answer.sources.length === 0) return;
    const gaps = answer.answer.gaps.filter((gap) => !this.hasGapRepairSource(answer.spaceId, gap.id));
    if (gaps.length === 0) return;
    const repairKey = `${answer.spaceId}:${gaps.map((gap) => gap.id).sort().join(',')}`;
    if (this.activeGapRepairs.has(repairKey)) return;
    this.activeGapRepairs.add(repairKey);
    const repairer = this.options.gapRepairer;
    void repairer({
      spaceId: answer.spaceId,
      query: answer.query,
      gaps,
      sources: answer.answer.sources,
      linkedObjects: answer.answer.linkedObjects,
      facts: answer.answer.facts,
    })
      .then(async (result) => {
        if (!result?.ingestedSourceIds.length) return;
        for (const sourceId of result.ingestedSourceIds) {
          for (const gap of gaps) {
            await this.store.upsertEdge({
              fromKind: 'source',
              fromId: sourceId,
              toKind: 'node',
              toId: gap.id,
              relation: 'repairs_gap',
              weight: 0.8,
              metadata: {
                semantic: true,
                knowledgeSpaceId: answer.spaceId,
                query: result.query ?? answer.query,
                repairedAt: Date.now(),
              },
            });
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        this.activeGapRepairs.delete(repairKey);
      });
  }

  private hasGapRepairSource(spaceId: string, gapId: string): boolean {
    return this.store.listEdges().some((edge) => (
      edge.relation === 'repairs_gap'
      && edge.toKind === 'node'
      && edge.toId === gapId
      && edge.fromKind === 'source'
      && readString(edge.metadata.knowledgeSpaceId) === spaceId
    ));
  }
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
    createdGaps: 0,
    repairableGaps: 0,
    suppressedGaps: 0,
    skippedGaps: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    errors: [],
  };
}

function mergeSelfImproveResults(
  left: KnowledgeSemanticSelfImproveResult,
  right: KnowledgeSemanticSelfImproveResult,
): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: left.scannedGaps + right.scannedGaps,
    createdGaps: left.createdGaps + right.createdGaps,
    repairableGaps: left.repairableGaps + right.repairableGaps,
    suppressedGaps: left.suppressedGaps + right.suppressedGaps,
    skippedGaps: left.skippedGaps + right.skippedGaps,
    searched: left.searched + right.searched,
    ingestedSources: left.ingestedSources + right.ingestedSources,
    linkedRepairs: left.linkedRepairs + right.linkedRepairs,
    errors: [...left.errors, ...right.errors],
  };
}
