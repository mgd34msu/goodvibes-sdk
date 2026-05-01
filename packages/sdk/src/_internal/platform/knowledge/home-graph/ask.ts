import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import {
  readHomeGraphSearchState,
  scoreHomeGraphResults,
  type HomeGraphSearchState,
} from './search.js';
import {
  inferHomeAssistantAnswerScopeForQuery,
  nodeInHomeAssistantAnswerScope,
  sourceInHomeAssistantAnswerScope,
} from '../semantic/homeassistant-scope.js';
import { uniqueStrings } from '../semantic/utils.js';

export async function answerHomeGraphQuery(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  const answer = await answerHomeGraphQueryOnce(input);
  if (!shouldRunForegroundRepair(input, answer)) return answer;
  const refinement = await input.semanticService!.repairAnswerGaps({
    answer: {
      ok: true,
      spaceId: input.spaceId,
      query: answer.query,
      answer: {
        ...answer.answer,
        facts: answer.answer.facts ?? [],
        gaps: answer.answer.gaps ?? [],
        synthesized: answer.answer.synthesized === true,
      },
      results: [],
    },
    limit: Math.max(1, answer.answer.gaps?.length ?? 1),
    maxRunMs: 25_000,
  }).catch(() => null);
  if (!refinement) return answer;
  const repairedSources = refinement.ingestedSourceIds
    .map((sourceId) => input.store.getSource(sourceId))
    .filter((source): source is KnowledgeSourceRecord => Boolean(source));
  if (repairedSources.length > 0) {
    await input.semanticService!.enrichSources(repairedSources, {
      knowledgeSpaceId: input.spaceId,
      force: true,
      limit: Math.min(3, repairedSources.length),
    });
  }
  if (refinement.ingestedSourceIds.length === 0 && refinement.linkedRepairs === 0 && refinement.closedGaps === 0) {
    return mergeRefinementTaskIds(answer, refinement.taskIds);
  }
  const state = readHomeGraphSearchState(input.store, input.spaceId);
  const results = scoreHomeGraphResults(
    input.query.query,
    state.sources,
    state.nodes,
    state.edges,
    (sourceId) => state.extractionBySourceId.get(sourceId),
    input.query.limit ?? 8,
  );
  const repaired = await answerHomeGraphQueryOnce({ ...input, state, results });
  return mergeRefinementTaskIds(repaired, [
    ...(answer.answer.refinementTaskIds ?? []),
    ...refinement.taskIds,
    ...taskIdsForGaps(input.store, input.spaceId, answer.answer.gaps?.map((gap) => gap.id) ?? []),
  ]);
}

async function answerHomeGraphQueryOnce(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  const results = scopeHomeGraphAnswerResults(input.store, input.spaceId, input.query.query, input.results);
  const sources = results.flatMap((result) => result.source ? [result.source] : []).map(withAnswerSourceAliases);
  const linkedObjects = collectLinkedObjects(results, input.state);
  if (input.semanticService) {
    const answer = await input.semanticService.answer({
      query: input.query.query,
      knowledgeSpaceId: input.spaceId,
      mode: input.query.mode ?? 'standard',
      limit: input.query.limit ?? 8,
      includeSources: input.query.includeSources,
      includeConfidence: input.query.includeConfidence,
      includeLinkedObjects: input.query.includeLinkedObjects,
      candidateSourceIds: sources.map((source) => source.id),
      candidateNodeIds: results.flatMap((result) => result.node ? [result.node.id] : []),
      strictCandidates: true,
      linkedObjects,
      noMatchMessage: `No Home Graph knowledge matched "${input.query.query}".`,
      autoRepairGaps: false,
    });
    setTimeout(() => {
      void input.semanticService?.enrichSources(uniqueSources(sources), {
        knowledgeSpaceId: input.spaceId,
        limit: Math.min(3, Math.max(1, sources.length)),
      }).catch(() => {});
    }, 0);
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
        refinementTaskIds: answer.answer.refinementTaskIds,
        synthesized: answer.answer.synthesized,
      },
      results,
    };
  }
  const confidence = Math.min(100, Math.max(10, results[0]?.score ?? 10));
  return {
    ok: true,
    spaceId: input.spaceId,
    query: input.query.query,
    answer: {
      text: renderAskAnswer(input.query.query, results, input.query.mode ?? 'standard'),
      mode: input.query.mode ?? 'standard',
      confidence,
      sources: input.query.includeSources === false ? [] : sources,
      linkedObjects: input.query.includeLinkedObjects === false ? [] : linkedObjects,
    },
    results,
  };
}

function shouldRunForegroundRepair(
  input: {
    readonly semanticService?: KnowledgeSemanticService;
    readonly query: HomeGraphAskInput;
  },
  answer: HomeGraphAskResult,
): boolean {
  if (!input.semanticService) return false;
  if (!hasFeatureOrSpecIntent(input.query.query)) return false;
  if (!answer.answer.gaps || answer.answer.gaps.length === 0) return false;
  if (answer.answer.facts && answer.answer.facts.length >= 3 && answer.answer.confidence > 0) return false;
  return answer.answer.linkedObjects?.some(isConcreteHomeGraphSubject) === true;
}

function hasFeatureOrSpecIntent(query: string): boolean {
  return /\b(feature|features|capabilit(?:y|ies)|function|functions|spec|specs|specification|specifications|support|supports|supported)\b/i
    .test(query);
}

function isConcreteHomeGraphSubject(node: KnowledgeNodeRecord): boolean {
  if (node.kind === 'ha_device' || node.kind === 'ha_integration') return true;
  return typeof node.metadata.manufacturer === 'string' || typeof node.metadata.model === 'string';
}

function mergeRefinementTaskIds(answer: HomeGraphAskResult, previousTaskIds: readonly string[] | undefined): HomeGraphAskResult {
  const ids = uniqueStrings([...(answer.answer.refinementTaskIds ?? []), ...(previousTaskIds ?? [])]);
  if (ids.length === (answer.answer.refinementTaskIds?.length ?? 0)) return answer;
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinementTaskIds: ids,
    },
  };
}

function taskIdsForGaps(store: KnowledgeStore, spaceId: string, gapIds: readonly string[]): readonly string[] {
  const wanted = new Set(gapIds);
  if (wanted.size === 0) return [];
  return store.listRefinementTasks(100, { spaceId })
    .filter((task) => task.gapId && wanted.has(task.gapId))
    .map((task) => task.id);
}

function scopeHomeGraphAnswerResults(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  results: readonly HomeGraphSearchResult[],
): readonly HomeGraphSearchResult[] {
  if (results.length === 0) return results;
  const scope = inferHomeAssistantAnswerScopeForQuery(store, spaceId, query);
  if (!scope || scope.anchorNodeIds.size === 0) return results;
  const scoped = results.filter((result) => {
    if (result.source) return sourceInHomeAssistantAnswerScope(store, result.source, scope);
    if (result.node) return nodeInHomeAssistantAnswerScope(result.node, scope);
    return false;
  });
  if (scoped.length > 0) return scoped;
  return [];
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

function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return {
    ...source,
    sourceId: source.id,
    url: source.sourceUri ?? source.canonicalUri,
  };
}
