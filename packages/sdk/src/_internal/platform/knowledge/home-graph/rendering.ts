import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { renderKnowledgeMap } from '../map.js';
import { edgeIsActive, isGeneratedPageSource } from './helpers.js';
import type { HomeGraphMapResult } from './types.js';

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

export function renderHomeGraphMap(state: HomeGraphRenderState, options: {
  readonly limit?: number;
  readonly includeSources?: boolean;
} = {}): HomeGraphMapResult {
  return renderKnowledgeMap(state, {
    ...options,
    title: state.title,
    spaceId: state.spaceId,
  }) as HomeGraphMapResult;
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
