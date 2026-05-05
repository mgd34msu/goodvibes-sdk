import type { ArtifactStore } from '../artifacts/index.js';
import { logger } from '../utils/logger.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { isGeneratedKnowledgeSource } from './generated-projections.js';
import { isActiveKnowledgeEdge } from './projection-utils.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from './spaces.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';

const DEFAULT_RELATED_GENERATED_PAGES = 24;
const GENERATED_PAGE_MARKDOWN_READ_CONCURRENCY = 8;

export interface GeneratedKnowledgePageGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly [key: string]: unknown;
}

export type GeneratedKnowledgePageGraphNeighbor<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode> =
  TNode & { readonly relation: string; readonly direction: 'incoming' | 'outgoing' };

export interface GeneratedKnowledgeRelatedPage<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode> {
  readonly sourceId: string;
  readonly title: string;
  readonly projectionKind?: string | undefined;
  readonly subject?: TNode | undefined;
}

export interface GeneratedKnowledgePageEntry<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode> {
  readonly source: KnowledgeSourceRecord;
  readonly artifact?: {
    readonly id: string;
    readonly mimeType: string;
    readonly filename?: string | undefined;
    readonly createdAt: number;
    readonly metadata: Record<string, unknown>;
  };
  readonly markdown?: string | undefined;
  readonly target?: TNode | undefined;
  readonly subject?: TNode | undefined;
  readonly neighbors?: readonly GeneratedKnowledgePageGraphNeighbor<TNode>[] | undefined;
  readonly relatedPages?: readonly GeneratedKnowledgeRelatedPage<TNode>[] | undefined;
}

export interface GeneratedKnowledgePageListResult<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode> {
  readonly ok: true;
  readonly spaceId: string;
  readonly pages: readonly GeneratedKnowledgePageEntry<TNode>[];
}

export interface GeneratedKnowledgePageListOptions<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode> {
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
  readonly isGeneratedSource?: ((source: KnowledgeSourceRecord) => boolean) | undefined;
  readonly isPageSubjectNode?: ((node: KnowledgeNodeRecord) => boolean) | undefined;
  readonly resolvePageSubject?: ((target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph) => KnowledgeNodeRecord | undefined) | undefined;
  readonly projectNode?: ((node: KnowledgeNodeRecord) => TNode) | undefined;
  readonly compareGeneratedPages?: (
    left: KnowledgeSourceRecord,
    right: KnowledgeSourceRecord,
    graph: GeneratedKnowledgePageGraph,
  ) => number;
  readonly relatedPageLimit?: number | undefined;
}

export interface GeneratedKnowledgePageGraph {
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly generatedSources: readonly KnowledgeSourceRecord[];
  readonly targetBySourceId: ReadonlyMap<string, KnowledgeNodeRecord>;
}

export async function listGeneratedKnowledgePages<TNode extends GeneratedKnowledgePageGraphNode = GeneratedKnowledgePageGraphNode>(
  input: GeneratedKnowledgePageListOptions<TNode>,
): Promise<GeneratedKnowledgePageListResult<TNode>> {
  const scoped = scopeGeneratedPageRecords(input.spaceId, input.sources, input.nodes, input.edges);
  const graph = buildGeneratedKnowledgePageGraph(scoped.sources, scoped.nodes, scoped.edges, input.isGeneratedSource);
  const projectNode = input.projectNode ?? defaultPageGraphNode as (node: KnowledgeNodeRecord) => TNode;
  const resolveSubject = input.resolvePageSubject ?? defaultResolvePageSubject;
  const isSubject = input.isPageSubjectNode ?? defaultIsPageSubjectNode;
  const relatedPageLimit = input.relatedPageLimit ?? DEFAULT_RELATED_GENERATED_PAGES;
  const sources = [...graph.generatedSources]
    .sort((left, right) => input.compareGeneratedPages?.(left, right, graph) ?? compareGeneratedPages(left, right, graph))
    .slice(0, input.limit);
  const pages = await mapWithConcurrency<KnowledgeSourceRecord, GeneratedKnowledgePageEntry<TNode>>(
    sources,
    GENERATED_PAGE_MARKDOWN_READ_CONCURRENCY,
    async (source) => {
      const artifact = typeof source.artifactId === 'string' ? input.artifactStore.get(source.artifactId) : undefined;
      const markdown = input.includeMarkdown && artifact
        ? await readMarkdown(input.artifactStore, artifact.id)
        : undefined;
      const target = graph.targetBySourceId.get(source.id);
      const subject = target ? resolveSubject(target, graph) : undefined;
      return {
        source,
        ...(artifact ? {
          artifact: {
            id: artifact.id,
            mimeType: artifact.mimeType,
            filename: artifact.filename,
            createdAt: artifact.createdAt,
            metadata: artifact.metadata,
          },
        } : {}),
        ...(markdown ? { markdown } : {}),
        ...(target ? { target: projectNode(target) } : {}),
        ...(subject ? { subject: projectNode(subject) } : {}),
        ...(subject ? { neighbors: pageNeighbors(subject, graph, isSubject, projectNode) } : {}),
        ...(subject ? { relatedPages: relatedPages(source.id, subject, graph, resolveSubject, isSubject, projectNode, relatedPageLimit) } : {}),
      };
    });
  return { ok: true, spaceId: input.spaceId, pages };
}

function scopeGeneratedPageRecords(
  spaceId: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
} {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const scopedSources = sources.filter((source) => recordBelongsToGeneratedPageSpace(source, normalized));
  const scopedNodes = nodes.filter((node) => recordBelongsToGeneratedPageSpace(node, normalized));
  const sourceIds = new Set(scopedSources.map((source) => source.id));
  const nodeIds = new Set(scopedNodes.map((node) => node.id));
  const scopedEdges = edges.filter((edge) => edgeReferencesGeneratedPageSpace(edge, sourceIds, nodeIds)
    && (recordBelongsToGeneratedPageSpace(edge, normalized) || edgeHasGeneratedPageSpaceEndpoint(edge, sourceIds, nodeIds)));
  return { sources: scopedSources, nodes: scopedNodes, edges: scopedEdges };
}

function recordBelongsToGeneratedPageSpace(
  record: { readonly metadata?: Record<string, unknown> },
  normalizedSpaceId: string,
): boolean {
  const recordSpaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(record));
  if (normalizedSpaceId === 'homeassistant') return isHomeAssistantKnowledgeSpace(recordSpaceId);
  return recordSpaceId === normalizedSpaceId;
}

function edgeReferencesGeneratedPageSpace(
  edge: KnowledgeEdgeRecord,
  sourceIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
): boolean {
  return (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId));
}

function edgeHasGeneratedPageSpaceEndpoint(
  edge: KnowledgeEdgeRecord,
  sourceIds: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
): boolean {
  return (edge.fromKind === 'source' && sourceIds.has(edge.fromId))
    || (edge.toKind === 'source' && sourceIds.has(edge.toId))
    || (edge.fromKind === 'node' && nodeIds.has(edge.fromId))
    || (edge.toKind === 'node' && nodeIds.has(edge.toId));
}

export function buildGeneratedKnowledgePageGraph(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  isGeneratedSource: (source: KnowledgeSourceRecord) => boolean = isGeneratedKnowledgeSource,
): GeneratedKnowledgePageGraph {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const activeEdges = edges.filter(edgeIsActive);
  const targetBySourceId = new Map<string, KnowledgeNodeRecord>();
  const generatedSources = sources.filter((source) => source.status === 'indexed' && isGeneratedSource(source));
  for (const source of generatedSources) {
    const targetId = generatedPageTargetNodeId(source, activeEdges, nodesById);
    const target = targetId ? nodesById.get(targetId) : undefined;
    if (target && target.status !== 'stale') targetBySourceId.set(source.id, target);
  }
  return {
    nodesById,
    edges: activeEdges,
    generatedSources: generatedSources.filter((source) => {
      const targetId = generatedPageTargetNodeId(source, activeEdges, nodesById);
      if (!targetId) return true;
      const target = nodesById.get(targetId);
      return Boolean(target && target.status !== 'stale');
    }),
    targetBySourceId,
  };
}

function generatedPageTargetNodeId(
  source: KnowledgeSourceRecord,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): string | undefined {
  const metadataTargetId = typeof source.metadata.generatedTargetNodeId === 'string'
    ? source.metadata.generatedTargetNodeId
    : undefined;
  if (metadataTargetId) return metadataTargetId;
  const targetEdges = edges.filter((edge) => (
    edge.fromKind === 'source'
    && edge.fromId === source.id
    && edge.toKind === 'node'
    && isGeneratedPageTargetEdge(edge)
  ));
  const activeTarget = targetEdges.find((edge) => {
    const target = nodesById.get(edge.toId);
    return Boolean(target && target.status !== 'stale');
  });
  return activeTarget?.toId ?? targetEdges[0]?.toId;
}

function isGeneratedPageTargetEdge(edge: KnowledgeEdgeRecord): boolean {
  return edge.relation === 'source_for'
    || edge.metadata.generatedKnowledgePage === true
    || edge.metadata.generatedProjection === true;
}

function defaultResolvePageSubject(target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph): KnowledgeNodeRecord | undefined {
  if (defaultIsPageSubjectNode(target)) return target;
  const related = graph.edges.find((edge) => (
    edge.fromKind === 'node'
    && edge.fromId === target.id
    && edge.toKind === 'node'
    && edge.relation === 'source_for'
  ));
  return related ? graph.nodesById.get(related.toId) : undefined;
}

function relatedPages<TNode extends GeneratedKnowledgePageGraphNode>(
  currentSourceId: string,
  subject: KnowledgeNodeRecord,
  graph: GeneratedKnowledgePageGraph,
  resolveSubject: (target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph) => KnowledgeNodeRecord | undefined,
  isSubject: (node: KnowledgeNodeRecord) => boolean,
  projectNode: (node: KnowledgeNodeRecord) => TNode,
  limit: number,
): GeneratedKnowledgeRelatedPage<TNode>[] {
  const neighborIds = new Set(pageNeighbors(subject, graph, isSubject, projectNode).map((neighbor) => neighbor.id));
  neighborIds.add(subject.id);
  const result: GeneratedKnowledgeRelatedPage<TNode>[] = [];
  for (const source of graph.generatedSources) {
    if (source.id === currentSourceId) continue;
    const target = graph.targetBySourceId.get(source.id);
    if (!target) continue;
    const pageSubject = resolveSubject(target, graph);
    if (!pageSubject || !neighborIds.has(pageSubject.id)) continue;
    result.push({
      sourceId: source.id,
      title: source.title ?? source.id,
      ...(typeof source.metadata.projectionKind === 'string' ? { projectionKind: source.metadata.projectionKind } : {}),
      subject: projectNode(pageSubject),
    });
  }
  return result.slice(0, limit);
}

function pageNeighbors<TNode extends GeneratedKnowledgePageGraphNode>(
  subject: KnowledgeNodeRecord,
  graph: GeneratedKnowledgePageGraph,
  isSubject: (node: KnowledgeNodeRecord) => boolean,
  projectNode: (node: KnowledgeNodeRecord) => TNode,
): GeneratedKnowledgePageGraphNeighbor<TNode>[] {
  const neighbors: GeneratedKnowledgePageGraphNeighbor<TNode>[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.fromKind === 'node' && edge.fromId === subject.id && edge.toKind === 'node') {
      const node = graph.nodesById.get(edge.toId);
      if (node && isSubject(node)) pushNeighbor(neighbors, seen, projectNode(node), edge.relation, 'outgoing');
    } else if (edge.toKind === 'node' && edge.toId === subject.id && edge.fromKind === 'node') {
      const node = graph.nodesById.get(edge.fromId);
      if (node && isSubject(node)) pushNeighbor(neighbors, seen, projectNode(node), edge.relation, 'incoming');
    }
  }
  return neighbors.slice(0, 48);
}

function pushNeighbor<TNode extends GeneratedKnowledgePageGraphNode>(
  neighbors: GeneratedKnowledgePageGraphNeighbor<TNode>[],
  seen: Set<string>,
  node: TNode,
  relation: string,
  direction: 'incoming' | 'outgoing',
): void {
  const key = `${node.id}:${relation}:${direction}`;
  if (seen.has(key)) return;
  seen.add(key);
  neighbors.push({ ...node, relation, direction });
}

function defaultIsPageSubjectNode(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (node.metadata.semanticKind) return false;
  return !['fact', 'knowledge_gap', 'wiki_page'].includes(node.kind);
}

function defaultPageGraphNode(node: KnowledgeNodeRecord): GeneratedKnowledgePageGraphNode {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
  };
}

function compareGeneratedPages(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord, graph: GeneratedKnowledgePageGraph): number {
  const leftKind = typeof left.metadata.projectionKind === 'string' ? left.metadata.projectionKind : '';
  const rightKind = typeof right.metadata.projectionKind === 'string' ? right.metadata.projectionKind : '';
  return generatedPagePriority(right, graph) - generatedPagePriority(left, graph)
    || leftKind.localeCompare(rightKind)
    || (left.title ?? left.id).localeCompare(right.title ?? right.id)
    || left.id.localeCompare(right.id);
}

function generatedPagePriority(source: KnowledgeSourceRecord, graph: GeneratedKnowledgePageGraph): number {
  const target = graph.targetBySourceId.get(source.id);
  const subject = target ? defaultResolvePageSubject(target, graph) : undefined;
  const projectionKind = typeof source.metadata.projectionKind === 'string' ? source.metadata.projectionKind : '';
  let score = 0;
  if (projectionKind) score += 10;
  if (subject) score += 10;
  return score;
}

async function readMarkdown(artifactStore: ArtifactStore, artifactId: string): Promise<string | undefined> {
  try {
    const { buffer } = await artifactStore.readContent(artifactId);
    return buffer.toString('utf-8');
  } catch (error) {
    logger.warn('Generated knowledge page markdown read failed', {
      artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function edgeIsActive(edge: KnowledgeEdgeRecord): boolean {
  return isActiveKnowledgeEdge(edge);
}
