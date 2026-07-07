import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import {
  belongsToSpace,
  buildHomeGraphMetadata,
  homeGraphNodeId,
  nodeKindForHomeGraphObject,
  targetToReference,
} from './helpers.js';
import type { HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult, HomeGraphUnlinkResult } from './types.js';

type ResolvedLinkTarget = {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly record: KnowledgeSourceRecord | KnowledgeNodeRecord | null;
};

export async function linkHomeGraphKnowledge(
  store: KnowledgeStore,
  input: HomeGraphLinkInput & { readonly spaceId: string; readonly installationId: string },
): Promise<HomeGraphLinkResult> {
  const from = resolveLinkSource(store, input.spaceId, input);
  const target = await ensureHomeGraphLinkTarget(store, input.spaceId, input.installationId, input.target);
  const relation = input.relation ?? input.target.relation ?? 'source_for';
  const edge = await store.upsertEdge({
    fromKind: from.kind,
    fromId: from.id,
    toKind: target.kind,
    toId: target.id,
    relation,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      ...(input.metadata ?? {}),
      linkStatus: typeof input.metadata?.linkStatus === 'string' ? input.metadata.linkStatus : 'active',
    }),
  });
  return { ok: true, spaceId: input.spaceId, edge, target: target.record };
}

export async function unlinkHomeGraphKnowledge(
  store: KnowledgeStore,
  input: HomeGraphLinkInput & { readonly spaceId: string; readonly installationId: string },
): Promise<HomeGraphUnlinkResult> {
  const from = resolveLinkSource(store, input.spaceId, input);
  const target = resolveExistingHomeGraphTarget(store, input.spaceId, input.target);
  const relation = input.relation ?? input.target.relation ?? 'source_for';
  // Never-linked target: nothing to reverse, and we materialize no phantom records.
  if (!target) {
    return { ok: true, spaceId: input.spaceId, reversed: false, target: null };
  }
  const edge = findHomeGraphLinkEdge(store, from, target, relation);
  if (!edge) {
    return { ok: true, spaceId: input.spaceId, reversed: false, target: target.record };
  }
  await store.deleteEdge(edge.id);
  let removedNodeId: string | undefined;
  if (
    target.kind === 'node'
    && target.record
    && wasLinkCreatedNode(target.record as KnowledgeNodeRecord)
    && !hasOtherActiveEdges(store, target.id, edge.id)
  ) {
    await store.deleteNode(target.id);
    removedNodeId = target.id;
  }
  return {
    ok: true,
    spaceId: input.spaceId,
    reversed: true,
    removedEdgeId: edge.id,
    ...(removedNodeId ? { removedNodeId } : {}),
    target: target.record,
  };
}

function resolveExistingHomeGraphTarget(
  store: KnowledgeStore,
  spaceId: string,
  target: HomeGraphKnowledgeTarget,
): ResolvedLinkTarget | null {
  const ref = targetToReference(target);
  if (ref.kind === 'source') {
    const source = store.getSource(ref.id);
    return source && belongsToSpace(source, spaceId) ? { kind: 'source', id: source.id, record: source } : null;
  }
  const existing = store.getNode(ref.id);
  if (existing && belongsToSpace(existing, spaceId)) return { kind: 'node', id: existing.id, record: existing };
  const kind = ref.nodeKind ?? nodeKindForHomeGraphObject(target.kind as never);
  const deterministic = store.getNode(homeGraphNodeId(spaceId, kind, ref.id));
  return deterministic && belongsToSpace(deterministic, spaceId)
    ? { kind: 'node', id: deterministic.id, record: deterministic }
    : null;
}

function findHomeGraphLinkEdge(
  store: KnowledgeStore,
  from: { readonly kind: 'source' | 'node'; readonly id: string },
  target: ResolvedLinkTarget,
  relation: string,
): KnowledgeEdgeRecord | undefined {
  return store.edgesFor(from.kind, from.id).find((edge) => (
    edge.fromKind === from.kind
    && edge.fromId === from.id
    && edge.toKind === target.kind
    && edge.toId === target.id
    && edge.relation === relation
  ));
}

function wasLinkCreatedNode(node: KnowledgeNodeRecord): boolean {
  return node.metadata.linkCreated === true;
}

function hasOtherActiveEdges(store: KnowledgeStore, nodeId: string, excludeEdgeId: string): boolean {
  return store.edgesFor('node', nodeId).some((edge) => edge.id !== excludeEdgeId && isActiveKnowledgeEdge(edge));
}

function resolveLinkSource(
  store: KnowledgeStore,
  spaceId: string,
  input: HomeGraphLinkInput,
): { readonly kind: 'source' | 'node'; readonly id: string } {
  if (input.sourceId) {
    const source = store.getSource(input.sourceId);
    if (!source || !belongsToSpace(source, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph source: ${input.sourceId}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'source', id: source.id };
  }
  if (input.nodeId) {
    const node = store.getNode(input.nodeId);
    if (!node || !belongsToSpace(node, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph node: ${input.nodeId}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'node', id: node.id };
  }
  throw new GoodVibesSdkError('linkKnowledge requires sourceId or nodeId.', {
    category: 'bad_request',
    source: 'runtime',
    recoverable: false,
  });
}

async function ensureHomeGraphLinkTarget(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  target: HomeGraphKnowledgeTarget,
): Promise<{
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly record: KnowledgeSourceRecord | KnowledgeNodeRecord | null;
}> {
  const ref = targetToReference(target);
  if (ref.kind === 'source') {
    const source = store.getSource(ref.id);
    if (!source || !belongsToSpace(source, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph source target: ${ref.id}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'source', id: source.id, record: source };
  }
  const existing = store.getNode(ref.id);
  if (existing && belongsToSpace(existing, spaceId)) return { kind: 'node', id: existing.id, record: existing };
  const kind = ref.nodeKind ?? nodeKindForHomeGraphObject(target.kind as never);
  const deterministicId = homeGraphNodeId(spaceId, kind, ref.id);
  const deterministic = store.getNode(deterministicId);
  if (deterministic && belongsToSpace(deterministic, spaceId)) {
    return { kind: 'node', id: deterministic.id, record: deterministic };
  }
  const nodeInput: KnowledgeNodeUpsertInput = {
    id: ref.id.startsWith('hg-node-') ? ref.id : deterministicId,
    kind,
    slug: `${spaceId.replace(/[^a-z0-9]+/gi, '-')}-${kind}-${target.id.replace(/[^a-z0-9]+/gi, '-')}`,
    title: target.title ?? target.id,
    aliases: [target.id],
    confidence: 60,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeAssistant: { installationId, objectKind: kind, objectId: target.id },
      // Marks a node the link itself materialized, so unlink can cleanly remove it
      // (and only it) on reversal.
      linkCreated: true,
    }),
  };
  const node = await store.upsertNode(nodeInput);
  return { kind: 'node', id: node.id, record: node };
}
