import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFacetValue,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { renderKnowledgeMap } from '../map.js';
import { countFacet, normalizeStringArray, readString } from '../map-filters.js';
import { edgeIsActive, isGeneratedPageSource, uniqueStrings } from './helpers.js';
import type { HomeGraphMapHaFilterInput, HomeGraphMapInput, HomeGraphMapResult } from './types.js';
import { isLowValueFeatureOrSpecText } from '../semantic/fact-quality.js';
import { isUsefulHomeGraphPageFact, isUsefulHomeGraphPageSource } from './page-quality.js';

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
  const semanticFacts = semanticFactsLinkedToSources(sources, state.nodes, state.edges);
  const issues = issuesForScope(state.issues, state.edges, relatedNodeIds, sources);
  return [
    `# ${title}`,
    '',
    `Knowledge space: \`${state.spaceId}\``,
    '',
    renderRoomOverview(title, devices, entities, automations, scenes, scripts),
    renderNodeList('Devices', devices),
    renderNodeList('Entities', entities),
    renderNodeList('Automations', automations),
    renderNodeList('Scenes', scenes),
    renderNodeList('Scripts', scripts),
    renderSemanticFacts('Extracted Facts', semanticFacts),
    renderSourceList('Linked Sources', sources),
    renderIssueList('Open Issues', issues),
  ].filter(Boolean).join('\n');
}

export function renderDevicePassportPage(input: {
  readonly spaceId: string;
  readonly device: KnowledgeNodeRecord;
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly missingFields: readonly string[];
  readonly semanticFacts?: readonly KnowledgeNodeRecord[] | undefined;
}): string {
  return [
    `# ${input.device.title}`,
    '',
    `Knowledge space: \`${input.spaceId}\``,
    '',
    '## Overview',
    '',
    renderDeviceOverview(input.device, input.entities, input.sources),
    '',
    '## Home Assistant Profile',
    '',
    renderMetadataField('Manufacturer', input.device.metadata.manufacturer),
    renderMetadataField('Model', input.device.metadata.model),
    renderMetadataField('Area', readHa(input.device, 'areaId')),
    renderMetadataField('Device id', readHa(input.device, 'deviceId')),
    '',
    renderNodeList('Entities Exposed To Home Assistant', input.entities),
    renderSemanticFacts('Verified Device Facts', input.semanticFacts ?? []),
    renderSourceList('Sources', input.sources),
    renderIssueList('Open Issues', input.issues.filter((issue) => issue.status === 'open')),
    input.missingFields.length > 0
      ? ['## Open Questions', '', ...input.missingFields.map((field) => `- ${field}`), ''].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

export function renderPacketPage(state: HomeGraphRenderState, options: {
  readonly packetKind?: string | undefined;
  readonly sharingProfile?: string | undefined;
  readonly includeFields?: readonly string[] | undefined;
  readonly excludeFields?: readonly string[] | undefined;
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
  const matchedNodeIds = new Set(state.nodes
    .filter((node) => matchesHomeGraphNode(node, state.edges, filters, state.nodes))
    .map((node) => node.id));
  const nodeIds = expandHomeGraphMapNodeIds(state.edges, matchedNodeIds);
  const nodes = state.nodes.filter((node) => nodeIds.has(node.id));
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

function expandHomeGraphMapNodeIds(
  edges: readonly KnowledgeEdgeRecord[],
  matchedNodeIds: ReadonlySet<string>,
): Set<string> {
  const nodeIds = new Set(matchedNodeIds);
  for (const edge of edges) {
    if (!edgeIsActive(edge) || edge.fromKind !== 'node' || edge.toKind !== 'node') continue;
    if (!isContextMapRelation(edge.relation)) continue;
    if (matchedNodeIds.has(edge.fromId)) nodeIds.add(edge.toId);
    if (matchedNodeIds.has(edge.toId)) nodeIds.add(edge.fromId);
  }
  return nodeIds;
}

function isContextMapRelation(relation: string): boolean {
  return relation === 'belongs_to_device'
    || relation === 'located_in'
    || relation === 'connected_via'
    || relation === 'source_for'
    || relation === 'has_manual'
    || relation === 'supports_fact'
    || relation === 'has_gap'
    || relation === 'repairs_gap';
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
  return Object.values(filters).some((value) => value!.length > 0);
}

function matchesHomeGraphNode(
  node: KnowledgeNodeRecord,
  edges: readonly KnowledgeEdgeRecord[],
  filters: Required<HomeGraphMapHaFilterInput>,
  nodes: readonly KnowledgeNodeRecord[],
): boolean {
  const ha = readHomeAssistantRecord(node);
  return matchesFilter(filters.objectKinds!, String(ha.objectKind ?? node.kind), node.kind)
    && matchesFilter(filters.entityIds!, readString(ha.entityId), readString(ha.objectId))
    && matchesFilter(filters.deviceIds!, readString(ha.deviceId), node.kind === 'ha_device' ? readString(ha.objectId) : undefined)
    && matchesAreaFilter(filters.areaIds!, node, edges, nodes)
    && matchesFilter(filters.integrationIds!, readString(ha.integrationId), node.kind === 'ha_integration' ? readString(ha.objectId) : undefined)
    && matchesFilter(filters.integrationDomains!, readIntegrationDomain(node))
    && matchesFilter(filters.domains!, readEntityDomain(node))
    && matchesFilter(filters.deviceClasses!, readDeviceClass(node))
    && matchesAny(filters.labels!, normalizeStringArray(node.metadata.labels));
}

function matchesHomeGraphSource(source: KnowledgeSourceRecord, filters: Required<HomeGraphMapHaFilterInput>): boolean {
  return matchesAny(filters.labels!, [...source.tags, ...normalizeStringArray(source.metadata.labels)]);
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
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source') sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && nodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && factIds.has(edge.toId) && edge.relation === 'supports_fact') {
      sourceIds.add(edge.fromId);
    }
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

function renderRoomOverview(
  title: string,
  devices: readonly KnowledgeNodeRecord[],
  entities: readonly KnowledgeNodeRecord[],
  automations: readonly KnowledgeNodeRecord[],
  scenes: readonly KnowledgeNodeRecord[],
  scripts: readonly KnowledgeNodeRecord[],
): string {
  return [
    '## Overview',
    '',
    `${title} currently has ${devices.length} device(s), ${entities.length} entity record(s), ${automations.length} automation(s), ${scenes.length} scene(s), and ${scripts.length} script(s) in the Home Graph.`,
    '',
  ].join('\n');
}

function renderDeviceOverview(
  device: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[],
  sources: readonly KnowledgeSourceRecord[],
): string {
  const identity = uniqueStrings([
    readMetadataString(device, 'manufacturer'),
    readMetadataString(device, 'model'),
    readHa(device, 'areaId') ? `area ${readHa(device, 'areaId')}` : undefined,
  ]);
  const details = identity.length > 0 ? ` ${identity.join(' - ')}.` : '.';
  return `${device.title}${details} The Home Graph links this device to ${entities.length} Home Assistant entity record(s) and ${sources.length} source(s).`;
}

function readMetadataString(node: KnowledgeNodeRecord, key: string): string | undefined {
  const value = node.metadata[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function renderSourceList(title: string, sources: readonly KnowledgeSourceRecord[]): string {
  if (sources.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...sources.slice(0, 100).map((source) => {
      const uri = source.sourceUri ?? source.url ?? source.canonicalUri;
      const label = source.title ?? uri ?? source.id;
      return `- ${label}${uri ? ` (${uri})` : ''}`;
    }),
    '',
  ].join('\n');
}

function renderSemanticFacts(title: string, facts: readonly KnowledgeNodeRecord[]): string {
  const entries = dedupePageFacts(facts
    .filter(isUsefulHomeGraphPageFact)
    .sort((left, right) => semanticFactSortKey(left).localeCompare(semanticFactSortKey(right)) || left.title.localeCompare(right.title)))
    .slice(0, 80);
  if (entries.length === 0) return '';
  const groups = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of entries) {
    const kind = readString(fact.metadata.factKind) ?? 'fact';
    groups.set(kind, [...(groups.get(kind) ?? []), fact]);
  }
  return [
    `## ${title}`,
    '',
    ...[...groups.entries()].flatMap(([kind, group]) => [
      `### ${titleCase(kind)}`,
      '',
      ...group.slice(0, 24).map(renderPageFactLine).filter(Boolean),
      '',
    ]),
  ].join('\n');
}

function dedupePageFacts(facts: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeNodeRecord[] = [];
  for (const fact of facts) {
    const key = normalizePageFactText(renderPageFactLine(fact));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function renderPageFactLine(fact: KnowledgeNodeRecord): string {
  const title = cleanPageFactTitle(fact.title);
  if (!title) return '';
  const value = cleanPageFactDetail(readString(fact.metadata.value));
  const summary = cleanPageFactDetail(fact.summary);
  const evidence = cleanPageFactDetail(readString(fact.metadata.evidence));
  const canonicalValue = selectPageFactValue(title, value, summary, evidence);
  const detail = selectPageFactDetail(title, canonicalValue, summary, evidence);
  const line = normalizePageFactLine(`- ${title}${canonicalValue ? `: ${canonicalValue}` : ''}${detail ? ` - ${detail}` : ''}`);
  return isLowValueFeatureOrSpecText(line) ? '' : line;
}

function selectPageFactValue(
  title: string,
  value: string | undefined,
  summary: string | undefined,
  evidence: string | undefined,
): string | undefined {
  for (const candidate of [value, extractSummaryValue(title, summary), extractSummaryValue(title, evidence)]) {
    if (!candidate) continue;
    if (isLowValueFeatureOrSpecText(candidate)) continue;
    if (isRedundantPageFactDetail(title, undefined, candidate)) continue;
    return candidate;
  }
  return undefined;
}

function selectPageFactDetail(
  title: string,
  value: string | undefined,
  summary: string | undefined,
  evidence: string | undefined,
): string | undefined {
  for (const detail of [summary, evidence]) {
    if (!detail) continue;
    const normalized = normalizePageFactText(detail);
    if (!normalized) continue;
    if (isRedundantPageFactDetail(title, value, detail)) continue;
    return detail;
  }
  return undefined;
}

function extractSummaryValue(title: string, detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  const titlePattern = escapeRegExp(title.trim()).replace(/\s+/g, '\\s+');
  const match = trimmed.match(new RegExp(`^${titlePattern}\\s*[:\\-]\\s*(.+?)\\.?$`, 'i'));
  return match?.[1] ? match[1].trim() : undefined;
}

function isRedundantPageFactDetail(title: string, value: string | undefined, detail: string): boolean {
  const normalized = normalizePageFactText(detail);
  if (!normalized) return true;
  const normalizedTitle = normalizePageFactText(title);
  const normalizedValue = normalizePageFactText(value ?? '');
  const extractedValue = normalizePageFactText(extractSummaryValue(title, detail) ?? '');
  if (normalized === normalizedTitle || normalized === normalizedValue) return true;
  if (normalizedValue && extractedValue && normalizedFactValuesEquivalent(normalizedValue, extractedValue)) return true;
  if (normalizedValue && normalized === normalizePageFactText(`${title}: ${value}.`)) return true;
  if (normalizedTitle && normalizedValue && normalized.includes(normalizedTitle) && normalized.includes(normalizedValue)) return true;
  if (normalizedTitle && normalized.startsWith(`${normalizedTitle} `) && normalized.length <= normalizedTitle.length + 12) return true;
  return false;
}

function normalizedFactValuesEquivalent(left: string, right: string): boolean {
  const normalizeTokens = (value: string): string[] => value
    .split(/\s+/)
    .filter((token) => token !== 'and')
    .filter(Boolean);
  const leftTokens = normalizeTokens(left);
  const rightTokens = normalizeTokens(right);
  const leftText = leftTokens.join(' ');
  const rightText = rightTokens.join(' ');
  if (leftText === rightText) return true;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = new Set(leftTokens.length <= rightTokens.length ? rightTokens : leftTokens);
  if (shorter.length === 0) return false;
  const shared = shorter.filter((token) => longer.has(token)).length;
  return shared / shorter.length >= 0.75;
}

function cleanPageFactDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || isLowValueFeatureOrSpecText(trimmed)) return undefined;
  return trimmed;
}

function cleanPageFactTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = normalizePageFactLine(value.trim());
  if (!trimmed || isLowValueFeatureOrSpecText(trimmed)) return undefined;
  if (trimmed.length > 120 && /\b(hdmi|usb|hdr|speaker|audio|ports?|features?|selected|motion|freesync|quantity|table)\b/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizePageFactLine(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\b([A-Za-z][A-Za-z0-9/+.-]*(?:\s+[A-Za-z][A-Za-z0-9/+.-]*){1,5})\b\s+\1\b/gi, '$1')
    .trim();
}

function normalizePageFactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function semanticFactsLinkedToSources(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
): KnowledgeNodeRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const factIds = new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'source'
    && sourceIds.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.relation === 'supports_fact'
  )).map((edge) => edge.toId));
  return nodes.filter((node) => factIds.has(node.id) && isUsefulHomeGraphPageFact(node));
}

function semanticFactSortKey(node: KnowledgeNodeRecord): string {
  const order: Record<string, string> = {
    feature: '01',
    capability: '02',
    specification: '03',
    configuration: '04',
    compatibility: '05',
    procedure: '06',
    maintenance: '07',
    troubleshooting: '08',
    warning: '09',
  };
  return order[readString(node.metadata.factKind) ?? ''] ?? '99';
}

function renderIssueList(title: string, issues: readonly KnowledgeIssueRecord[]): string {
  const entries = issues.filter(isUsefulHomeGraphPageIssue);
  if (entries.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...entries.slice(0, 100).map((issue) => `- ${issue.severity}: ${issue.message}`),
    '',
  ].join('\n');
}

function isUsefulHomeGraphPageIssue(issue: KnowledgeIssueRecord): boolean {
  if (issue.status !== 'open') return false;
  if (issue.code.startsWith('knowledge.')) return false;
  if (isLowValueFeatureOrSpecText(issue.message)) return false;
  return true;
}

export function issuesForScope(
  issues: readonly KnowledgeIssueRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
  sources: readonly KnowledgeSourceRecord[],
): KnowledgeIssueRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const scopedNodeIds = expandScopedIssueNodeIds(edges, nodeIds, sourceIds);
  return issues.filter((issue) => (
    issue.status === 'open'
    && (
      (issue.nodeId !== undefined && scopedNodeIds.has(issue.nodeId))
      || (issue.sourceId !== undefined && sourceIds.has(issue.sourceId))
    )
  ));
}

function expandScopedIssueNodeIds(
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
  sourceIds: ReadonlySet<string>,
): Set<string> {
  const scoped = new Set(nodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!edgeIsActive(edge)) continue;
      if (edge.toKind !== 'node') continue;
      const fromScopedNode = edge.fromKind === 'node' && scoped.has(edge.fromId);
      const fromScopedSource = edge.fromKind === 'source' && sourceIds.has(edge.fromId);
      if ((fromScopedNode || fromScopedSource) && isIssueRelation(edge.relation) && !scoped.has(edge.toId)) {
        scoped.add(edge.toId);
        changed = true;
      }
    }
  }
  return scoped;
}

function isIssueRelation(relation: string): boolean {
  return relation === 'has_gap'
    || relation === 'has_issue'
    || relation === 'source_for'
    || relation === 'supports_fact'
    || relation === 'mentions';
}

function renderMetadataField(label: string, value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? `- ${label}: ${value.trim()}` : '';
}

function relatedSources(
  sources: readonly KnowledgeSourceRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
): KnowledgeSourceRecord[] {
  const visibleSources = sources.filter((source) => !isGeneratedPageSource(source) && isUsefulHomeGraphPageSource(source));
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
