import { createHash } from 'node:crypto';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeKind,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeReferenceKind,
  KnowledgeIssueUpsertInput,
} from '../types.js';
import {
  isGeneratedKnowledgeSource,
} from '../generated-projections.js';
import {
  HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX,
  getKnowledgeSpaceId,
  homeAssistantKnowledgeSpaceId,
  knowledgeSpaceMetadata,
  normalizeHomeAssistantInstallationId,
  normalizeKnowledgeSpaceId,
  normalizeSpaceComponent,
} from '../spaces.js';
import type {
  HomeGraphKnowledgeTarget,
  HomeGraphNodeKind,
  HomeGraphObjectInput,
  HomeGraphObjectKind,
  HomeGraphSpaceInput,
} from './types.js';

export const HOME_GRAPH_CONNECTOR_ID = 'homeassistant';

const NODE_KIND_BY_OBJECT: Record<HomeGraphObjectKind, HomeGraphNodeKind> = {
  home: 'ha_home',
  entity: 'ha_entity',
  device: 'ha_device',
  area: 'ha_area',
  automation: 'ha_automation',
  script: 'ha_script',
  scene: 'ha_scene',
  label: 'ha_label',
  integration: 'ha_integration',
  room: 'ha_room',
  device_passport: 'ha_device_passport',
  maintenance_item: 'ha_maintenance_item',
  troubleshooting_case: 'ha_troubleshooting_case',
  purchase: 'ha_purchase',
  network_node: 'ha_network_node',
};

const OBJECT_KIND_BY_NODE: Partial<Record<HomeGraphNodeKind, HomeGraphObjectKind>> = Object.fromEntries(
  Object.entries(NODE_KIND_BY_OBJECT).map(([objectKind, nodeKind]) => [nodeKind, objectKind]),
) as Partial<Record<HomeGraphNodeKind, HomeGraphObjectKind>>;

export function resolveHomeGraphSpace(input: HomeGraphSpaceInput = {}): {
  readonly spaceId: string;
  readonly installationId: string;
} {
  const installationId = normalizeHomeAssistantInstallationId(input.installationId);
  const spaceId = input.knowledgeSpaceId
    ? normalizeKnowledgeSpaceId(input.knowledgeSpaceId)
    : homeAssistantKnowledgeSpaceId(installationId);
  return {
    spaceId,
    installationId: spaceId.startsWith('homeassistant:')
      ? normalizeHomeAssistantInstallationId(spaceId.slice('homeassistant:'.length))
      : installationId,
  };
}

export function nodeKindForHomeGraphObject(kind: HomeGraphObjectKind | HomeGraphNodeKind): HomeGraphNodeKind {
  if (kind.startsWith('ha_')) return kind as HomeGraphNodeKind;
  return NODE_KIND_BY_OBJECT[kind as HomeGraphObjectKind] ?? 'ha_entity';
}

export function objectKindForNodeKind(kind: HomeGraphNodeKind): HomeGraphObjectKind {
  return OBJECT_KIND_BY_NODE[kind] ?? 'entity';
}

export function homeGraphSourceId(spaceId: string, kind: string, value: string): string {
  return `hg-src-${stableHash(`${spaceId}:${kind}:${value}`)}`;
}

export function homeGraphNodeId(spaceId: string, kind: string, objectId: string): string {
  return `hg-node-${stableHash(`${spaceId}:${kind}:${objectId}`)}`;
}

export function homeGraphEdgeId(spaceId: string, fromId: string, relation: string, toId: string): string {
  return `hg-edge-${stableHash(`${spaceId}:${fromId}:${relation}:${toId}`)}`;
}

export function homeGraphIssueId(spaceId: string, code: string, subjectId: string): string {
  return `hg-issue-${stableHash(`${spaceId}:${code}:${subjectId}`)}`;
}

export function namespacedCanonicalUri(spaceId: string, kind: string, value: string): string {
  return `homegraph://${encodeURIComponent(spaceId)}/${kind}/${stableHash(value, 16)}`;
}

export function buildHomeGraphMetadata(
  spaceId: string,
  installationId: string,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return knowledgeSpaceMetadata(spaceId, {
    ...metadata,
    homeGraph: true,
    homeAssistant: {
      ...readRecord(metadata.homeAssistant),
      installationId,
    },
  });
}

export function buildHomeGraphNodeInput(
  spaceId: string,
  installationId: string,
  kind: HomeGraphObjectKind | HomeGraphNodeKind,
  object: HomeGraphObjectInput,
): {
  readonly id: string;
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly aliases: readonly string[];
  readonly metadata: Record<string, unknown>;
} {
  const nodeKind = nodeKindForHomeGraphObject(kind);
  const objectKind = objectKindForNodeKind(nodeKind);
  const objectId = homeGraphObjectId(nodeKind, object);
  const title = object.title ?? object.name ?? object.entityId ?? object.id ?? objectId;
  const aliases = uniqueStrings([
    ...(object.aliases ?? []),
    ...(object.labels ?? []),
    object.entityId,
    object.name,
  ]);
  return {
    id: homeGraphNodeId(spaceId, nodeKind, objectId),
    kind: nodeKind,
    slug: `${normalizeSpaceComponent(spaceId)}-${nodeKind}-${normalizeSpaceComponent(objectId)}`,
    title,
    ...(buildObjectSummary(object) ? { summary: buildObjectSummary(object) } : {}),
    aliases,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      ...(object.metadata ?? {}),
      homeAssistant: {
        installationId,
        objectKind,
        objectId,
        ...(object.entityId ? { entityId: object.entityId } : {}),
        ...(object.deviceId ? { deviceId: object.deviceId } : {}),
        ...(object.areaId ? { areaId: object.areaId } : {}),
        ...(object.integrationId ? { integrationId: object.integrationId } : {}),
      },
      labels: object.labels ? [...object.labels] : [],
      ...(object.manufacturer ? { manufacturer: object.manufacturer } : {}),
      ...(object.model ? { model: object.model } : {}),
    }),
  };
}

function homeGraphObjectId(kind: HomeGraphNodeKind, object: HomeGraphObjectInput): string {
  const fallback = () => `unknown-${stableHash(`${kind}:${stableJson(object)}`, 16)}`;
  switch (kind) {
    case 'ha_entity':
      return object.entityId ?? object.id ?? fallback();
    case 'ha_device':
    case 'ha_device_passport':
      return object.deviceId ?? object.id ?? fallback();
    case 'ha_area':
    case 'ha_room':
      return object.areaId ?? object.id ?? fallback();
    case 'ha_integration':
      return object.integrationId ?? object.id ?? fallback();
    default:
      return object.id ?? fallback();
  }
}

export function edgeIsActive(edge: KnowledgeEdgeRecord): boolean {
  return edge.metadata.linkStatus !== 'unlinked';
}

export function isGeneratedPageSource(source: KnowledgeSourceRecord): boolean {
  return isGeneratedKnowledgeSource(source);
}

export function belongsToSpace(record: { readonly metadata?: Record<string, unknown> } | undefined | null, spaceId: string): boolean {
  if (!record) return false;
  const recordSpaceId = getKnowledgeSpaceId(record);
  const targetSpaceId = normalizeKnowledgeSpaceId(spaceId);
  return recordSpaceId === targetSpaceId || sameHomeAssistantSpace(recordSpaceId, targetSpaceId);
}

export function sameHomeAssistantSpace(left: string, right: string): boolean {
  const leftComponent = homeAssistantSpaceComponent(left);
  const rightComponent = homeAssistantSpaceComponent(right);
  return Boolean(leftComponent && rightComponent && leftComponent === rightComponent);
}

export function homeAssistantSpaceComponent(spaceId: string): string | undefined {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (!normalized.toLowerCase().startsWith(HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX)) return undefined;
  return normalizeSpaceComponent(normalized.slice(HOME_ASSISTANT_KNOWLEDGE_SPACE_PREFIX.length));
}

export function targetToReference(target: HomeGraphKnowledgeTarget): {
  readonly kind: KnowledgeReferenceKind;
  readonly id: string;
  readonly nodeKind?: HomeGraphNodeKind;
} {
  if (target.kind === 'source') return { kind: 'source', id: target.id };
  if (target.kind === 'node') return { kind: 'node', id: target.id };
  return {
    kind: 'node',
    id: target.id,
    nodeKind: nodeKindForHomeGraphObject(target.kind),
  };
}

export function buildIssue(
  spaceId: string,
  installationId: string,
  code: string,
  message: string,
  subject: { readonly nodeId?: string; readonly sourceId?: string },
): KnowledgeIssueUpsertInput {
  const subjectId = subject.nodeId ?? subject.sourceId ?? message;
  return {
    id: homeGraphIssueId(spaceId, code, subjectId),
    severity: 'warning',
    code,
    message,
    ...subject,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      namespace: `homegraph:${spaceId}:quality`,
      subjectId,
    }),
  };
}

export function stableHash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readHomeAssistantMetadataString(
  node: { readonly metadata: Record<string, unknown> },
  ...keys: readonly string[]
): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  for (const key of keys) {
    const value = readString(homeAssistant[key]);
    if (value) return value;
  }
  return undefined;
}

export function normalizeHomeGraphObjectInput(
  kind: HomeGraphObjectKind | HomeGraphNodeKind,
  value: HomeGraphObjectInput | Record<string, unknown>,
): HomeGraphObjectInput {
  const raw = readRecord(value);
  const attributes = readRecord(raw.attributes);
  const entityId = readString(raw.entityId) ?? readString(raw.entity_id);
  const deviceId = readString(raw.deviceId) ?? readString(raw.device_id);
  const areaId = readString(raw.areaId) ?? readString(raw.area_id);
  const integrationId = readString(raw.integrationId)
    ?? readString(raw.integration_id)
    ?? readString(raw.platform)
    ?? readString(raw.domain);
  const name = readString(raw.name)
    ?? readString(raw.originalName)
    ?? readString(raw.original_name)
    ?? readString(attributes.friendly_name);
  const title = readString(raw.title) ?? name ?? entityId ?? deviceId ?? areaId ?? integrationId;
  const id = readString(raw.id)
    ?? idForKind(kind, { entityId, deviceId, areaId, integrationId })
    ?? readString(raw.uniqueId)
    ?? readString(raw.unique_id)
    ?? readString(raw.slug)
    ?? title
    ?? `unknown-${stableHash(`${nodeKindForHomeGraphObject(kind)}:${stableJson(raw)}`, 16)}`;
  const labels = uniqueStrings([
    ...readStringArray(raw.labels),
    ...readStringArray(raw.labelIds),
    ...readStringArray(raw.label_ids),
  ]);
  const manufacturer = readString(raw.manufacturer);
  const model = readString(raw.model) ?? readString(raw.modelId) ?? readString(raw.model_id);
  const aliases = uniqueStrings([
    ...readStringArray(raw.aliases),
    ...readStringArray(raw.alternateNames),
    ...readStringArray(raw.alternate_names),
    readString(raw.friendlyName),
    readString(raw.friendly_name),
    readString(attributes.friendly_name),
  ]);
  const metadata = {
    ...readRecord(raw.metadata),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(readString(raw.state) ? { state: readString(raw.state) } : {}),
    sourceFieldStyle: hasSnakeCaseHomeAssistantFields(raw) ? 'homeassistant-snake-case' : 'sdk-camel-case',
  };
  return {
    id,
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(entityId ? { entityId } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(areaId ? { areaId } : {}),
    ...(integrationId ? { integrationId } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(model ? { model } : {}),
    metadata,
  };
}

function idForKind(
  kind: HomeGraphObjectKind | HomeGraphNodeKind,
  input: {
    readonly entityId?: string;
    readonly deviceId?: string;
    readonly areaId?: string;
    readonly integrationId?: string;
  },
): string | undefined {
  switch (nodeKindForHomeGraphObject(kind)) {
    case 'ha_entity':
      return input.entityId;
    case 'ha_device':
    case 'ha_device_passport':
      return input.deviceId;
    case 'ha_area':
    case 'ha_room':
      return input.areaId;
    case 'ha_integration':
      return input.integrationId;
    default:
      return input.entityId ?? input.deviceId ?? input.areaId ?? input.integrationId;
  }
}

export function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map((entry) => readString(entry)));
}

export function mergeSourceStatus(
  incoming: KnowledgeSourceRecord['status'],
  existing: KnowledgeSourceRecord['status'] | undefined,
): KnowledgeSourceRecord['status'] {
  if (!existing) return incoming;
  return sourceStatusRank(incoming) >= sourceStatusRank(existing) ? incoming : existing;
}

function sourceStatusRank(status: KnowledgeSourceRecord['status']): number {
  switch (status) {
    case 'indexed':
      return 4;
    case 'pending':
      return 3;
    case 'failed':
      return 1;
    case 'stale':
      return 0;
  }
}

function hasSnakeCaseHomeAssistantFields(raw: Record<string, unknown>): boolean {
  return ['entity_id', 'device_id', 'area_id', 'integration_id', 'unique_id', 'original_name', 'model_id', 'label_ids']
    .some((key) => key in raw);
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
    });
  } catch (error) {
    void error;
    return String(value);
  }
}

function buildObjectSummary(object: HomeGraphObjectInput): string | undefined {
  const parts = uniqueStrings([
    object.manufacturer,
    object.model,
    object.areaId ? `area ${object.areaId}` : undefined,
    object.deviceId ? `device ${object.deviceId}` : undefined,
    object.integrationId ? `integration ${object.integrationId}` : undefined,
  ]);
  return parts.length > 0 ? parts.join(' - ') : undefined;
}
