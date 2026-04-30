import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import type { HomeGraphSearchState } from './search.js';

export async function answerHomeGraphQuery(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  const sources = input.results.flatMap((result) => result.source ? [result.source] : []);
  const linkedObjects = collectLinkedObjects(input.results, input.state);
  if (input.semanticService) {
    void input.semanticService.enrichSources(uniqueSources(sources), {
      knowledgeSpaceId: input.spaceId,
      limit: Math.min(3, Math.max(1, sources.length)),
    }).catch(() => {});
    const answer = await input.semanticService.answer({
      query: input.query.query,
      knowledgeSpaceId: input.spaceId,
      mode: input.query.mode ?? 'standard',
      limit: input.query.limit ?? 8,
      includeSources: input.query.includeSources,
      includeConfidence: input.query.includeConfidence,
      includeLinkedObjects: input.query.includeLinkedObjects,
      candidateSourceIds: sources.map((source) => source.id),
      candidateNodeIds: input.results.flatMap((result) => result.node ? [result.node.id] : []),
      strictCandidates: true,
      linkedObjects,
      noMatchMessage: `No Home Graph knowledge matched "${input.query.query}".`,
    });
    return {
      ok: true,
      spaceId: input.spaceId,
      query: input.query.query,
      answer: {
        text: answer.answer.text,
        mode: answer.answer.mode,
        confidence: answer.answer.confidence,
        sources: answer.answer.sources,
        linkedObjects: answer.answer.linkedObjects,
        facts: answer.answer.facts,
        gaps: answer.answer.gaps,
        synthesized: answer.answer.synthesized,
      },
      results: input.results,
    };
  }
  const confidence = Math.min(100, Math.max(10, input.results[0]?.score ?? 10));
  return {
    ok: true,
    spaceId: input.spaceId,
    query: input.query.query,
    answer: {
      text: renderAskAnswer(input.query.query, input.results, input.query.mode ?? 'standard'),
      mode: input.query.mode ?? 'standard',
      confidence,
      sources: input.query.includeSources === false ? [] : sources,
      linkedObjects: input.query.includeLinkedObjects === false ? [] : linkedObjects,
    },
    results: input.results,
  };
}

function uniqueSources(sources: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeSourceRecord[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    out.push(source);
  }
  return out;
}
