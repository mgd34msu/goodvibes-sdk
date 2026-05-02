import type { ArtifactStore } from '../../artifacts/index.js';
import { yieldEvery } from '../cooperative.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { edgeIsActive, isGeneratedPageSource, readRecord } from './helpers.js';
import type { HomeGraphPageGraphNeighbor, HomeGraphPageGraphNode, HomeGraphPageListResult, HomeGraphRelatedPage } from './types.js';

export async function listHomeGraphPages(input: {
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
}): Promise<HomeGraphPageListResult> {
  const pages: HomeGraphPageListResult['pages'][number][] = [];
  const sources = input.sources
    .filter(isGeneratedPageSource)
    .sort(compareGeneratedPages)
    .slice(0, input.limit);
  const graph = buildPageGraph(input.sources, input.nodes, input.edges);
  for (const [index, source] of sources.entries()) {
    await yieldEvery(index, 4);
    const artifact = typeof source.artifactId === 'string' ? input.artifactStore.get(source.artifactId) : undefined;
    const markdown = input.includeMarkdown && artifact
      ? await readMarkdown(input.artifactStore, artifact.id)
      : undefined;
    const target = graph.targetBySourceId.get(source.id);
    const subject = target ? resolvePageSubject(target, graph) : undefined;
    pages.push({
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
      ...(target ? { target: pageGraphNode(target) } : {}),
      ...(subject ? { subject: pageGraphNode(subject) } : {}),
      ...(subject ? { neighbors: pageNeighbors(subject, graph) } : {}),
      ...(subject ? { relatedPages: relatedPages(source.id, subject, graph) } : {}),
    });
  }
  return { ok: true, spaceId: input.spaceId, pages };
}

interface PageGraph {
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly generatedSources: readonly KnowledgeSourceRecord[];
  readonly targetBySourceId: ReadonlyMap<string, KnowledgeNodeRecord>;
}

function buildPageGraph(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): PageGraph {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const activeEdges = edges.filter(edgeIsActive);
  const targetBySourceId = new Map<string, KnowledgeNodeRecord>();
  for (const source of sources.filter(isGeneratedPageSource)) {
    const targetEdge = activeEdges.find((edge) => edge.fromKind === 'source' && edge.fromId === source.id && edge.toKind === 'node');
    const target = targetEdge ? nodesById.get(targetEdge.toId) : undefined;
    if (target) targetBySourceId.set(source.id, target);
  }
  return {
    nodesById,
    edges: activeEdges,
    generatedSources: sources.filter(isGeneratedPageSource),
    targetBySourceId,
  };
}

function resolvePageSubject(target: KnowledgeNodeRecord, graph: PageGraph): KnowledgeNodeRecord | undefined {
  if (target.kind === 'ha_device_passport') {
    const deviceEdge = graph.edges.find((edge) => (
      edge.fromKind === 'node'
      && edge.fromId === target.id
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
    ));
    return deviceEdge ? graph.nodesById.get(deviceEdge.toId) : undefined;
  }
  if (isPageSubjectNode(target)) return target;
  return undefined;
}

function relatedPages(
  currentSourceId: string,
  subject: KnowledgeNodeRecord,
  graph: PageGraph,
): HomeGraphRelatedPage[] {
  const neighborIds = new Set(pageNeighbors(subject, graph).map((neighbor) => neighbor.id));
  neighborIds.add(subject.id);
  const result: HomeGraphRelatedPage[] = [];
  for (const source of graph.generatedSources) {
    if (source.id === currentSourceId) continue;
    const target = graph.targetBySourceId.get(source.id);
    if (!target) continue;
    const pageSubject = resolvePageSubject(target, graph);
    if (!pageSubject || !neighborIds.has(pageSubject.id)) continue;
    result.push({
      sourceId: source.id,
      title: source.title ?? source.id,
      ...(typeof source.metadata.projectionKind === 'string' ? { projectionKind: source.metadata.projectionKind } : {}),
      subject: pageGraphNode(pageSubject),
    });
  }
  return result.slice(0, 24);
}

function pageNeighbors(subject: KnowledgeNodeRecord, graph: PageGraph): HomeGraphPageGraphNeighbor[] {
  const neighbors: HomeGraphPageGraphNeighbor[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.fromKind === 'node' && edge.fromId === subject.id && edge.toKind === 'node') {
      const node = graph.nodesById.get(edge.toId);
      if (node && isPageSubjectNode(node)) pushNeighbor(neighbors, seen, node, edge.relation, 'outgoing');
    } else if (edge.toKind === 'node' && edge.toId === subject.id && edge.fromKind === 'node') {
      const node = graph.nodesById.get(edge.fromId);
      if (node && isPageSubjectNode(node)) pushNeighbor(neighbors, seen, node, edge.relation, 'incoming');
    }
  }
  return neighbors.slice(0, 48);
}

function pushNeighbor(
  neighbors: HomeGraphPageGraphNeighbor[],
  seen: Set<string>,
  node: KnowledgeNodeRecord,
  relation: string,
  direction: 'incoming' | 'outgoing',
): void {
  const key = `${node.id}:${relation}:${direction}`;
  if (seen.has(key)) return;
  seen.add(key);
  neighbors.push({ ...pageGraphNode(node), relation, direction });
}

function isPageSubjectNode(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (node.metadata.semanticKind) return false;
  return !['fact', 'knowledge_gap', 'wiki_page', 'ha_device_passport'].includes(node.kind);
}

function pageGraphNode(node: KnowledgeNodeRecord): HomeGraphPageGraphNode {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(typeof ha.objectKind === 'string' ? { objectKind: ha.objectKind } : {}),
    ...(typeof ha.objectId === 'string' ? { objectId: ha.objectId } : {}),
    ...(typeof ha.entityId === 'string' ? { entityId: ha.entityId } : {}),
    ...(typeof ha.deviceId === 'string' ? { deviceId: ha.deviceId } : {}),
    ...(typeof ha.areaId === 'string' ? { areaId: ha.areaId } : {}),
    ...(typeof ha.integrationId === 'string' ? { integrationId: ha.integrationId } : {}),
  };
}

function compareGeneratedPages(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): number {
  const leftKind = typeof left.metadata.projectionKind === 'string' ? left.metadata.projectionKind : '';
  const rightKind = typeof right.metadata.projectionKind === 'string' ? right.metadata.projectionKind : '';
  return leftKind.localeCompare(rightKind)
    || (left.title ?? left.id).localeCompare(right.title ?? right.id)
    || left.id.localeCompare(right.id);
}

async function readMarkdown(artifactStore: ArtifactStore, artifactId: string): Promise<string | undefined> {
  try {
    const { buffer } = await artifactStore.readContent(artifactId);
    return buffer.toString('utf-8');
  } catch {
    return undefined;
  }
}
