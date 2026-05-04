import type { KnowledgeStore } from '../store.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphExport } from './types.js';

export function exportHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string },
): HomeGraphExport {
  const state = readHomeGraphState(store, input.spaceId);
  return {
    version: 1,
    exportedAt: Date.now(),
    spaceId: input.spaceId,
    installationId: input.installationId,
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
    extractions: state.extractions,
  };
}

export async function importHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string; readonly data: HomeGraphExport },
): Promise<{
  readonly ok: true;
  readonly spaceId: string;
  readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
}> {
  let sources = 0;
  let nodes = 0;
  let edges = 0;
  let issues = 0;
  let extractions = 0;
  await store.batch(async () => {
    for (const source of input.data.sources ?? []) {
      await store.upsertSource({ ...source, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, source.metadata) });
      sources += 1;
    }
    for (const node of input.data.nodes ?? []) {
      await store.upsertNode({ ...node, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, node.metadata) });
      nodes += 1;
    }
    for (const edge of input.data.edges ?? []) {
      await store.upsertEdge({ ...edge, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, edge.metadata) });
      edges += 1;
    }
    for (const issue of input.data.issues ?? []) {
      await store.upsertIssue({ ...issue, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, issue.metadata) });
      issues += 1;
    }
    for (const extraction of input.data.extractions ?? []) {
      await store.upsertExtraction({ ...extraction, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, extraction.metadata) });
      extractions += 1;
    }
  });
  return { ok: true, spaceId: input.spaceId, imported: { sources, nodes, edges, issues, extractions } };
}
