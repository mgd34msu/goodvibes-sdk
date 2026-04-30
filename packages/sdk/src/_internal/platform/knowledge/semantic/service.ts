import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { answerKnowledgeQuery } from './answer.js';
import { enrichKnowledgeSource } from './enrichment.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticEnrichmentResult,
  KnowledgeSemanticLlm,
} from './types.js';
import { readRecord, readString, sourceSemanticHash, sourceSemanticText } from './utils.js';

export interface KnowledgeSemanticServiceOptions {
  readonly llm?: KnowledgeSemanticLlm | null;
  readonly maxLlmSourcesPerReindex?: number;
}

export class KnowledgeSemanticService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly options: KnowledgeSemanticServiceOptions = {},
  ) {}

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
    return { scanned: sources.length, enriched, skipped, failed, errors };
  }

  async answer(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerResult> {
    await this.store.init();
    return answerKnowledgeQuery({ store: this.store, llm: this.options.llm }, input);
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
