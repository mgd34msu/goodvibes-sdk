import { createHash } from 'node:crypto';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeKind,
  KnowledgeNodeRecord,
  KnowledgeReferenceKind,
  KnowledgeIssueUpsertInput,
  KnowledgeSourceRecord,
} from '../types.js';
import {
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
  HomeGraphSearchResult,
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
  const title = object.title ?? object.name ?? object.entityId ?? object.id;
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
  switch (kind) {
    case 'ha_entity':
      return object.entityId ?? object.id;
    case 'ha_device':
    case 'ha_device_passport':
      return object.deviceId ?? object.id;
    case 'ha_area':
    case 'ha_room':
      return object.areaId ?? object.id;
    case 'ha_integration':
      return object.integrationId ?? object.id;
    default:
      return object.id;
  }
}

export function edgeIsActive(edge: KnowledgeEdgeRecord): boolean {
  return edge.metadata.linkStatus !== 'unlinked';
}

export function belongsToSpace(record: { readonly metadata?: Record<string, unknown> } | undefined | null, spaceId: string): boolean {
  return record ? getKnowledgeSpaceId(record) === normalizeKnowledgeSpaceId(spaceId) : false;
}

export function scoreHomeGraphResults(
  query: string,
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  extractionBySourceId: (sourceId: string) => { readonly summary?: string; readonly excerpt?: string; readonly sections: readonly string[] } | null,
  limit: number,
): HomeGraphSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const sourceResults = sources.map((source) => {
    const extraction = extractionBySourceId(source.id);
    const haystack = [
      source.title ?? '',
      source.summary ?? '',
      source.description ?? '',
      source.sourceUri ?? '',
      source.tags.join(' '),
      extraction?.summary ?? '',
      extraction?.excerpt ?? '',
      extraction?.sections.join(' ') ?? '',
    ].join(' ').toLowerCase();
    const baseScore = scoreHaystack(haystack, tokens);
    return {
      kind: 'source' as const,
      id: source.id,
      score: baseScore > 0 ? baseScore + (extraction ? 8 : 0) : 0,
      title: source.title ?? source.sourceUri ?? source.id,
      summary: extraction?.summary ?? source.summary,
      source,
    };
  });
  const nodeResults = nodes.map((node) => {
    const haystack = [
      node.title,
      node.summary ?? '',
      node.aliases.join(' '),
      JSON.stringify(node.metadata),
    ].join(' ').toLowerCase();
    const baseScore = scoreHaystack(haystack, tokens);
    return {
      kind: 'node' as const,
      id: node.id,
      score: baseScore > 0 ? baseScore + Math.round(node.confidence / 20) : 0,
      title: node.title,
      summary: node.summary,
      node,
    };
  });
  return [...sourceResults, ...nodeResults]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
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

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_.:-]+/).map((entry) => entry.trim()).filter(Boolean);
}

function scoreHaystack(haystack: string, tokens: readonly string[]): number {
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 10 : 0), 0);
}
