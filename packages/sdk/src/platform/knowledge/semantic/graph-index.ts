import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import {
  knowledgeNodeMatchesScope,
  knowledgeSourceMatchesScope,
} from '../scope-records.js';

export interface KnowledgeSemanticGraphIndex {
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>;
}

export function buildKnowledgeSemanticGraphIndex(
  store: KnowledgeStore,
  spaceId: string,
): KnowledgeSemanticGraphIndex {
  const scope = { knowledgeSpaceId: spaceId };
  const rawSources = store.listSourcesInSpace(spaceId).filter((source) => source.status !== 'stale');
  const sourceMap = new Map(rawSources.map((source) => [source.id, source]));
  // Only active nodes are answerable: stale (superseded/forgotten) and draft
  // (pending review) content must not surface in semantic answers. (Defects 2 & 4.)
  const rawNodes = store.listNodesInSpace(spaceId).filter((node) => node.status === 'active');
  const edgeCandidates = store.listEdges().filter(isActiveKnowledgeEdge);
  const rawNodeMap = new Map(rawNodes.map((node) => [node.id, node]));
  const lookup = { sources: sourceMap, nodes: rawNodeMap, edges: edgeCandidates };
  const sources = rawSources.filter((source) => knowledgeSourceMatchesScope(source, scope));
  const nodes = rawNodes.filter((node) => knowledgeNodeMatchesScope(node, scope, lookup));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const edges = edgeCandidates.filter((edge) => (
    (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
  ));
  return {
    edges,
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    sourcesById: new Map(sources.map((source) => [source.id, source])),
  };
}
