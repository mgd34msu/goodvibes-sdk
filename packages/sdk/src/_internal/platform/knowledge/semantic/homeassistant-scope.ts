import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { readRecord, readString, scoreSemanticText, sourceSemanticText, tokenizeSemanticQuery, uniqueStrings } from './utils.js';

export interface HomeAssistantAnswerScope {
  readonly anchorNodeIds: ReadonlySet<string>;
  readonly linkedSourceIds: ReadonlySet<string>;
  readonly anchorText: readonly string[];
}

export function inferHomeAssistantAnswerScopeForQuery(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
): HomeAssistantAnswerScope | null {
  const subjectTokens = tokenizeSemanticQuery(query)
    .filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  return inferHomeAssistantAnswerScope(store, spaceId, query, subjectTokens);
}

export function inferHomeAssistantAnswerScope(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  subjectTokens: readonly string[],
): HomeAssistantAnswerScope | null {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (normalized !== 'homeassistant' && !isHomeAssistantKnowledgeSpace(normalized)) return null;
  const queryTokens = tokenizeSemanticQuery(query);
  if (subjectTokens.length === 0 && queryTokens.length === 0) return null;
  const singularObjectQuery = isSingularObjectQuery(query, queryTokens);
  const strongIdentityTokens = subjectTokens.filter(isStrongIdentityToken);
  if (!singularObjectQuery && strongIdentityTokens.length === 0) return null;
  if (singularObjectQuery && strongIdentityTokens.length === 0 && !hasSpecificObjectTypeToken(queryTokens)) return null;
  const linkedSourceQualityByNode = linkedSourceQualityByAnchor(store);
  const anchorTokens = uniqueStrings([...subjectTokens, ...queryTokens]);

  const anchors = store.listNodes(10_000)
    .filter((node) => node.status !== 'stale' && isHomeAssistantObjectNode(node))
    .filter((node) => normalized === 'homeassistant' || normalizeKnowledgeSpaceId(getKnowledgeSpaceId(node)) === normalized)
    .map((node) => ({
      node,
      score: scoreHomeAssistantObject(node, anchorTokens)
        + Math.min(64, linkedSourceQualityByNode.get(node.id) ?? 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));

  const topScore = anchors[0]?.score ?? 0;
  if (topScore <= 0) return null;
  const selectedAnchors = anchors
    .filter((entry) => entry.score >= Math.max(1, topScore - 12))
    .slice(0, singularObjectQuery ? 1 : 8);
  const anchorNodeIds = new Set(selectedAnchors.map((entry) => entry.node.id));
  const linkedSourceIds = sourceIdsLinkedToAnchors(store, anchorNodeIds);
  const anchorText = selectedAnchors.map((entry) => homeAssistantObjectText(entry.node));
  return { anchorNodeIds, linkedSourceIds, anchorText };
}

export function sourceInHomeAssistantAnswerScope(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  scope: HomeAssistantAnswerScope | null,
): boolean {
  if (!scope || scope.anchorNodeIds.size === 0) return true;
  if (scope.linkedSourceIds.has(source.id)) return true;
  const extraction = store.getExtractionBySourceId(source.id);
  const text = sourceSemanticText(source, extraction);
  return scope.anchorText.some((anchor) => sourceMatchesAnchor(text, anchor));
}

export function nodeInHomeAssistantAnswerScope(
  node: KnowledgeNodeRecord,
  scope: HomeAssistantAnswerScope | null,
): boolean {
  if (!scope || scope.anchorNodeIds.size === 0) return true;
  if (scope.anchorNodeIds.has(node.id)) return true;
  const sourceId = readString(node.metadata.sourceId) ?? node.sourceId;
  return Boolean(sourceId && scope.linkedSourceIds.has(sourceId));
}

function sourceIdsLinkedToAnchors(store: KnowledgeStore, anchorNodeIds: ReadonlySet<string>): Set<string> {
  const sourceIds = new Set<string>();
  if (anchorNodeIds.size === 0) return sourceIds;
  const edges = store.listEdges();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (edge.fromKind === 'source' && edge.toKind === 'node' && anchorNodeIds.has(edge.toId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && anchorNodeIds.has(edge.fromId) && edge.toKind === 'source') sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && anchorNodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (edge.fromKind === 'source' && edge.toKind === 'node' && factIds.has(edge.toId) && edge.relation === 'supports_fact') {
      sourceIds.add(edge.fromId);
    }
  }
  return sourceIds;
}

function linkedSourceQualityByAnchor(store: KnowledgeStore): Map<string, number> {
  const sourcesById = new Map(store.listSources(10_000).map((source) => [source.id, source]));
  const scores = new Map<string, number>();
  for (const edge of store.listEdges()) {
    const source = edge.fromKind === 'source'
      ? sourcesById.get(edge.fromId)
      : edge.toKind === 'source'
        ? sourcesById.get(edge.toId)
        : undefined;
    if (!source) continue;
    const score = linkedSourceQuality(source, edge.relation);
    if (edge.fromKind === 'source' && edge.toKind === 'node') {
      scores.set(edge.toId, (scores.get(edge.toId) ?? 0) + score);
    } else if (edge.fromKind === 'node' && edge.toKind === 'source') {
      scores.set(edge.fromId, (scores.get(edge.fromId) ?? 0) + score);
    }
  }
  const describingFacts = new Map<string, Set<string>>();
  for (const edge of store.listEdges()) {
    if (edge.fromKind === 'node' && edge.toKind === 'node' && edge.relation === 'describes') {
      const current = describingFacts.get(edge.fromId) ?? new Set<string>();
      current.add(edge.toId);
      describingFacts.set(edge.fromId, current);
    }
  }
  for (const edge of store.listEdges()) {
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    const source = sourcesById.get(edge.fromId);
    if (!source) continue;
    const score = linkedSourceQuality(source, edge.relation);
    for (const anchorId of describingFacts.get(edge.toId) ?? []) {
      scores.set(anchorId, (scores.get(anchorId) ?? 0) + score);
    }
  }
  return scores;
}

function linkedSourceQuality(source: KnowledgeSourceRecord, relation: string): number {
  let score = source.status === 'indexed' ? 4 : 0;
  if (source.sourceType === 'manual') score += 32;
  else if (source.sourceType === 'document') score += 22;
  else if (source.sourceType === 'url') score += 10;
  if (source.artifactId) score += 16;
  if (source.connectorId === 'homeassistant') score += 16;
  else if (source.connectorId === 'semantic-gap-repair') score += 4;
  if (relation === 'has_manual') score += 32;
  else if (relation === 'source_for') score += 14;
  const discovery = readRecord(source.metadata.sourceDiscovery);
  if (readString(discovery.purpose) === 'semantic-gap-repair') score -= 8;
  return Math.max(0, score);
}

function isHomeAssistantObjectNode(node: KnowledgeNodeRecord): boolean {
  return node.kind === 'ha_device'
    || node.kind === 'ha_entity'
    || node.kind === 'ha_area'
    || node.kind === 'ha_integration'
    || node.kind === 'ha_automation'
    || node.kind === 'ha_script'
    || node.kind === 'ha_scene';
}

function scoreHomeAssistantObject(node: KnowledgeNodeRecord, tokens: readonly string[]): number {
  const metadata = readRecord(node.metadata);
  const homeAssistant = readRecord(metadata.homeAssistant);
  const text = homeAssistantObjectText(node);
  const baseScore = scoreSemanticText(text, tokens);
  const domain = (readString(metadata.domain) ?? readString(homeAssistant.domain) ?? '').toLowerCase();
  const platform = (readString(metadata.platform) ?? readString(homeAssistant.integrationDomain) ?? '').toLowerCase();
  const tvQuery = tokens.some((token) => token === 'tv' || token === 'television');
  if (tvQuery) {
    const lower = text.toLowerCase();
    if (node.kind === 'ha_device' && /\b(tv|television|webos|bravia|roku)\b/.test(lower)) return baseScore + 80;
    if (node.kind === 'ha_entity' && (domain === 'media_player' || platform === 'webostv')) return baseScore + 70;
    if (node.kind === 'ha_integration' && (platform === 'webostv' || lower.includes('webos'))) return baseScore + 30;
    if (node.kind === 'ha_automation' || domain === 'sensor' || domain === 'switch') return Math.max(0, baseScore - 40);
  }
  return baseScore;
}

function homeAssistantObjectText(node: KnowledgeNodeRecord): string {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  return [
    node.title,
    node.summary,
    node.aliases.join(' '),
    readString(node.metadata.manufacturer),
    readString(node.metadata.model),
    readString(homeAssistant.objectKind),
    readString(homeAssistant.objectId),
    readString(homeAssistant.entityId),
    readString(homeAssistant.domain),
    readString(homeAssistant.deviceClass),
    readString(homeAssistant.integrationDomain),
  ].filter(Boolean).join('\n');
}

function isSingularObjectQuery(query: string, tokens: readonly string[]): boolean {
  const normalized = query.toLowerCase();
  if (/\b(the|this|that|my)\s+(tv|television|device|sensor|switch|camera|printer|router|phone|object|thing)\b/.test(normalized)) {
    return true;
  }
  if (tokens.includes('tv') || tokens.includes('television')) {
    return !tokens.includes('tvs') && !tokens.includes('televisions');
  }
  return false;
}

function isStrongIdentityToken(token: string): boolean {
  return token.length >= 4 && !GENERIC_ANCHOR_TOKENS.has(token);
}

function hasSpecificObjectTypeToken(tokens: readonly string[]): boolean {
  return tokens.some((token) => SPECIFIC_OBJECT_TYPE_TOKENS.has(token));
}

const SPECIFIC_OBJECT_TYPE_TOKENS = new Set([
  'appliance',
  'bridge',
  'camera',
  'console',
  'doorbell',
  'garage',
  'hub',
  'lock',
  'phone',
  'printer',
  'projector',
  'remote',
  'router',
  'sensor',
  'speaker',
  'switch',
  'television',
  'thermostat',
  'tv',
  'xbox',
]);

function sourceMatchesAnchor(sourceText: string, anchorText: string): boolean {
  const tokens = anchorText
    .toLowerCase()
    .split(/[^a-z0-9_.:-]+/)
    .filter((token) => token.length >= 4 && !GENERIC_ANCHOR_TOKENS.has(token));
  if (tokens.length === 0) return false;
  return scoreSemanticText(sourceText, tokens) >= Math.min(24, tokens.length * 12);
}

const GENERIC_ANCHOR_TOKENS = new Set([
  'audio',
  'available',
  'capabilities',
  'capability',
  'configuration',
  'device',
  'entity',
  'feature',
  'features',
  'format',
  'formats',
  'gaming',
  'have',
  'hdmi',
  'hdr',
  'home',
  'assistant',
  'integration',
  'network',
  'port',
  'ports',
  'rate',
  'refresh',
  'sensor',
  'smart',
  'spec',
  'specification',
  'specifications',
  'switch',
  'support',
  'supported',
  'supports',
  'television',
  'tv',
]);

const GENERIC_ANSWER_INTENT_TOKENS = new Set([
  'capabilities',
  'capability',
  'configuration',
  'configure',
  'feature',
  'features',
  'function',
  'functions',
  'install',
  'mode',
  'modes',
  'procedure',
  'setting',
  'settings',
  'setup',
  'spec',
  'specification',
  'specifications',
  'specs',
  'support',
  'supported',
  'supports',
]);
