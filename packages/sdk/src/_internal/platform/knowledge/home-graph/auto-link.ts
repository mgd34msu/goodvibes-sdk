import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  buildHomeGraphMetadata,
  edgeIsActive,
  isGeneratedPageSource,
  readRecord,
  uniqueStrings,
} from './helpers.js';
import type { HomeGraphState } from './state.js';

const MIN_AUTO_LINK_SCORE = 90;
const MIN_SOURCE_TEXT_CHARS = 16;
const MAX_TEXT_FIELD_CHARS = 32_768;
const GENERIC_TOKENS = new Set(['device', 'home', 'assistant', 'smart', 'manual', 'owner', 'guide', 'user', 'the']);

export interface HomeGraphAutoLinkResult {
  readonly edge: KnowledgeEdgeRecord;
  readonly node: KnowledgeNodeRecord;
  readonly relation: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export async function autoLinkHomeGraphSource(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly source: KnowledgeSourceRecord;
  readonly extraction?: KnowledgeExtractionRecord;
  readonly state: HomeGraphState;
}): Promise<HomeGraphAutoLinkResult | undefined> {
  if (isGeneratedPageSource(input.source) || shouldSkipAutoLink(input.source)) return undefined;
  if (hasActiveSourceLink(input.source.id, input.state.edges)) return undefined;
  const candidates = scoreCandidates(input.source, input.extraction, input.state);
  const best = candidates[0];
  if (!best || best.score < MIN_AUTO_LINK_SCORE) return undefined;
  const next = candidates[1];
  if (next && best.score - next.score < 20 && !best.reasons.some((reason) => reason.startsWith('exact-model:'))) {
    return undefined;
  }
  const relation = inferRelation(input.source);
  const edge = await input.store.upsertEdge({
    fromKind: 'source',
    fromId: input.source.id,
    toKind: 'node',
    toId: best.node.id,
    relation,
    weight: Math.min(5, Math.max(1, Math.round(best.score / 60))),
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      linkStatus: 'active',
      linkMethod: 'homegraph-auto-link',
      autoLinkedAt: Date.now(),
      autoLinkScore: best.score,
      autoLinkReasons: best.reasons,
    }),
  });
  return { edge, node: best.node, relation, score: best.score, reasons: best.reasons };
}

export async function autoLinkHomeGraphSources(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
  readonly state: HomeGraphState;
}): Promise<readonly HomeGraphAutoLinkResult[]> {
  const linked: HomeGraphAutoLinkResult[] = [];
  for (const source of input.sources) {
    const result = await autoLinkHomeGraphSource({
      store: input.store,
      spaceId: input.spaceId,
      installationId: input.installationId,
      source,
      extraction: input.extractionBySourceId.get(source.id),
      state: {
        ...input.state,
        edges: [...input.state.edges, ...linked.map((entry) => entry.edge)],
      },
    });
    if (result) linked.push(result);
  }
  return linked;
}

function scoreCandidates(
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | undefined,
  state: HomeGraphState,
): Array<{ readonly node: KnowledgeNodeRecord; readonly score: number; readonly reasons: readonly string[] }> {
  const sourceText = sourceEvidenceText(source, extraction);
  if (sourceText.length < MIN_SOURCE_TEXT_CHARS) return [];
  const lower = sourceText.toLowerCase();
  const sourceTokens = new Set(tokenize(sourceText));
  return state.nodes
    .filter((node) => isAutoLinkCandidateNode(node))
    .map((node) => {
      const reasons: string[] = [];
      let score = 0;
      const identity = nodeIdentity(node, state);
      for (const model of identity.models) {
        if (model.length >= 4 && includesIdentity(lower, model)) {
          score += model.length >= 8 ? 180 : 120;
          reasons.push(`exact-model:${model}`);
        }
      }
      for (const entityId of identity.entityIds) {
        if (includesIdentity(lower, entityId)) {
          score += 140;
          reasons.push(`entity-id:${entityId}`);
        }
      }
      for (const deviceId of identity.deviceIds) {
        if (includesIdentity(lower, deviceId)) {
          score += 120;
          reasons.push(`device-id:${deviceId}`);
        }
      }
      const titleTokens = tokenize(node.title).filter((token) => !isGenericToken(token));
      const overlap = titleTokens.filter((token) => sourceTokens.has(token));
      if (overlap.length > 0) {
        score += overlap.reduce((sum, token) => sum + (token.length <= 3 ? 12 : 18), 0);
        reasons.push(`title:${overlap.slice(0, 5).join(',')}`);
      }
      const manufacturerMatches = identity.manufacturers.filter((manufacturer) => includesIdentity(lower, manufacturer));
      if (manufacturerMatches.length > 0) {
        score += 28;
        reasons.push(`manufacturer:${manufacturerMatches[0]}`);
      }
      const relatedEntityMatches = identity.relatedEntityTokens.filter((token) => sourceTokens.has(token));
      if (relatedEntityMatches.length > 0) {
        score += Math.min(50, relatedEntityMatches.length * 10);
        reasons.push(`related-entity:${relatedEntityMatches.slice(0, 5).join(',')}`);
      }
      if (node.kind === 'ha_device' && isManualLikeSource(source)) score += 16;
      if (node.kind === 'ha_integration' && isIntegrationDocumentationSource(source)) score += 40;
      if (node.kind === 'ha_integration' && isManualLikeSource(source)) score -= 45;
      return { node, score, reasons };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
}

function shouldSkipAutoLink(source: KnowledgeSourceRecord): boolean {
  const kind = typeof source.metadata.homeGraphSourceKind === 'string' ? source.metadata.homeGraphSourceKind : '';
  return kind === 'snapshot' || kind === 'generated-page';
}

function hasActiveSourceLink(sourceId: string, edges: readonly KnowledgeEdgeRecord[]): boolean {
  return edges.some((edge) => edgeIsActive(edge) && (
    (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    || (edge.fromKind === 'node' && edge.toKind === 'source' && edge.toId === sourceId)
  ));
}

function isAutoLinkCandidateNode(node: KnowledgeNodeRecord): boolean {
  return node.kind === 'ha_device'
    || node.kind === 'ha_entity'
    || node.kind === 'ha_integration'
    || node.kind === 'ha_area'
    || node.kind === 'ha_room';
}

function sourceEvidenceText(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | undefined): string {
  const structure = readRecord(extraction?.structure);
  return uniqueStrings([
    source.title,
    source.summary,
    source.description,
    source.sourceUri,
    source.canonicalUri,
    source.tags.join(' '),
    extraction?.title,
    extraction?.summary,
    extraction?.excerpt,
    ...(extraction?.sections ?? []),
    readString(structure.searchText),
  ]).join('\n').slice(0, MAX_TEXT_FIELD_CHARS);
}

function nodeIdentity(node: KnowledgeNodeRecord, state: HomeGraphState): {
  readonly models: readonly string[];
  readonly manufacturers: readonly string[];
  readonly entityIds: readonly string[];
  readonly deviceIds: readonly string[];
  readonly relatedEntityTokens: readonly string[];
} {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const relatedEntities = node.kind === 'ha_device'
    ? relatedEntityNodes(node.id, state)
    : [];
  return {
    models: uniqueStrings([
      readString(node.metadata.model),
      readString(node.metadata.modelId),
      readString(node.metadata.model_id),
    ]),
    manufacturers: uniqueStrings([
      readString(node.metadata.manufacturer),
      readString(node.metadata.vendor),
    ]),
    entityIds: uniqueStrings([
      readString(homeAssistant.entityId),
      ...relatedEntities.map((entity) => readString(readRecord(entity.metadata.homeAssistant).entityId)),
    ]),
    deviceIds: uniqueStrings([
      readString(homeAssistant.deviceId),
      node.kind === 'ha_device' ? readString(homeAssistant.objectId) : undefined,
    ]),
    relatedEntityTokens: uniqueStrings(relatedEntities.flatMap((entity) => [
      ...tokenize(entity.title),
      ...tokenize(readString(readRecord(entity.metadata.homeAssistant).entityId) ?? ''),
      readString(entity.metadata.domain),
      readString(entity.metadata.platform),
    ])),
  };
}

function relatedEntityNodes(deviceNodeId: string, state: HomeGraphState): KnowledgeNodeRecord[] {
  const entityIds = new Set(state.edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.toKind === 'node'
    && edge.toId === deviceNodeId
    && edge.relation === 'belongs_to_device'
  )).map((edge) => edge.fromId));
  return state.nodes.filter((node) => entityIds.has(node.id) && node.kind === 'ha_entity');
}

function inferRelation(source: KnowledgeSourceRecord): string {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  const text = [source.sourceType, source.title, source.sourceUri, ...tags].join(' ').toLowerCase();
  if (text.includes('receipt')) return 'has_receipt';
  if (text.includes('warranty')) return 'has_warranty';
  if (isManualLikeSource(source)) return 'has_manual';
  return 'source_for';
}

function isManualLikeSource(source: KnowledgeSourceRecord): boolean {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  const text = [source.sourceType, source.title, source.sourceUri, ...tags].join(' ').toLowerCase();
  return source.sourceType === 'manual'
    || tags.includes('manual')
    || tags.includes('artifact')
    || tags.includes('document')
    || /\bmanual\b|\.pdf\b|owner.?s guide|user guide/.test(text);
}

function isIntegrationDocumentationSource(source: KnowledgeSourceRecord): boolean {
  const tags = source.tags.map((tag) => tag.toLowerCase());
  const kind = typeof source.metadata.homeGraphSourceKind === 'string'
    ? source.metadata.homeGraphSourceKind.toLowerCase()
    : '';
  return tags.includes('integration') || tags.includes('documentation') || kind === 'documentation-candidate';
}

function tokenize(value: string): string[] {
  return uniqueStrings(value.toLowerCase().split(/[^a-z0-9_.:-]+/).filter((token) => token.length >= 2));
}

function isGenericToken(value: string): boolean {
  return GENERIC_TOKENS.has(value);
}

function includesIdentity(haystack: string, identity: string): boolean {
  const normalized = identity.trim().toLowerCase();
  if (!normalized) return false;
  if (/^[a-z0-9_.:-]+$/.test(normalized)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalized)}(?:$|[^a-z0-9])`).test(haystack);
  }
  return haystack.includes(normalized);
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
