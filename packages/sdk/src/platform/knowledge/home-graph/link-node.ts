import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { buildHomeGraphMetadata, homeGraphNodeId } from './helpers.js';

export async function linkHomeGraphSnapshotObjectReferences(
  store: KnowledgeStore,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly node: KnowledgeNodeRecord;
    readonly object: { readonly deviceId?: string | undefined; readonly areaId?: string | undefined; readonly integrationId?: string | undefined };
  },
): Promise<void> {
  if (input.object.deviceId && input.node.kind !== 'ha_device') {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'belongs_to_device',
      toKind: 'ha_device',
      toObjectId: input.object.deviceId,
    });
  }
  if (input.object.areaId) {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'located_in',
      toKind: 'ha_area',
      toObjectId: input.object.areaId,
    });
  }
  if (input.object.integrationId) {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'connected_via',
      toKind: 'ha_integration',
      toObjectId: input.object.integrationId,
    });
  }
}

export async function linkHomeGraphNodeReference(
  store: KnowledgeStore,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly fromId: string;
    readonly relation: string;
    readonly toKind: string;
    readonly toObjectId: string;
  },
): Promise<void> {
  const toId = homeGraphNodeId(input.spaceId, input.toKind, input.toObjectId);
  if (input.fromId === toId) return;
  if (!store.getNode(toId)) return;
  await store.upsertEdge({
    fromKind: 'node',
    fromId: input.fromId,
    toKind: 'node',
    toId,
    relation: input.relation,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId),
  });
}
