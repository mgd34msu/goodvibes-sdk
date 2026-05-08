import {
  isGeneratedKnowledgeSource,
} from './generated-projections.js';
import {
  isInKnowledgeSpaceScope,
} from './spaces.js';
import {
  knowledgeIssueMatchesScope,
  knowledgeNodeMatchesScope,
} from './scope-records.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFacetValue,
  KnowledgeMapFacets,
  KnowledgeMapFilterInput,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeMapFilterState {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
}

export interface KnowledgeMapFilterOptions extends KnowledgeMapFilterInput {
  readonly filters?: KnowledgeMapFilterInput | undefined;
  readonly includeGenerated?: boolean | undefined;
}

export function applyKnowledgeMapFilters(
  state: KnowledgeMapFilterState,
  options: KnowledgeMapFilterOptions = {},
): KnowledgeMapFilterState {
  const filters = normalizeKnowledgeMapFilters(options);
  const linkedIds = new Set(filters.linkedToIds);
  const linkedRecordIds = linkedIds.size > 0 ? recordIdsLinkedTo(state.edges, linkedIds) : new Set<string>();
  const query = filters.query?.toLowerCase();
  const recordKinds = filters.recordKinds;
  const scopeLookup = {
    sources: new Map(state.sources.map((source) => [source.id, source])),
    nodes: new Map(state.nodes.map((node) => [node.id, node])),
    edges: state.edges,
  };

  const sources = recordKinds && !recordKinds.has('source')
    ? []
    : state.sources
        .filter((source) => source.status !== 'stale')
        .filter((source) => isInKnowledgeSpaceScope(source, filters))
        .filter((source) => options.includeGenerated !== false || !isGeneratedKnowledgeSource(source))
        .filter((source) => matchesSet(filters.sourceTypes, source.sourceType))
        .filter((source) => matchesSet(filters.sourceStatuses, source.status))
        .filter((source) => matchesAnyTag(filters.tags, source.tags))
        .filter((source) => matchesIds(filters.ids, source.id))
        .filter((source) => linkedIds.size === 0 || linkedRecordIds.has(source.id))
        .filter((source) => !query || textMatches(query, [
          source.id,
          source.title,
          source.summary,
          source.description,
          source.sourceUri,
          source.canonicalUri,
          source.tags.join(' '),
        ]));

  const nodes = recordKinds && !recordKinds.has('node')
    ? []
    : state.nodes
        .filter((node) => node.status !== 'stale')
        .filter((node) => knowledgeNodeMatchesScope(node, filters, scopeLookup))
        .filter((node) => matchesSet(filters.nodeKinds, node.kind))
        .filter((node) => matchesSet(filters.nodeStatuses, node.status))
        .filter((node) => filters.minConfidence === undefined || node.confidence >= filters.minConfidence)
        .filter((node) => matchesAnyTag(filters.tags, readTags(node.metadata)))
        .filter((node) => matchesIds(filters.ids, node.id))
        .filter((node) => linkedIds.size === 0 || linkedRecordIds.has(node.id))
        .filter((node) => !query || textMatches(query, [
          node.id,
          node.kind,
          node.title,
          node.summary,
          node.aliases.join(' '),
          metadataText(node.metadata),
        ]));

  const issues = recordKinds && !recordKinds.has('issue')
    ? []
    : state.issues
        .filter((issue) => (filters.issueStatuses?.length ?? 0) > 0 || issue.status === 'open')
        .filter((issue) => knowledgeIssueMatchesScope(issue, filters, scopeLookup))
        .filter((issue) => matchesSet(filters.issueCodes, issue.code))
        .filter((issue) => matchesSet(filters.issueStatuses, issue.status))
        .filter((issue) => matchesSet(filters.issueSeverities, issue.severity))
        .filter((issue) => matchesIds(filters.ids, issue.id))
        .filter((issue) => linkedIds.size === 0 || linkedRecordIds.has(issue.id))
        .filter((issue) => !query || textMatches(query, [
          issue.id,
          issue.code,
          issue.message,
          issue.severity,
          issue.sourceId,
          issue.nodeId,
          metadataText(issue.metadata),
        ]));

  const visibleIds = new Set([
    ...sources.map((source) => source.id),
    ...nodes.map((node) => node.id),
    ...issues.map((issue) => issue.id),
  ]);
  const edges = state.edges
    .filter((edge) => matchesSet(filters.edgeRelations, edge.relation))
    .filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));

  return { sources, nodes, edges, issues };
}

export function buildKnowledgeMapFacets(state: KnowledgeMapFilterState): KnowledgeMapFacets {
  return {
    recordKinds: [
      facetValue('source', state.sources.length),
      facetValue('node', state.nodes.length),
      facetValue('issue', state.issues.length),
    ].filter((entry) => entry.count > 0),
    nodeKinds: countFacet(state.nodes.map((node) => node.kind)),
    sourceTypes: countFacet(state.sources.map((source) => source.sourceType)),
    sourceStatuses: countFacet(state.sources.map((source) => source.status)),
    nodeStatuses: countFacet(state.nodes.map((node) => node.status)),
    issueCodes: countFacet(state.issues.map((issue) => issue.code)),
    issueStatuses: countFacet(state.issues.map((issue) => issue.status)),
    issueSeverities: countFacet(state.issues.map((issue) => issue.severity)),
    edgeRelations: countFacet(state.edges.map((edge) => edge.relation)),
    tags: countFacet([
      ...state.sources.flatMap((source) => source.tags),
      ...state.nodes.flatMap((node) => readTags(node.metadata)),
    ]),
  };
}

export function normalizeKnowledgeMapFilters(options: KnowledgeMapFilterOptions = {}): Required<Pick<
  KnowledgeMapFilterInput,
  | 'ids'
  | 'linkedToIds'
  | 'nodeKinds'
  | 'sourceTypes'
  | 'sourceStatuses'
  | 'nodeStatuses'
  | 'issueCodes'
  | 'issueStatuses'
  | 'issueSeverities'
  | 'edgeRelations'
  | 'tags'
>> & {
  readonly query?: string | undefined;
  readonly minConfidence?: number | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
  readonly recordKinds?: ReadonlySet<'source' | 'node' | 'issue'> | undefined;
} {
  const nested = options.filters ?? {};
  const recordKinds = normalizeStringArray(options.recordKinds ?? nested.recordKinds);
  const query = readString(options.query) ?? readString(nested.query);
  const minConfidence = readNumber(options.minConfidence) ?? readNumber(nested.minConfidence);
  const knowledgeSpaceId = readString(options.knowledgeSpaceId) ?? readString(nested.knowledgeSpaceId);
  const includeAllSpaces = readBoolean(options.includeAllSpaces) ?? readBoolean(nested.includeAllSpaces);
  return {
    ...(query ? { query } : {}),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
    ...(includeAllSpaces === undefined ? {} : { includeAllSpaces }),
    ...(recordKinds.length > 0 ? { recordKinds: new Set(recordKinds.filter(isRecordKind)) } : {}),
    ids: normalizeStringArray(options.ids ?? nested.ids),
    linkedToIds: normalizeStringArray(options.linkedToIds ?? nested.linkedToIds),
    nodeKinds: normalizeStringArray(options.nodeKinds ?? nested.nodeKinds),
    sourceTypes: normalizeStringArray(options.sourceTypes ?? nested.sourceTypes),
    sourceStatuses: normalizeStringArray(options.sourceStatuses ?? nested.sourceStatuses),
    nodeStatuses: normalizeStringArray(options.nodeStatuses ?? nested.nodeStatuses),
    issueCodes: normalizeStringArray(options.issueCodes ?? nested.issueCodes),
    issueStatuses: normalizeStringArray(options.issueStatuses ?? nested.issueStatuses),
    issueSeverities: normalizeStringArray(options.issueSeverities ?? nested.issueSeverities),
    edgeRelations: normalizeStringArray(options.edgeRelations ?? nested.edgeRelations),
    tags: normalizeStringArray(options.tags ?? nested.tags),
  };
}

export function normalizeStringArray(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => normalizeStringArray(entry));
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
}

export function countFacet(values: readonly unknown[]): readonly KnowledgeMapFacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizeFacetValue(value);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => facetValue(value, count));
}

export function readTags(metadata: Record<string, unknown>): readonly string[] {
  const tags = metadata.tags ?? metadata.labels;
  return normalizeStringArray(tags);
}

function recordIdsLinkedTo(edges: readonly KnowledgeEdgeRecord[], linkedIds: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>(linkedIds);
  for (const edge of edges) {
    if (linkedIds.has(edge.fromId)) ids.add(edge.toId);
    if (linkedIds.has(edge.toId)) ids.add(edge.fromId);
  }
  return ids;
}

function matchesSet(allowed: readonly string[] | undefined, value: string): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(value);
}

function matchesAnyTag(allowed: readonly string[] | undefined, tags: readonly string[]): boolean {
  return !allowed || allowed.length === 0 || tags.some((tag) => allowed.includes(tag));
}

function matchesIds(ids: readonly string[] | undefined, id: string): boolean {
  return !ids || ids.length === 0 || ids.includes(id);
}

function textMatches(query: string, fields: readonly (string | undefined)[]): boolean {
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(query));
}

function metadataText(metadata: Record<string, unknown>): string {
  return Object.values(metadata).flatMap((value) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
    return [];
  }).join(' ');
}

function isRecordKind(value: string): value is 'source' | 'node' | 'issue' {
  return value === 'source' || value === 'node' || value === 'issue';
}

function facetValue(value: string, count: number): KnowledgeMapFacetValue {
  return { value, count };
}

function normalizeFacetValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}
