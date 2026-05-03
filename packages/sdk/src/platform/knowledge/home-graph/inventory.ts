import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphSpaceInput } from './types.js';

export async function listHomeGraphSources(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly sources: readonly KnowledgeSourceRecord[] }> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  return { ok: true, spaceId, sources: readHomeGraphState(input.store, spaceId).sources.slice(0, Math.max(1, input.limit ?? 100)) };
}

export async function browseHomeGraph(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number;
}): Promise<{
  readonly ok: true;
  readonly spaceId: string;
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
}> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const limit = Math.max(1, input.limit ?? 250);
  const state = readHomeGraphState(input.store, spaceId);
  return {
    ok: true,
    spaceId,
    nodes: state.nodes.slice(0, limit),
    edges: state.edges.slice(0, limit),
    sources: state.sources.slice(0, limit),
    issues: state.issues.slice(0, limit),
  };
}
