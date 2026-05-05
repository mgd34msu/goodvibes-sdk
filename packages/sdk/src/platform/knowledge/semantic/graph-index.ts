import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';

export interface KnowledgeSemanticGraphIndex {
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>;
}

export function buildKnowledgeSemanticGraphIndex(
  store: KnowledgeStore,
  spaceId: string,
): KnowledgeSemanticGraphIndex {
  const nodes = store.listNodesInSpace(spaceId).filter((node) => node.status !== 'stale');
  const sources = store.listSourcesInSpace(spaceId).filter((source) => source.status !== 'stale');
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const edges = store.listEdges().filter((edge) => (
    isActiveKnowledgeEdge(edge)
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
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
