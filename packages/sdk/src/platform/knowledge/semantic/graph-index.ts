import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';

export interface KnowledgeSemanticGraphIndex {
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly nodesById: ReadonlyMap<string, KnowledgeNodeRecord>;
  readonly sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>;
}

export function buildKnowledgeSemanticGraphIndex(
  store: KnowledgeStore,
  spaceId: string,
): KnowledgeSemanticGraphIndex {
  return {
    edges: store.listEdges(),
    nodesById: new Map(store.listNodesInSpace(spaceId).map((node) => [node.id, node])),
    sourcesById: new Map(store.listSourcesInSpace(spaceId).map((source) => [source.id, source])),
  };
}
