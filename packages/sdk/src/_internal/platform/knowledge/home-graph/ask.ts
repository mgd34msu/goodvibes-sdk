import type { KnowledgeSemanticService } from '../semantic/index.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import type { HomeGraphSearchState } from './search.js';
import {
  inferHomeAssistantAnswerScopeForQuery,
  nodeInHomeAssistantAnswerScope,
  sourceInHomeAssistantAnswerScope,
} from '../semantic/homeassistant-scope.js';
import { uniqueStrings } from '../semantic/utils.js';
import { canonicalRepairSubjectNodes } from '../semantic/repair-subjects.js';

export async function answerHomeGraphQuery(input: {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
}): Promise<HomeGraphAskResult> {
  return answerHomeGraphQueryOnce(input);
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
  const linkedObjects = filterHomeGraphAnswerLinkedObjects(input.query.query, collectLinkedObjects(results, input.state));
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
      autoRepairGaps: true,
      timeoutMs: input.query.timeoutMs,
    });
    scheduleBackground(() => {
      void input.semanticService?.enrichSources(uniqueSources(sources), {
        knowledgeSpaceId: input.spaceId,
        limit: Math.min(3, Math.max(1, sources.length)),
      }).catch((error: unknown) => {
        logger.warn('Home Graph post-answer enrichment failed', {
          spaceId: input.spaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
        refinementTaskIds: answer.answer.refinementTaskIds,
        refinement: answer.answer.refinement,
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

function filterHomeGraphAnswerLinkedObjects(
  query: string,
  nodes: readonly KnowledgeNodeRecord[],
): KnowledgeNodeRecord[] {
  const canonical = canonicalRepairSubjectNodes({ nodes, text: query });
  if (canonical.length > 0) return canonical;
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(query);
  return uniqueNodes(nodes)
    .filter((node) => node.status !== 'stale')
    .filter((node) => !node.metadata.semanticKind)
    .filter((node) => !['fact', 'wiki_page', 'knowledge_gap', 'ha_device_passport'].includes(node.kind))
    .filter((node) => integrationIntent || node.kind !== 'ha_integration');
}

function uniqueNodes(nodes: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeNodeRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
  }
  return result;
}
