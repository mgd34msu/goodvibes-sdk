import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFacetValue,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { renderKnowledgeMap } from '../map.js';
import { countFacet, normalizeStringArray, readString } from '../map-filters.js';
import { edgeIsActive, isGeneratedPageSource } from './helpers.js';
import type { HomeGraphMapHaFilterInput, HomeGraphMapInput, HomeGraphMapResult } from './types.js';

export interface HomeGraphRenderState {
  readonly spaceId: string;
  readonly title: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
}

export function renderRoomPage(state: HomeGraphRenderState, areaId?: string): string {
  const area = areaId
    ? findNodeByHaId(state.nodes, 'ha_area', areaId) ?? findNodeByHaId(state.nodes, 'ha_room', areaId)
    : undefined;
  const title = area?.title ?? state.title;
  const areaNodeId = area?.id;
  const entities = state.nodes.filter((node) => (
    node.kind === 'ha_entity'
    && (!areaNodeId || hasActiveEdge(state.edges, node.id, 'located_in', areaNodeId))
  ));
  const devices = state.nodes.filter((node) => (
    node.kind === 'ha_device'
    && (!areaNodeId || hasActiveEdge(state.edges, node.id, 'located_in', areaNodeId))
  ));
  const automations = filterNodesForArea(state.nodes, state.edges, 'ha_automation', areaNodeId);
  const scenes = filterNodesForArea(state.nodes, state.edges, 'ha_scene', areaNodeId);
  const scripts = filterNodesForArea(state.nodes, state.edges, 'ha_script', areaNodeId);
  const relatedNodeIds = new Set([
    ...(areaNodeId ? [areaNodeId] : []),
    ...devices.map((node) => node.id),
    ...entities.map((node) => node.id),
    ...automations.map((node) => node.id),
    ...scenes.map((node) => node.id),
    ...scripts.map((node) => node.id),
  ]);
  const sources = relatedSources(state.sources, state.edges, relatedNodeIds);
  return [
    `# ${title}`,
    '',
    `Knowledge space: \`${state.spaceId}\``,
    '',
    renderNodeList('Devices', devices),
    renderNodeList('Entities', entities),
    renderNodeList('Automations', automations),
    renderNodeList('Scenes', scenes),
    renderNodeList('Scripts', scripts),
    renderSourceList('Linked Sources', sources),
    renderIssueList('Open Issues', state.issues.filter((issue) => issue.status === 'open')),
  ].filter(Boolean).join('\n');
}

export function renderDevicePassportPage(input: {
  readonly spaceId: string;
  readonly device: KnowledgeNodeRecord;
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly missingFields: readonly string[];
}): string {
  return [
    `# ${input.device.title}`,
    '',
    `Knowledge space: \`${input.spaceId}\``,
    '',
    '## Profile',
    '',
    renderMetadataField('Manufacturer', input.device.metadata.manufacturer),
    renderMetadataField('Model', input.device.metadata.model),
    renderMetadataField('Area', readHa(input.device, 'areaId')),
    renderMetadataField('Device id', readHa(input.device, 'deviceId')),
    '',
    renderNodeList('Entities', input.entities),
    renderSourceList('Sources', input.sources),
    renderIssueList('Issues', input.issues),
    input.missingFields.length > 0
      ? ['## Missing Fields', '', ...input.missingFields.map((field) => `- ${field}`), ''].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

export function renderPacketPage(state: HomeGraphRenderState, options: {
  readonly packetKind?: string;
  readonly sharingProfile?: string;
  readonly includeFields?: readonly string[];
  readonly excludeFields?: readonly string[];
} = {}): string {
  const profile = options.sharingProfile ?? 'default';
  const title = options.packetKind ? titleCase(options.packetKind) : state.title;
  const excluded = new Set((options.excludeFields ?? []).map((field) => field.toLowerCase()));
  return [
    `# ${title}`,
    '',
    `Sharing profile: \`${profile}\``,
    `Knowledge space: \`${state.spaceId}\``,
    '',
    excluded.has('devices') ? '' : renderNodeList('Devices', state.nodes.filter((node) => node.kind === 'ha_device')),
    excluded.has('rooms') ? '' : renderNodeList('Rooms', state.nodes.filter((node) => node.kind === 'ha_area' || node.kind === 'ha_room')),
    excluded.has('maintenance') ? '' : renderNodeList('Maintenance', state.nodes.filter((node) => node.kind === 'ha_maintenance_item')),
    excluded.has('troubleshooting') ? '' : renderNodeList('Troubleshooting', state.nodes.filter((node) => node.kind === 'ha_troubleshooting_case')),
    excluded.has('network') ? '' : renderNodeList('Network', state.nodes.filter((node) => node.kind === 'ha_network_node')),
    excluded.has('sources') ? '' : renderSourceList('Sources', state.sources.filter((source) => !isGeneratedPageSource(source))),
    excluded.has('issues') ? '' : renderIssueList('Open Issues', state.issues.filter((issue) => issue.status === 'open')),
  ].filter(Boolean).join('\n');
}

export function renderHomeGraphMap(state: HomeGraphRenderState, options: HomeGraphMapInput = {}): HomeGraphMapResult {
  const filtered = applyHomeGraphMapFilters(state, options.ha);
  const result = renderKnowledgeMap(filtered, {
    ...options,
    title: state.title,
    spaceId: state.spaceId,
  });
  return {
    ...result,
    facets: {
      ...result.facets,
      homeAssistant: buildHomeAssistantMapFacets(state),
    },
  } as HomeGraphMapResult;
}

function applyHomeGraphMapFilters(
  state: HomeGraphRenderState,
  input: HomeGraphMapHaFilterInput | undefined,
): HomeGraphRenderState {
  const filters = normalizeHomeGraphMapFilters(input);
  if (!hasHomeGraphFilters(filters)) return state;
  const nodes = state.nodes.filter((node) => matchesHomeGraphNode(node, state.edges, filters, state.nodes));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceIds = sourceIdsLinkedToNodes(state.edges, nodeIds);
  const sources = state.sources.filter((source) => sourceIds.has(source.id) || matchesHomeGraphSource(source, filters));
  const sourceSet = new Set(sources.map((source) => source.id));
  const issues = state.issues.filter((issue) => (
    (issue.nodeId && nodeIds.has(issue.nodeId))
    || (issue.sourceId && sourceSet.has(issue.sourceId))
  ));
  const visibleIds = new Set([...nodeIds, ...sourceSet, ...issues.map((issue) => issue.id)]);
  const edges = state.edges.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
  return { ...state, nodes, sources, issues, edges };
}

function buildHomeAssistantMapFacets(state: HomeGraphRenderState): Record<string, readonly KnowledgeMapFacetValue[]> {
  return {
    objectKinds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).objectKind ?? node.kind)),
    entityIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).entityId)),
    deviceIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).deviceId)),
    areaIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).areaId)),
    integrationIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).integrationId)),
    integrationDomains: countFacet(state.nodes.map((node) => readIntegrationDomain(node))),
    domains: countFacet(state.nodes.map((node) => readEntityDomain(node))),
    deviceClasses: countFacet(state.nodes.map((node) => readDeviceClass(node))),
    labels: countFacet(state.nodes.flatMap((node) => normalizeStringArray(node.metadata.labels))),
  };
}

function normalizeHomeGraphMapFilters(input: HomeGraphMapHaFilterInput | undefined): Required<HomeGraphMapHaFilterInput> {
  return {
    objectKinds: normalizeStringArray(input?.objectKinds),
    entityIds: normalizeStringArray(input?.entityIds),
    deviceIds: normalizeStringArray(input?.deviceIds),
    areaIds: normalizeStringArray(input?.areaIds),
    integrationIds: normalizeStringArray(input?.integrationIds),
    integrationDomains: normalizeStringArray(input?.integrationDomains),
    domains: normalizeStringArray(input?.domains),
    deviceClasses: normalizeStringArray(input?.deviceClasses),
    labels: normalizeStringArray(input?.labels),
  };
}

function hasHomeGraphFilters(filters: Required<HomeGraphMapHaFilterInput>): boolean {
  return Object.values(filters).some((value) => value.length > 0);
}

function matchesHomeGraphNode(
  node: KnowledgeNodeRecord,
  edges: readonly KnowledgeEdgeRecord[],
  filters: Required<HomeGraphMapHaFilterInput>,
  nodes: readonly KnowledgeNodeRecord[],
): boolean {
  const ha = readHomeAssistantRecord(node);
  return matchesFilter(filters.objectKinds, String(ha.objectKind ?? node.kind), node.kind)
    && matchesFilter(filters.entityIds, readString(ha.entityId), readString(ha.objectId))
    && matchesFilter(filters.deviceIds, readString(ha.deviceId), node.kind === 'ha_device' ? readString(ha.objectId) : undefined)
    && matchesAreaFilter(filters.areaIds, node, edges, nodes)
    && matchesFilter(filters.integrationIds, readString(ha.integrationId), node.kind === 'ha_integration' ? readString(ha.objectId) : undefined)
    && matchesFilter(filters.integrationDomains, readIntegrationDomain(node))
    && matchesFilter(filters.domains, readEntityDomain(node))
    && matchesFilter(filters.deviceClasses, readDeviceClass(node))
    && matchesAny(filters.labels, normalizeStringArray(node.metadata.labels));
}

function matchesHomeGraphSource(source: KnowledgeSourceRecord, filters: Required<HomeGraphMapHaFilterInput>): boolean {
  return matchesAny(filters.labels, [...source.tags, ...normalizeStringArray(source.metadata.labels)]);
}

function matchesAreaFilter(
  areaIds: readonly string[],
  node: KnowledgeNodeRecord,
  edges: readonly KnowledgeEdgeRecord[],
  nodes: readonly KnowledgeNodeRecord[],
): boolean {
  if (areaIds.length === 0) return true;
  const ha = readHomeAssistantRecord(node);
  if (matchesFilter(areaIds, readString(ha.areaId), node.kind === 'ha_area' || node.kind === 'ha_room' ? readString(ha.objectId) : undefined)) {
    return true;
  }
  const targetAreaNodeIds = new Set(nodes
    .filter((candidate) => (candidate.kind === 'ha_area' || candidate.kind === 'ha_room')
      && matchesFilter(areaIds, readString(readHomeAssistantRecord(candidate).objectId), readString(readHomeAssistantRecord(candidate).areaId)))
    .map((candidate) => candidate.id));
  return edges.some((edge) => edgeIsActive(edge)
    && edge.fromId === node.id
    && edge.relation === 'located_in'
    && targetAreaNodeIds.has(edge.toId));
}

function sourceIdsLinkedToNodes(edges: readonly KnowledgeEdgeRecord[], nodeIds: ReadonlySet<string>): Set<string> {
  const sourceIds = new Set<string>();
  for (const edge of edges) {
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source') sourceIds.add(edge.toId);
  }
  return sourceIds;
}

function readHomeAssistantRecord(node: KnowledgeNodeRecord): Record<string, unknown> {
  const value = node.metadata.homeAssistant;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readIntegrationDomain(node: KnowledgeNodeRecord): string | undefined {
  const ha = readHomeAssistantRecord(node);
  return readString(ha.integrationId)
    ?? readString(node.metadata.integrationDomain)
    ?? readString(node.metadata.platform)
    ?? readString(node.metadata.domain);
}

function readEntityDomain(node: KnowledgeNodeRecord): string | undefined {
  const entityId = readString(readHomeAssistantRecord(node).entityId);
  const fromEntity = entityId?.includes('.') ? entityId.split('.')[0] : undefined;
  return fromEntity ?? readString(node.metadata.domain);
}

function readDeviceClass(node: KnowledgeNodeRecord): string | undefined {
  const attributes = node.metadata.attributes && typeof node.metadata.attributes === 'object' && !Array.isArray(node.metadata.attributes)
    ? node.metadata.attributes as Record<string, unknown>
    : {};
  return readString(node.metadata.deviceClass) ?? readString(node.metadata.device_class) ?? readString(attributes.device_class);
}

function matchesFilter(allowed: readonly string[], ...values: readonly (string | undefined)[]): boolean {
  return allowed.length === 0 || values.some((value) => value !== undefined && allowed.includes(value));
}

function matchesAny(allowed: readonly string[], values: readonly string[]): boolean {
  return allowed.length === 0 || values.some((value) => allowed.includes(value));
}

function renderNodeList(title: string, nodes: readonly KnowledgeNodeRecord[]): string {
  if (nodes.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...nodes.slice(0, 100).map((node) => `- ${node.title}${node.summary ? ` - ${node.summary}` : ''}`),
    '',
  ].join('\n');
}

function renderSourceList(title: string, sources: readonly KnowledgeSourceRecord[]): string {
  if (sources.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...sources.slice(0, 100).map((source) => {
      const label = source.title ?? source.sourceUri ?? source.id;
      return `- ${label}${source.sourceUri ? ` (${source.sourceUri})` : ''}`;
    }),
    '',
  ].join('\n');
}

function renderIssueList(title: string, issues: readonly KnowledgeIssueRecord[]): string {
  if (issues.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...issues.slice(0, 100).map((issue) => `- ${issue.severity}: ${issue.message}`),
    '',
  ].join('\n');
}

function renderMetadataField(label: string, value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? `- ${label}: ${value.trim()}` : '';
}

function relatedSources(
  sources: readonly KnowledgeSourceRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
): KnowledgeSourceRecord[] {
  const visibleSources = sources.filter((source) => !isGeneratedPageSource(source));
  if (nodeIds.size === 0) return visibleSources;
  const sourceIds = new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'source'
    && edge.toKind === 'node'
    && nodeIds.has(edge.toId)
  )).map((edge) => edge.fromId));
  return visibleSources.filter((source) => sourceIds.has(source.id));
}

function filterNodesForArea(
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  kind: string,
  areaNodeId?: string,
): KnowledgeNodeRecord[] {
  return nodes.filter((node) => (
    node.kind === kind
    && (!areaNodeId || hasActiveEdge(edges, node.id, 'located_in', areaNodeId))
  ));
}

function hasActiveEdge(
  edges: readonly KnowledgeEdgeRecord[],
  fromId: string,
  relation: string,
  toId: string,
): boolean {
  return edges.some((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.fromId === fromId
    && edge.toKind === 'node'
    && edge.toId === toId
    && edge.relation === relation
  ));
}

function findNodeByHaId(nodes: readonly KnowledgeNodeRecord[], kind: string, id: string): KnowledgeNodeRecord | undefined {
  return nodes.find((node) => node.kind === kind && (
    readHa(node, 'objectId') === id
    || readHa(node, 'areaId') === id
    || node.id === id
  ));
}

function readHa(node: KnowledgeNodeRecord, key: string): string | undefined {
  const homeAssistant = node.metadata.homeAssistant;
  if (!homeAssistant || typeof homeAssistant !== 'object' || Array.isArray(homeAssistant)) return undefined;
  const value = (homeAssistant as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
