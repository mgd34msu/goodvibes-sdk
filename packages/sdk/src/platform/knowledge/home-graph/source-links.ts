import type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from '../types.js';
import { factSourceIds } from './helpers.js';

export function buildSourceLinkIndex(
  edges: readonly KnowledgeEdgeRecord[],
  nodes: readonly KnowledgeNodeRecord[] = [],
): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const factTargets = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.fromKind === 'source' && edge.toKind === 'node') {
      addSourceLink(links, edge.fromId, edge.toId);
    } else if (edge.fromKind === 'node' && edge.toKind === 'source') {
      addSourceLink(links, edge.toId, edge.fromId);
    } else if (edge.fromKind === 'node' && edge.toKind === 'node' && edge.relation === 'describes') {
      const current = factTargets.get(edge.fromId) ?? new Set<string>();
      current.add(edge.toId);
      factTargets.set(edge.fromId, current);
    }
  }
  for (const edge of edges) {
    if (edge.fromKind !== 'source' || edge.toKind !== 'node' || edge.relation !== 'supports_fact') continue;
    for (const targetId of factTargets.get(edge.toId) ?? []) {
      addSourceLink(links, edge.fromId, targetId);
    }
  }
  for (const fact of nodes) {
    for (const targetId of factTargets.get(fact.id) ?? []) {
      for (const sourceId of factSourceIds(fact)) addSourceLink(links, sourceId, targetId);
    }
  }
  return links;
}

function addSourceLink(links: Map<string, Set<string>>, sourceId: string, nodeId: string): void {
  const current = links.get(sourceId) ?? new Set<string>();
  current.add(nodeId);
  links.set(sourceId, current);
}
