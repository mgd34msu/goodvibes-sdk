import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { belongsToSpace, edgeIsActive, isGeneratedPageSource, readRecord } from './helpers.js';
import { isUnusableHomeGraphExtractionText } from './extraction-quality.js';
import { buildSourceLinkIndex } from './source-links.js';
import { intersects, isSingularObjectQuery } from './search-utils.js';
import type { HomeGraphSearchResult } from './types.js';

const MAX_FIELD_CHARS = 4_096;
const MAX_SECTION_COUNT = 32;
const MAX_SEARCH_TEXT_CHARS = 64 * 1024;
const MAX_ANSWER_EXCERPT_CHARS = 640;
const ANCHOR_SCOPE_LIMIT = 5;

const STOPWORDS = new Set([
  'a',
  'about',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'available',
  'be',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'show',
  'tell',
  'that',
  'the',
  'this',
  'to',
  'use',
  'what',
  'which',
  'with',
]);

const SHORT_MEANINGFUL_TOKENS = new Set(['ac', 'av', 'dc', 'ha', 'ip', 'ir', 'lg', 'pc', 'tv']);

const GENERIC_ANCHOR_TOKENS = new Set([
  'area',
  'assistant',
  'automation',
  'calendar',
  'device',
  'entity',
  'graph',
  'home',
  'library',
  'living',
  'media',
  'media_player',
  'room',
  'sensor',
  'shows',
  'smart',
  'storage',
  'switch',
  'television',
  'tv',
]);

const QUERY_EXPANSIONS: Record<string, readonly string[]> = {
  capability: ['capabilities', 'feature', 'features', 'function', 'functions', 'mode', 'modes', 'spec', 'specs', 'support', 'supports'],
  capabilities: ['capability', 'feature', 'features', 'function', 'functions', 'mode', 'modes', 'spec', 'specs', 'support', 'supports'],
  feature: ['features', 'capability', 'capabilities', 'function', 'functions', 'mode', 'modes', 'spec', 'specs', 'support', 'supports'],
  features: ['feature', 'capability', 'capabilities', 'function', 'functions', 'mode', 'modes', 'spec', 'specs', 'support', 'supports'],
  television: ['tv', 'media_player'],
  tv: ['television', 'media_player'],
};

const SOURCE_EVIDENCE_TOKENS = new Set([
  'battery',
  'capabilities',
  'capability',
  'feature',
  'features',
  'manual',
  'model',
  'reset',
  'serial',
  'spec',
  'specs',
  'support',
  'supports',
  'warranty',
]);

const ANCHOR_INTENT_TOKENS = new Set([
  ...SOURCE_EVIDENCE_TOKENS,
  'function',
  'functions',
  'mode',
  'modes',
  'setup',
  'install',
  'configure',
  'documentation',
  'manual',
]);

const HOME_GRAPH_ANCHOR_KINDS = new Set([
  'ha_home',
  'ha_entity',
  'ha_device',
  'ha_area',
  'ha_automation',
  'ha_script',
  'ha_scene',
  'ha_label',
  'ha_integration',
  'ha_room',
  'ha_device_passport',
  'ha_maintenance_item',
  'ha_troubleshooting_case',
  'ha_purchase',
  'ha_network_node',
]);

const INTEGRATION_QUERY_TOKENS = new Set(['automation', 'automations', 'homeassistant', 'integration', 'integrations', 'webostv']);

export interface HomeGraphSearchState {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

export function readHomeGraphSearchState(store: KnowledgeStore, spaceId: string): HomeGraphSearchState {
  const sources = store.listSources(10_000).filter((source) => (
    belongsToSpace(source, spaceId) && !isGeneratedPageSource(source)
  ));
  const nodes = store.listNodes(10_000).filter((node) => belongsToSpace(node, spaceId) && node.status !== 'stale');
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = store.listEdges().filter((edge) => (
    edgeIsActive(edge)
    && belongsToSpace(edge, spaceId)
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
  ));
  const extractionBySourceId = new Map<string, KnowledgeExtractionRecord>();
  for (const extraction of store.listExtractions(10_000)) {
    if (!sourceIds.has(extraction.sourceId) && !belongsToSpace(extraction, spaceId)) continue;
    if (!extractionBySourceId.has(extraction.sourceId)) {
      extractionBySourceId.set(extraction.sourceId, extraction);
    }
  }
  return { spaceId, sources, nodes, edges, extractionBySourceId };
}

export function scoreHomeGraphResults(
  query: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number,
): HomeGraphSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const expandedTokens = expandTokens(tokens);
  const anchorTokens = selectAnchorQueryTokens(tokens);
  const anchors = selectAnchorNodes(anchorTokens, nodes);
  const sourceAnchors = selectSourceAnchors(anchorTokens, anchors.map((anchor) => anchor.node), isSingularObjectQuery(query, tokens));
  const anchorIds = new Set(sourceAnchors.map((node) => node.id));
  const anchorIdentityTokens = collectAnchorIdentityTokens(sourceAnchors);
  const sourceLinks = buildSourceLinkIndex(edges);
  const useAnchorScope = sourceAnchors.length > 0 && sourceAnchors.length <= ANCHOR_SCOPE_LIMIT;
  const objectScopedQuery = sourceAnchors.length > 0;
  const sourceEvidenceQuery = queryNeedsSourceEvidence(expandedTokens);
  const integrationQuery = queryMentionsIntegration(tokens);
  const sourceResults: HomeGraphSearchResult[] = sources.map((source) => {
    const extraction = extractionBySourceId(source.id);
    if (isPendingDocumentationCandidate(source, extraction)) {
      return sourceResult(source, extraction, 0);
    }
    if (sourceEvidenceQuery && !integrationQuery && isHomeAssistantIntegrationSource(source)) {
      return sourceResult(source, extraction, 0);
    }
    const linkedNodeIds = sourceLinks.get(source.id) ?? new Set<string>();
    const linkedToAnchor = useAnchorScope && intersects(linkedNodeIds, anchorIds);
    const anchorIdentityScore = objectScopedQuery
      ? sourceAnchorIdentityScore(anchorIdentityTokens, source, extraction)
      : 0;
    const identityScore = scoreFields(tokens, [
      source.title,
      source.summary,
      source.description,
      source.sourceUri,
      source.canonicalUri,
      source.tags.join(' '),
    ]);
    const contentScore = scoreFields(expandedTokens, [
      extraction?.title,
      extraction?.summary,
      extraction?.excerpt,
      readSearchText(extraction),
      ...limitedSections(extraction),
    ]);
    const baseScore = identityScore + contentScore;
    const linkBoost = linkedToAnchor ? 120 + relationBoost(source.id, anchorIds, edges) : 0;
    const inferredAnchorBoost = !linkedToAnchor && anchorIdentityScore > 0 ? Math.min(90, 30 + anchorIdentityScore) : 0;
    const manualBoost = isManualLikeSource(source) ? 24 : 0;
    const indexedBoost = source.status === 'indexed' ? 18 : source.status === 'stale' ? 6 : 0;
    const extractionBoost = extraction ? 20 : 0;
    const score = baseScore > 0 || linkBoost > 0 || inferredAnchorBoost > 0
      ? baseScore + linkBoost + inferredAnchorBoost + manualBoost + indexedBoost + extractionBoost
      : 0;
    return sourceResult(source, extraction, score, selectRelevantExcerpt(expandedTokens, source, extraction));
  });
  const nodeResults: HomeGraphSearchResult[] = nodes.map((node) => {
    const baseScore = scoreFields(tokens, nodeIdentityFields(node));
    const anchorBoost = anchorIds.has(node.id) ? 40 + nodeKindBoost(node.kind) : 0;
    return {
      kind: 'node' as const,
      id: node.id,
      score: baseScore > 0 ? baseScore + anchorBoost + Math.round(node.confidence / 20) : 0,
      title: node.title,
      summary: node.summary,
      excerpt: node.summary,
      node,
    };
  });
  let results = [...sourceResults, ...nodeResults]
    .filter((entry) => entry.score > 0)
    .sort(compareHomeGraphResults);
  const anchoredSourceResults = useAnchorScope
    ? results.filter((result) => {
        if (!result.source) return false;
        return intersects(sourceLinks.get(result.source.id) ?? new Set<string>(), anchorIds)
          || sourceAnchorIdentityScore(anchorIdentityTokens, result.source, extractionBySourceId(result.source.id)) > 0;
      })
    : [];
  if (anchoredSourceResults.length > 0) {
    results = anchoredSourceResults.sort(compareHomeGraphResults);
  }
  if (sourceEvidenceQuery) {
    results = pruneWeakSourceEvidence(results, tokens, sourceLinks, anchorIds, anchorIdentityTokens, objectScopedQuery, extractionBySourceId);
  }
  const strongResults = pruneWeakTokenCoverage(results, tokens);
  return strongResults.slice(0, Math.max(1, limit));
}

export function selectHomeGraphExtractionRepairCandidates(
  query: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number,
): KnowledgeSourceRecord[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  const anchors = selectAnchorNodes(tokens, nodes);
  const sourceAnchors = selectSourceAnchors(tokens, anchors.map((anchor) => anchor.node), isSingularObjectQuery(query, tokens));
  const anchorIds = new Set(sourceAnchors.map((anchor) => anchor.id));
  const anchorIdentityTokens = collectAnchorIdentityTokens(sourceAnchors);
  const sourceLinks = buildSourceLinkIndex(edges);
  return sources
    .map((source) => {
      if (!source.artifactId || !homeGraphExtractionNeedsRepair(extractionBySourceId(source.id))) return { source, score: 0 };
      const linkedNodeIds = sourceLinks.get(source.id) ?? new Set<string>();
      const linkedToAnchor = sourceAnchors.length > 0 && intersects(linkedNodeIds, anchorIds);
      const anchorIdentityScore = sourceAnchors.length > 0
        ? sourceAnchorIdentityScore(anchorIdentityTokens, source, extractionBySourceId(source.id))
        : 0;
      const identityScore = scoreFields(tokens, [
        source.title,
        source.summary,
        source.description,
        source.sourceUri,
        source.canonicalUri,
        source.tags.join(' '),
      ]);
      const sourceKindBoost = isManualLikeSource(source) ? 30 : 0;
      const score = linkedToAnchor
        ? 140 + relationBoost(source.id, anchorIds, edges) + sourceKindBoost + identityScore
        : identityScore > 0 || anchorIdentityScore > 0
          ? identityScore + anchorIdentityScore + sourceKindBoost
          : 0;
      return { source, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.source);
}

function sourceResult(
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
  score: number,
  excerpt?: string,
): HomeGraphSearchResult {
  return {
    kind: 'source',
    id: source.id,
    score,
    title: source.title ?? source.sourceUri ?? source.id,
    summary: usefulExtractionSummary(extraction) ?? source.summary,
    ...(excerpt ? { excerpt } : {}),
    source,
  };
}

function limitedSections(extraction: KnowledgeExtractionRecord | null | undefined): string[] {
  if (!extraction) return [];
  return extraction.sections.slice(0, MAX_SECTION_COUNT).map((section) => clampText(section, MAX_FIELD_CHARS));
}

function readSearchText(extraction: KnowledgeExtractionRecord | null | undefined): string | undefined {
  if (!extraction) return undefined;
  const structure = readRecord(extraction.structure);
  const metadata = readRecord(extraction.metadata);
  const text = firstBoundedText([
    structure.searchText,
    structure.text,
    structure.content,
    metadata.searchText,
  ], MAX_SEARCH_TEXT_CHARS);
  return isUnusableHomeGraphExtractionText(text) ? undefined : text;
}

function readNodeMetadataText(node: KnowledgeNodeRecord): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const values = [
    homeAssistant.objectKind,
    homeAssistant.objectId,
    homeAssistant.entityId,
    homeAssistant.deviceId,
    homeAssistant.areaId,
    homeAssistant.integrationId,
    node.metadata.manufacturer,
    node.metadata.model,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return values.length > 0 ? values.join(' ') : undefined;
}

function nodeIdentityFields(node: KnowledgeNodeRecord): string[] {
  return [
    node.title,
    node.summary,
    node.aliases.join(' '),
    readNodeMetadataText(node),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function collectAnchorIdentityTokens(nodes: readonly KnowledgeNodeRecord[]): string[] {
  const tokens = new Set<string>();
  for (const node of nodes) {
    for (const field of nodeIdentityFields(node)) {
      for (const token of tokenizeQuery(field)) {
        if (GENERIC_ANCHOR_TOKENS.has(token)) continue;
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function sourceAnchorIdentityScore(
  anchorTokens: readonly string[],
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
): number {
  if (anchorTokens.length === 0) return 0;
  return scoreFields(anchorTokens, [
    source.title,
    source.summary,
    source.description,
    source.sourceUri,
    source.canonicalUri,
    source.tags.join(' '),
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
    readSearchText(extraction),
  ]);
}

function selectAnchorNodes(tokens: readonly string[], nodes: readonly KnowledgeNodeRecord[]): Array<{ readonly node: KnowledgeNodeRecord; readonly score: number }> {
  if (tokens.length === 0) return [];
  const scored = nodes.map((node) => {
    if (!isHomeGraphAnchorNode(node)) return { node, score: 0 };
    const baseScore = scoreFields(tokens, nodeIdentityFields(node));
    const intentBoost = sourceAnchorIntentBoost(tokens, node);
    return {
      node,
      score: baseScore > 0 ? baseScore + nodeKindBoost(node.kind) + intentBoost : 0,
    };
  })
    .filter((entry) => entry.score >= 10)
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  const topScore = scored[0]?.score ?? 0;
  return scored
    .filter((entry) => entry.score >= Math.max(10, topScore - 12))
    .slice(0, 12);
}

function selectAnchorQueryTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !ANCHOR_INTENT_TOKENS.has(token));
}

function isHomeGraphAnchorNode(node: KnowledgeNodeRecord): boolean {
  if (typeof node.metadata.semanticKind === 'string') return false;
  return HOME_GRAPH_ANCHOR_KINDS.has(node.kind);
}

function selectSourceAnchors(
  tokens: readonly string[],
  nodes: readonly KnowledgeNodeRecord[],
  singularObjectQuery = false,
): KnowledgeNodeRecord[] {
  const preferred = nodes.filter((node) => sourceAnchorIntentBoost(tokens, node) >= 0);
  if (preferred.length > 0) return preferred.slice(0, singularObjectQuery ? 1 : ANCHOR_SCOPE_LIMIT);
  return nodes.slice(0, ANCHOR_SCOPE_LIMIT);
}

function sourceAnchorIntentBoost(tokens: readonly string[], node: KnowledgeNodeRecord): number {
  const metadata = readRecord(node.metadata);
  const homeAssistant = readRecord(metadata.homeAssistant);
  const domain = typeof metadata.domain === 'string' ? metadata.domain.toLowerCase() : '';
  const platform = typeof metadata.platform === 'string' ? metadata.platform.toLowerCase() : '';
  const objectKind = typeof homeAssistant.objectKind === 'string' ? homeAssistant.objectKind.toLowerCase() : '';
  const text = nodeIdentityFields(node).join(' ').toLowerCase();
  const tvQuery = tokens.some((token) => token === 'tv' || token === 'television' || token === 'media_player');
  if (tvQuery) {
    if (node.kind === 'ha_device' && /\b(tv|television|webos|bravia)\b/.test(text)) return 80;
    if (node.kind === 'ha_entity' && (domain === 'media_player' || platform === 'webostv')) return 70;
    if (node.kind === 'ha_integration' && (platform === 'webostv' || text.includes('webos'))) return 40;
    if (domain === 'calendar' || domain === 'sensor' || domain === 'automation' || domain === 'switch'
      || objectKind === 'automation' || node.kind === 'ha_automation') return -80;
  }
  if (node.kind === 'ha_device') return 30;
  if (node.kind === 'ha_entity') return 10;
  if (node.kind === 'ha_integration' && queryMentionsIntegration(tokens)) return 8;
  return node.kind === 'ha_integration' ? -10 : 0;
}

function relationBoost(sourceId: string, anchorIds: ReadonlySet<string>, edges: readonly KnowledgeEdgeRecord[]): number {
  let boost = 0;
  for (const edge of edges) {
    const connectsAnchor = (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node' && anchorIds.has(edge.toId))
      || (edge.fromKind === 'node' && anchorIds.has(edge.fromId) && edge.toKind === 'source' && edge.toId === sourceId);
    if (!connectsAnchor) continue;
    if (edge.relation === 'has_manual') boost = Math.max(boost, 45);
    else if (edge.relation === 'source_for') boost = Math.max(boost, 25);
    else boost = Math.max(boost, 15);
  }
  return boost;
}

function nodeKindBoost(kind: string): number {
  switch (kind) {
    case 'ha_device':
    case 'ha_entity':
      return 20;
    case 'ha_area':
    case 'ha_room':
    case 'ha_automation':
    case 'ha_script':
    case 'ha_scene':
      return 12;
    case 'ha_integration':
      return 6;
    default:
      return 0;
  }
}

function isPendingDocumentationCandidate(
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
): boolean {
  return !extraction
    && source.status !== 'indexed'
    && source.metadata.homeGraphSourceKind === 'documentation-candidate';
}

export function homeGraphExtractionNeedsRepair(extraction: KnowledgeExtractionRecord | null | undefined): boolean {
  if (!extraction) return true;
  if (extraction.format === 'pdf' && extraction.extractorId === 'pdf') return true;
  const searchText = readSearchText(extraction);
  if (searchText && searchText.trim().length > 0) return false;
  if ((extraction.excerpt?.trim() && !isLowInformationExtractionText(extraction.excerpt))
    || (extraction.summary?.trim() && !isLowInformationExtractionText(extraction.summary))
    || extraction.sections.some((section) => section.trim() && !isLowInformationExtractionText(section))) {
    return false;
  }
  return true;
}

function queryNeedsSourceEvidence(tokens: readonly string[]): boolean {
  return tokens.some((token) => SOURCE_EVIDENCE_TOKENS.has(token));
}

function queryMentionsIntegration(tokens: readonly string[]): boolean {
  return tokens.some((token) => INTEGRATION_QUERY_TOKENS.has(token));
}

function isManualLikeSource(source: KnowledgeSourceRecord): boolean {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  return source.sourceType === 'manual'
    || source.sourceType === 'document'
    || source.sourceType === 'url'
    || tags.includes('manual')
    || tags.includes('artifact')
    || tags.includes('document');
}

function isHomeAssistantIntegrationSource(source: KnowledgeSourceRecord): boolean {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  const sourceKind = typeof source.metadata.homeGraphSourceKind === 'string'
    ? source.metadata.homeGraphSourceKind.toLowerCase()
    : '';
  return tags.includes('integration')
    || tags.includes('documentation')
    || sourceKind === 'documentation-candidate';
}

function pruneWeakSourceEvidence(
  results: readonly HomeGraphSearchResult[],
  tokens: readonly string[],
  sourceLinks: ReadonlyMap<string, ReadonlySet<string>>,
  anchorIds: ReadonlySet<string>,
  anchorIdentityTokens: readonly string[],
  objectScopedQuery: boolean,
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
): HomeGraphSearchResult[] {
  const sourceResults = results.filter((result) => result.source);
  if (sourceResults.length === 0) return [...results];
  const strongSourceResults = sourceResults.filter((result) => {
    const source = result.source;
    if (!source) return false;
    if (!hasUsefulSourceAnswerText(result)) return false;
    const linkedToAnchor = intersects(sourceLinks.get(source.id) ?? new Set<string>(), anchorIds);
    const matchesAnchorIdentity = sourceAnchorIdentityScore(anchorIdentityTokens, source, extractionBySourceId(source.id)) > 0;
    const coverage = tokenCoverage(tokens, resultText(result));
    return linkedToAnchor
      || (matchesAnchorIdentity && coverage >= 1)
      || (!objectScopedQuery && coverage >= Math.min(2, tokens.length));
  });
  return strongSourceResults;
}

function hasUsefulSourceAnswerText(result: HomeGraphSearchResult): boolean {
  const detail = result.excerpt ?? result.summary ?? result.source?.description;
  return typeof detail === 'string' && detail.trim().length > 0 && !isLowInformationExtractionText(detail);
}

function selectRelevantExcerpt(
  tokens: readonly string[],
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
): string | undefined {
  const chunks = candidateExcerptChunks(tokens, source, extraction);
  let best: { readonly score: number; readonly text: string } | undefined;
  for (const chunk of chunks) {
    const text = cleanWhitespace(chunk);
    if (!text || isLowInformationExtractionText(text)) continue;
    const score = scoreFields(tokens, [text]);
    if (!best || score > best.score || (score === best.score && text.length < best.text.length)) {
      best = { score, text };
    }
  }
  if (!best || best.score <= 0) {
    return firstBoundedText(chunks.filter((chunk) => !isLowInformationExtractionText(chunk)), MAX_ANSWER_EXCERPT_CHARS);
  }
  return clampAroundBestToken(best.text, tokens, MAX_ANSWER_EXCERPT_CHARS);
}

function candidateExcerptChunks(
  tokens: readonly string[],
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
): string[] {
  const searchText = readSearchText(extraction);
  return [
    extraction?.excerpt,
    extraction?.summary,
    ...limitedSections(extraction),
    ...searchTextWindows(tokens, searchText),
    ...sentenceChunks(searchText),
    source.description,
    source.summary,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function usefulExtractionSummary(extraction: KnowledgeExtractionRecord | null | undefined): string | undefined {
  const summary = extraction?.summary?.trim();
  return summary && !isLowInformationExtractionText(summary) ? summary : undefined;
}

function isLowInformationExtractionText(value: string): boolean {
  return isUnusableHomeGraphExtractionText(value);
}

function sentenceChunks(value: string | undefined): string[] {
  const text = cleanWhitespace(value ?? '');
  if (!text) return [];
  const matches = text.match(/[^.!?\n]+[.!?]?/g) ?? [text];
  return matches.map((entry) => entry.trim()).filter(Boolean).slice(0, 80);
}

function searchTextWindows(tokens: readonly string[], value: string | undefined): string[] {
  const text = cleanWhitespace(value ?? '');
  if (!text) return [];
  const lower = text.toLowerCase();
  const windows: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase());
    if (index < 0) continue;
    const start = Math.max(0, index - Math.floor(MAX_ANSWER_EXCERPT_CHARS / 3));
    const end = Math.min(text.length, start + MAX_ANSWER_EXCERPT_CHARS);
    const window = `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
    if (window && !seen.has(window)) {
      seen.add(window);
      windows.push(window);
    }
  }
  return windows;
}

function clampAroundBestToken(value: string, tokens: readonly string[], maxLength: number): string {
  const text = cleanWhitespace(value);
  if (text.length <= maxLength) return text;
  const lower = text.toLowerCase();
  const index = tokens
    .map((token) => lower.indexOf(token.toLowerCase()))
    .filter((entry) => entry >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, index - Math.floor(maxLength / 3));
  const end = Math.min(text.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pruneWeakTokenCoverage(
  results: readonly HomeGraphSearchResult[],
  tokens: readonly string[],
): HomeGraphSearchResult[] {
  if (results.length <= 1 || tokens.length <= 1) return [...results];
  const topCoverage = tokenCoverage(tokens, resultText(results[0]!));
  if (topCoverage < 2) return [...results];
  return results.filter((result) => tokenCoverage(tokens, resultText(result)) >= Math.max(1, topCoverage - 1));
}

function tokenCoverage(tokens: readonly string[], text: string): number {
  const haystack = text.toLowerCase();
  let count = 0;
  for (const token of tokens) {
    if (fieldIncludesToken(haystack, token)) count += 1;
  }
  return count;
}

function resultText(result: HomeGraphSearchResult): string {
  return [
    result.title,
    result.summary,
    result.excerpt,
    result.source?.description,
    result.source?.sourceUri,
    result.source?.canonicalUri,
    result.source?.tags.join(' '),
  ].filter((value): value is string => typeof value === 'string').join(' ');
}

function firstBoundedText(values: readonly unknown[], maxLength: number): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    return clampText(trimmed, maxLength);
  }
  return undefined;
}

function clampText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function tokenizeQuery(value: string): string[] {
  const tokens = value.toLowerCase()
    .split(/[^a-z0-9_.:-]+/)
    .map((entry) => entry.trim())
    .filter((entry) => isMeaningfulToken(entry));
  return [...new Set(tokens)];
}

function expandTokens(tokens: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    for (const synonym of QUERY_EXPANSIONS[token] ?? []) {
      expanded.add(synonym);
    }
  }
  return [...expanded];
}

function isMeaningfulToken(token: string): boolean {
  if (!token || STOPWORDS.has(token)) return false;
  if (token.length === 1) return false;
  if (token.length <= 2 && !SHORT_MEANINGFUL_TOKENS.has(token)) return false;
  return true;
}

function scoreFields(tokens: readonly string[], fields: readonly (string | undefined)[]): number {
  let score = 0;
  for (const field of fields) {
    const raw = typeof field === 'string' ? field.trim() : '';
    const haystack = clampText(raw, MAX_SEARCH_TEXT_CHARS).toLowerCase();
    if (!haystack) continue;
    for (const token of tokens) {
      if (fieldIncludesToken(haystack, token)) score += token.length <= 3 ? 14 : 10;
    }
  }
  return score;
}

function fieldIncludesToken(haystack: string, token: string): boolean {
  if (token.length <= 3 || token.includes('_') || token.includes('-')) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(token)}(?:$|[^a-z0-9])`).test(haystack);
  }
  return haystack.includes(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareHomeGraphResults(left: HomeGraphSearchResult, right: HomeGraphSearchResult): number {
  return right.score - left.score
    || resultKindPriority(right) - resultKindPriority(left)
    || left.id.localeCompare(right.id);
}

function resultKindPriority(result: HomeGraphSearchResult): number {
  if (result.source) return 2;
  if (result.node) return 1;
  return 0;
}
