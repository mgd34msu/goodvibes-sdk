import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { belongsToSpace, edgeIsActive, readRecord } from './helpers.js';
import type { HomeGraphSearchResult } from './types.js';

const MAX_FIELD_CHARS = 4_096;
const MAX_SECTION_COUNT = 32;
const MAX_SEARCH_TEXT_CHARS = 64 * 1024;

export interface HomeGraphSearchState {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

export function readHomeGraphSearchState(store: KnowledgeStore, spaceId: string): HomeGraphSearchState {
  const sources = store.listSources(10_000).filter((source) => belongsToSpace(source, spaceId));
  const nodes = store.listNodes(10_000).filter((node) => belongsToSpace(node, spaceId));
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
  extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number,
): HomeGraphSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const sourceResults = sources.map((source) => {
    const extraction = extractionBySourceId(source.id);
    const baseScore = scoreFields(tokens, [
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
      ...limitedSections(extraction),
    ]);
    return {
      kind: 'source' as const,
      id: source.id,
      score: baseScore > 0 ? baseScore + (extraction ? 8 : 0) : 0,
      title: source.title ?? source.sourceUri ?? source.id,
      summary: extraction?.summary ?? source.summary,
      source,
    };
  });
  const nodeResults = nodes.map((node) => {
    const baseScore = scoreFields(tokens, [
      node.title,
      node.summary,
      node.aliases.join(' '),
      readNodeMetadataText(node),
    ]);
    return {
      kind: 'node' as const,
      id: node.id,
      score: baseScore > 0 ? baseScore + Math.round(node.confidence / 20) : 0,
      title: node.title,
      summary: node.summary,
      node,
    };
  });
  return [...sourceResults, ...nodeResults]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
}

function limitedSections(extraction: KnowledgeExtractionRecord | null | undefined): string[] {
  if (!extraction) return [];
  return extraction.sections.slice(0, MAX_SECTION_COUNT).map((section) => clampText(section, MAX_FIELD_CHARS));
}

function readSearchText(extraction: KnowledgeExtractionRecord | null | undefined): string | undefined {
  if (!extraction) return undefined;
  const structure = readRecord(extraction.structure);
  const metadata = readRecord(extraction.metadata);
  return firstBoundedText([
    structure.searchText,
    structure.text,
    structure.content,
    metadata.searchText,
  ], MAX_SEARCH_TEXT_CHARS);
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

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_.:-]+/).map((entry) => entry.trim()).filter(Boolean);
}

function scoreFields(tokens: readonly string[], fields: readonly (string | undefined)[]): number {
  let score = 0;
  for (const field of fields) {
    const raw = typeof field === 'string' ? field.trim() : '';
    const haystack = clampText(raw, MAX_SEARCH_TEXT_CHARS).toLowerCase();
    if (!haystack) continue;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 10;
    }
  }
  return score;
}
