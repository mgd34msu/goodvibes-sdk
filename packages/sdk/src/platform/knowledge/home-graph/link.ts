import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import {
  belongsToSpace,
  buildHomeGraphMetadata,
  homeGraphNodeId,
  nodeKindForHomeGraphObject,
  targetToReference,
} from './helpers.js';
import type { HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult } from './types.js';

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
): Promise<HomeGraphLinkResult> {
  const linked = await linkHomeGraphKnowledge(store, {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      linkStatus: 'unlinked',
      unlinkedAt: Date.now(),
    },
  });
  return { ...linked, edge: linked.edge };
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
    }),
  };
  const node = await store.upsertNode(nodeInput);
  return { kind: 'node', id: node.id, record: node };
}
