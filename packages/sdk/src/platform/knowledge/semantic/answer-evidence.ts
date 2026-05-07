import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeSearchResult,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  getExplicitKnowledgeSpaceId,
  isHomeAssistantKnowledgeSpace,
  normalizeKnowledgeSpaceId,
} from '../spaces.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type { KnowledgeSemanticAnswerInput } from './types.js';
import {
  clampText,
  normalizeWhitespace,
  readRecord,
  readString,
  readStringArray,
  scoreSemanticText,
  sourceSemanticText,
  splitSentences,
  tokenizeSemanticQuery,
  uniqueStrings,
} from './utils.js';
import {
  isLowValueFeatureOrSpecText,
  isSemanticAnswerLinkedObject,
} from './fact-quality.js';
import {
  inferAnswerObjectScope,
  nodeInAnswerObjectScope,
  sourceInAnswerObjectScope,
} from './object-scope.js';
import { canonicalRepairSubjectNodes } from './repair-subjects.js';
import { sourceAuthorityBoostForAnswer } from './answer-source-ranking.js';
import {
  GENERIC_ANSWER_INTENT_TOKENS,
  isBroadKnowledgeSpaceAlias,
  type EvidenceItem,
} from './answer-common.js';
import {
  factIntent,
  filterFactsForQuery,
  hasFeatureIntent,
  renderFactForPrompt,
  renderFactForScoring,
  renderNodeEvidence,
  semanticKindBoost,
} from './answer-fact-selection.js';

export function collectAnswerEvidence(
  store: KnowledgeStore,
  input: KnowledgeSemanticAnswerInput,
  spaceId: string,
  limit: number,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): EvidenceItem[] {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(input.query));
  if (tokens.length === 0) return [];
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  const candidateSourceIds = new Set(input.candidateSourceIds ?? []);
  const candidateNodeIds = new Set(input.candidateNodeIds ?? []);
  const linkedObjectIds = new Set((input.linkedObjects ?? []).map((node) => node.id));
  const strictCandidates = input.strictCandidates === true && (candidateSourceIds.size > 0 || candidateNodeIds.size > 0);
  const answerSources = listAnswerSources(store, spaceId).filter(isUsableAnswerSource);
  const usableSourceIds = new Set(answerSources.map((source) => source.id));
  const sourceFacts = buildSourceFactIndex(store, spaceId, usableSourceIds);
  const linkedSourceIds = sourceIdsLinkedToNodes(store, new Set([...candidateNodeIds, ...linkedObjectIds]), spaceId);
  const broadNamespaceAlias = isBroadKnowledgeSpaceAlias(spaceId) && !strictCandidates;
  if (broadNamespaceAlias && subjectTokens.length === 0 && linkedObjectIds.size === 0) return [];
  const objectScope = !strictCandidates
    ? inferAnswerObjectScope(store, spaceId, input.query, subjectTokens, objectProfiles)
    : null;

  const sourceItems = answerSources
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceInAnswerObjectScope(store, source, objectScope))
    .filter((source) => !strictCandidates || candidateSourceIds.has(source.id) || linkedSourceIds.has(source.id))
    .map((source) => {
      const extraction = store.getExtractionBySourceId(source.id);
      const facts = filterFactsForQuery(input.query, sourceFacts.get(source.id) ?? []);
      const text = sourceSemanticText(source, extraction);
      const scoringText = [
        source.title,
        source.summary,
        source.description,
        source.tags.join(' '),
        text,
        facts.map(renderFactForScoring).join(' '),
      ].join('\n');
      const baseScore = scoreSemanticText(scoringText, tokens);
      const subjectScore = subjectTokens.length > 0 ? scoreSemanticText(scoringText, subjectTokens) : 0;
      const namespaceAliasPenalty = broadNamespaceAlias && subjectScore === 0 ? 120 : 0;
      const candidateBoost = candidateSourceIds.has(source.id) ? 220 : 0;
      const linkedBoost = linkedSourceIds.has(source.id) ? 160 : 0;
      const genericOnly = subjectTokens.length > 0 && subjectScore === 0;
      const offSubjectStrictCandidate = strictCandidates
        && candidateSourceIds.size > 1
        && candidateSourceIds.has(source.id)
        && !linkedSourceIds.has(source.id)
        && genericOnly;
      const offSubjectBroadMatch = !strictCandidates && genericOnly;
      const score = offSubjectStrictCandidate || offSubjectBroadMatch
        ? 0
        : baseScore + candidateBoost + linkedBoost + Math.min(60, facts.length * 6) - namespaceAliasPenalty;
      return {
        kind: 'source' as const,
        id: source.id,
        title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
        score,
        source,
        excerpt: selectEvidenceExcerpt(input.query, text, facts),
        facts,
      };
    });

  const nodeItems = listAnswerNodes(store, spaceId)
    .filter((node) => belongsToAnswerSpace(node, spaceId) && node.status !== 'stale')
    .filter((node) => node.metadata.semanticKind !== 'fact' || factHasUsableSource(node, usableSourceIds))
    .filter((node) => nodeInAnswerObjectScope(node, objectScope))
    .filter((node) => !strictCandidates
      || candidateNodeIds.has(node.id)
      || linkedObjectIds.has(node.id)
      || (typeof node.sourceId === 'string' && candidateSourceIds.has(node.sourceId)))
    .map((node) => {
      const scoringText = [
        node.title,
        node.summary,
        node.aliases.join(' '),
        JSON.stringify(node.metadata),
      ].join('\n');
      const baseScore = scoreSemanticText(scoringText, tokens);
      const subjectScore = subjectTokens.length > 0 ? scoreSemanticText(scoringText, subjectTokens) : 0;
      const namespaceAliasPenalty = broadNamespaceAlias && subjectScore === 0 ? 100 : 0;
      const genericOnly = subjectTokens.length > 0 && subjectScore === 0;
      const candidateOrLinked = candidateNodeIds.has(node.id) || linkedObjectIds.has(node.id);
      const score = genericOnly && !candidateOrLinked
        ? 0
        : baseScore + (candidateOrLinked ? 120 : 0) + semanticKindBoost(node) - namespaceAliasPenalty;
      return {
        kind: 'node' as const,
        id: node.id,
        title: node.title,
        score,
        node,
        excerpt: renderNodeEvidence(node),
        facts: node.metadata.semanticKind === 'fact' ? [node] : [],
      };
    });

  const items = [...sourceItems, ...nodeItems]
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return pruneEvidence(items, limit, broadNamespaceAlias);
}

export function inferObjectLinkedObjects(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): KnowledgeNodeRecord[] {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const subjectTokens = tokens.filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  const scope = inferAnswerObjectScope(store, spaceId, query, subjectTokens, objectProfiles);
  if (!scope || scope.anchorNodeIds.size === 0) return [];
  return listAnswerNodes(store, spaceId)
    .filter((node) => scope.anchorNodeIds.has(node.id))
    .filter((node) => belongsToAnswerSpace(node, spaceId))
    .filter(isSemanticAnswerLinkedObject);
}

export function filterAnswerLinkedObjects(
  spaceId: string,
  query: string,
  nodes: readonly KnowledgeNodeRecord[],
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): readonly KnowledgeNodeRecord[] {
  const canonical = canonicalRepairSubjectNodes({ nodes, text: query, objectProfiles });
  if (canonical.length > 0) return canonical.slice(0, 24);
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(query);
  return nodes.filter((node) => integrationIntent || !/integration/i.test(node.kind)).slice(0, 24);
}

export function shouldUseEvidenceLinkedObjects(
  spaceId: string,
  input: KnowledgeSemanticAnswerInput,
  inferredObjectLinkedObjects: readonly KnowledgeNodeRecord[],
): boolean {
  if (input.linkedObjects?.length) return true;
  if (isBroadKnowledgeSpaceAlias(spaceId) || isHomeAssistantKnowledgeSpace(normalizeKnowledgeSpaceId(spaceId))) {
    return inferredObjectLinkedObjects.length > 0;
  }
  return true;
}

export function includeOfficialLinkedSources(
  store: KnowledgeStore,
  spaceId: string,
  rankedSources: readonly KnowledgeSourceRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly KnowledgeSourceRecord[] {
  if (linkedObjects.length === 0) return rankedSources;
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const linkedSourceIds = sourceIdsLinkedToNodes(store, linkedIds, spaceId);
  const official = listAnswerSources(store, spaceId)
    .filter(isUsableAnswerSource)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceAuthorityBoostForAnswer(source) > 0)
    .filter((source) => {
      const discovery = readRecord(source.metadata.sourceDiscovery);
      return linkedSourceIds.has(source.id)
        || readStringArray(discovery.linkedObjectIds).some((id) => linkedIds.has(id));
    })
    .sort((left, right) => sourceAuthorityBoostForAnswer(right) - sourceAuthorityBoostForAnswer(left));
  return uniqueSources([...official, ...rankedSources]);
}

export function includeOfficialLinkedEvidence(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  evidence: readonly EvidenceItem[],
  linkedObjects: readonly KnowledgeNodeRecord[],
  limit: number,
): EvidenceItem[] {
  if (linkedObjects.length === 0) return [...evidence];
  const linkedIds = new Set(linkedObjects.map((node) => node.id));
  const linkedSourceIds = sourceIdsLinkedToNodes(store, linkedIds, spaceId);
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const usableSourceIds = new Set(listAnswerSources(store, spaceId).filter(isUsableAnswerSource).map((source) => source.id));
  const sourceFacts = buildSourceFactIndex(store, spaceId, usableSourceIds);
  const officialItems = listAnswerSources(store, spaceId)
    .filter(isUsableAnswerSource)
    .filter((source) => belongsToAnswerSpace(source, spaceId))
    .filter((source) => sourceAuthorityBoostForAnswer(source) > 0)
    .filter((source) => linkedSourceIds.has(source.id) || readStringArray(readRecord(source.metadata.sourceDiscovery).linkedObjectIds).some((id) => linkedIds.has(id)))
    .map((source) => {
      const extraction = store.getExtractionBySourceId(source.id);
      const facts = filterFactsForQuery(query, sourceFacts.get(source.id) ?? []);
      const text = sourceSemanticText(source, extraction);
      const scoringText = [
        source.title,
        source.summary,
        source.description,
        source.tags.join(' '),
        text,
        facts.map(renderFactForScoring).join(' '),
      ].join('\n');
      const semanticScore = scoreSemanticText(scoringText, tokens);
      return {
        kind: 'source' as const,
        id: source.id,
        title: source.title ?? source.canonicalUri ?? source.sourceUri ?? source.id,
        score: semanticScore + sourceAuthorityBoostForAnswer(source) + Math.min(80, facts.length * 10),
        source,
        excerpt: selectEvidenceExcerpt(query, text, facts),
        facts,
      };
    })
    .filter((item) => item.score > 0);
  if (officialItems.length === 0) return [...evidence];
  return uniqueEvidenceItems([...officialItems, ...evidence]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)))
    .slice(0, Math.max(limit, evidence.length, 1));
}

export function toSearchResult(item: EvidenceItem): KnowledgeSearchResult {
  return {
    kind: item.kind,
    id: item.id,
    score: item.score,
    reason: 'semantic evidence match',
    ...(item.source ? { source: item.source } : {}),
    ...(item.node ? { node: item.node } : {}),
  };
}

export function uniqueNodes(nodes: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const out: KnowledgeNodeRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

export function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return {
    ...source,
    sourceId: source.id,
    url: source.sourceUri ?? source.canonicalUri,
  };
}

function buildSourceFactIndex(
  store: KnowledgeStore,
  spaceId: string,
  usableSourceIds: ReadonlySet<string>,
): Map<string, KnowledgeNodeRecord[]> {
  const facts = listAnswerNodes(store, spaceId).filter((node) => (
    node.status !== 'stale' && node.metadata.semanticKind === 'fact' && belongsToAnswerSpace(node, spaceId)
  ));
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const bySource = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of facts) {
    for (const sourceId of factSourceIds(fact)) {
      addSourceFact(bySource, usableSourceIds, sourceId, fact);
    }
  }
  for (const edge of store.listEdges()) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const fact = factsById.get(edge.toId);
    if (!fact) continue;
    addSourceFact(bySource, usableSourceIds, edge.fromId, fact);
  }
  return bySource;
}

function factHasUsableSource(node: KnowledgeNodeRecord, usableSourceIds: ReadonlySet<string>): boolean {
  return factSourceIds(node).some((sourceId) => usableSourceIds.has(sourceId));
}

function factSourceIds(fact: KnowledgeNodeRecord): string[] {
  return uniqueStrings([
    ...readStringArray(fact.metadata.sourceIds),
    readString(fact.metadata.sourceId),
    fact.sourceId,
  ]);
}

function addSourceFact(
  bySource: Map<string, KnowledgeNodeRecord[]>,
  usableSourceIds: ReadonlySet<string>,
  sourceId: string | undefined,
  fact: KnowledgeNodeRecord,
): void {
  if (!sourceId || !usableSourceIds.has(sourceId)) return;
  const existing = bySource.get(sourceId) ?? [];
  if (existing.some((entry) => entry.id === fact.id)) return;
  bySource.set(sourceId, [...existing, fact]);
}

function isUsableAnswerSource(source: KnowledgeSourceRecord): boolean {
  return source.status === 'indexed';
}

function listAnswerSources(store: KnowledgeStore, spaceId: string): KnowledgeSourceRecord[] {
  const sources = isBroadKnowledgeSpaceAlias(spaceId)
    ? store.listSources(Number.MAX_SAFE_INTEGER)
    : store.listSourcesInSpace(spaceId);
  return sources.filter((source) => source.status !== 'stale');
}

function listAnswerNodes(store: KnowledgeStore, spaceId: string): KnowledgeNodeRecord[] {
  const nodes = isBroadKnowledgeSpaceAlias(spaceId)
    ? store.listNodes(Number.MAX_SAFE_INTEGER)
    : store.listNodesInSpace(spaceId);
  return nodes.filter((node) => node.status !== 'stale');
}

function sourceIdsLinkedToNodes(store: KnowledgeStore, nodeIds: ReadonlySet<string>, spaceId: string): Set<string> {
  const sourceIds = new Set<string>();
  if (nodeIds.size === 0) return sourceIds;
  const usableSourceIds = new Set(listAnswerSources(store, spaceId).map((source) => source.id));
  const edges = store.listEdges();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId) && usableSourceIds.has(edge.fromId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source' && usableSourceIds.has(edge.toId)) sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && nodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (!belongsToAnswerSpace(edge, spaceId)) continue;
    if (edge.fromKind === 'source'
      && edge.toKind === 'node'
      && factIds.has(edge.toId)
      && edge.relation === 'supports_fact'
      && usableSourceIds.has(edge.fromId)) {
      sourceIds.add(edge.fromId);
    }
  }
  return sourceIds;
}

function edgeIsActive(edge: { readonly weight: number; readonly metadata: Record<string, unknown> }): boolean {
  return isActiveKnowledgeEdge(edge);
}

function selectEvidenceExcerpt(
  query: string,
  text: string,
  facts: readonly KnowledgeNodeRecord[],
): string {
  const tokens = expandQueryTokens(tokenizeSemanticQuery(query));
  const intent = factIntent(tokenizeSemanticQuery(query));
  const featureIntent = Boolean(intent && hasFeatureIntent(intent));
  const evidenceText = stripEvidenceRoutingFragments(text);
  const factLines = facts
    .map(renderFactForPrompt)
    .filter((line) => scoreSemanticText(line, tokens) > 0)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 12);
  const windows = evidenceWindows(evidenceText, tokens)
    .filter((line) => !featureIntent || !isLowValueFeatureOrSpecText(line))
    .slice(0, 4);
  const fallback = featureIntent && (factLines.length > 0 || windows.length > 0) ? [] : [clampText(evidenceText, 720)];
  return uniqueStrings([...factLines, ...windows, ...fallback]).join('\n');
}

function stripEvidenceRoutingFragments(text: string): string {
  return normalizeWhitespace(text
    .replace(/homegraph:\/\/\S+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bsemantic-gap-repair\b/gi, ' ')
    .replace(/\bgenerated-page\b/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|dev|tv|ca|co\.uk)(?:\/\S*)?/gi, ' '));
}

function evidenceWindows(text: string, tokens: readonly string[]): string[] {
  const normalized = normalizeWhitespace(text);
  const sentences = splitSentences(normalized, 420);
  const sentenceMatches = sentences.filter((sentence) => scoreSemanticText(sentence, tokens) > 0);
  if (sentenceMatches.length > 0) return uniqueStrings(sentenceMatches).slice(0, 12);
  const lower = normalized.toLowerCase();
  const windows: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) continue;
    const index = lower.indexOf(token);
    if (index < 0) continue;
    const start = Math.max(0, normalized.lastIndexOf('.', index - 1) + 1, index - 160);
    const nextPeriod = normalized.indexOf('.', index + token.length);
    const end = nextPeriod >= 0 ? Math.min(normalized.length, nextPeriod + 1) : Math.min(normalized.length, index + 360);
    windows.push(`${start > 0 ? '...' : ''}${normalized.slice(start, end).trim()}${end < normalized.length ? '...' : ''}`);
  }
  return uniqueStrings(windows);
}

function expandQueryTokens(tokens: readonly string[]): string[] {
  const expansions: Record<string, readonly string[]> = {
    capabilities: ['capability', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    capability: ['capabilities', 'feature', 'features', 'function', 'functions', 'supports', 'specifications'],
    feature: ['features', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    features: ['feature', 'capability', 'capabilities', 'function', 'functions', 'supports', 'specifications'],
    settings: ['configuration', 'configure', 'options'],
    setup: ['install', 'configure', 'pair'],
  };
  return uniqueStrings(tokens.flatMap((token) => [token, ...(expansions[token] ?? [])]));
}

function pruneEvidence(items: readonly EvidenceItem[], limit: number, strictTopCluster = false): EvidenceItem[] {
  const sourceSeen = new Set<string>();
  const nodeSeen = new Set<string>();
  const out: EvidenceItem[] = [];
  const topScore = items[0]?.score ?? 0;
  const minScore = strictTopCluster ? Math.max(1, topScore - 90) : 1;
  for (const item of items) {
    if (item.score < minScore) continue;
    if (item.kind === 'source') {
      if (sourceSeen.has(item.id)) continue;
      sourceSeen.add(item.id);
    } else {
      if (nodeSeen.has(item.id)) continue;
      nodeSeen.add(item.id);
    }
    out.push(item);
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

function belongsToAnswerSpace(
  record: { readonly metadata?: Record<string, unknown> } | undefined | null,
  spaceId: string,
): boolean {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const explicitSpaceId = getExplicitKnowledgeSpaceId(record);
  if (!explicitSpaceId) return false;
  const recordSpaceId = normalizeKnowledgeSpaceId(explicitSpaceId);
  if (normalized === 'default') return recordSpaceId === 'default';
  if (normalized === 'homeassistant') return isHomeAssistantKnowledgeSpace(recordSpaceId);
  return recordSpaceId === normalized;
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

function uniqueEvidenceItems(items: readonly EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
