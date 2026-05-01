import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import { belongsToSpace, edgeIsActive, readRecord } from './helpers.js';
import type { HomeGraphRenderState } from './rendering.js';

export interface HomeGraphState extends Omit<HomeGraphRenderState, 'title'> {
  readonly extractions: readonly KnowledgeExtractionRecord[];
}

export function readHomeGraphState(store: KnowledgeStore, spaceId: string): HomeGraphState {
  const sources = store.listSources(10_000).filter((source) => belongsToSpace(source, spaceId));
  const nodes = store.listNodes(10_000).filter((node) => belongsToSpace(node, spaceId) && node.status !== 'stale');
  const sourceIds = new Set(sources.map((source) => source.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = store.listEdges().filter((edge) => (
    edgeIsActive(edge)
    && belongsToSpace(edge, spaceId)
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
  ));
  const issues = store.listIssues(10_000).filter((issue) => belongsToSpace(issue, spaceId));
  const extractions = store.listExtractions(10_000).filter((extraction) => (
    belongsToSpace(extraction, spaceId) || sourceIds.has(extraction.sourceId)
  ));
  return { spaceId, sources, nodes, edges, issues, extractions };
}

export function renderHomeGraphState(store: KnowledgeStore, spaceId: string, title: string): HomeGraphRenderState {
  const state = readHomeGraphState(store, spaceId);
  return {
    spaceId,
    title,
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
  };
}

export function sourcesLinkedToNode(nodeId: string, state: HomeGraphState): KnowledgeSourceRecord[] {
  const sourceIds = new Set(state.edges.filter((edge) => (
    edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === nodeId
  )).map((edge) => edge.fromId));
  return state.sources.filter((source) => sourceIds.has(source.id));
}

export function collectLinkedObjects(
  results: readonly { readonly source?: KnowledgeSourceRecord; readonly node?: KnowledgeNodeRecord }[],
  state: {
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly nodes: readonly KnowledgeNodeRecord[];
  },
): KnowledgeNodeRecord[] {
  const nodeIds = new Set<string>();
  for (const result of results) {
    if (result.node) nodeIds.add(result.node.id);
    if (result.source) {
      for (const edge of state.edges) {
        if (edge.fromKind === 'source' && edge.fromId === result.source.id && edge.toKind === 'node') {
          nodeIds.add(edge.toId);
        }
      }
    }
  }
  return state.nodes.filter((node) => nodeIds.has(node.id));
}

export function missingDevicePassportFields(
  device: KnowledgeNodeRecord,
  sources: readonly KnowledgeSourceRecord[],
): string[] {
  return [
    typeof device.metadata.manufacturer === 'string' ? '' : 'manufacturer',
    typeof device.metadata.model === 'string' ? '' : 'model',
    devicePassportNeedsBatteryField(device) ? 'battery type' : '',
    sources.length > 0 ? '' : 'manual/source',
  ].filter(Boolean);
}

function devicePassportNeedsBatteryField(device: KnowledgeNodeRecord): boolean {
  if (typeof device.metadata.batteryType === 'string' && device.metadata.batteryType.trim().length > 0) return false;
  if (device.metadata.batteryPowered === false) return false;
  if (device.metadata.batteryPowered === true) return true;
  const text = [
    device.title,
    device.summary,
    ...device.aliases,
    typeof device.metadata.manufacturer === 'string' ? device.metadata.manufacturer : '',
    typeof device.metadata.model === 'string' ? device.metadata.model : '',
  ].join(' ').toLowerCase();
  if (/\b(tv|television|webos|display|monitor|receiver|soundbar|speaker|appliance|outlet|plug|switch|router|bridge|hub|coordinator|adapter|home assistant|integration|software|service|core|supervisor)\b/.test(text)) {
    return false;
  }
  return /\b(battery|button|keypad|leak sensor|motion sensor|contact sensor|door sensor|window sensor|remote|lock|thermostat|cr2032|cr123)\b/.test(text);
}

export function findHomeAssistantNode(
  nodes: readonly KnowledgeNodeRecord[],
  kind: string,
  id: string,
): KnowledgeNodeRecord | undefined {
  return nodes.find((node) => node.kind === kind && (
    node.id === id
    || readHomeAssistantString(node, 'objectId') === id
    || readHomeAssistantString(node, 'deviceId') === id
    || readHomeAssistantString(node, 'areaId') === id
  ));
}

export function inferHomeGraphSourceType(
  tags: readonly string[] | undefined,
  fallback: KnowledgeSourceType,
): KnowledgeSourceType {
  const normalized = new Set((tags ?? []).map((tag) => tag.toLowerCase()));
  if (normalized.has('manual')) return 'manual';
  if (normalized.has('receipt') || normalized.has('warranty')) return 'document';
  if (normalized.has('photo') || normalized.has('image')) return 'image';
  return fallback;
}

export function safeHomeGraphFilename(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'home-graph';
}

export function renderAskAnswer(
  query: string,
  results: readonly { readonly title: string; readonly summary?: string; readonly excerpt?: string; readonly source?: KnowledgeSourceRecord; readonly node?: KnowledgeNodeRecord }[],
  mode: 'concise' | 'standard' | 'detailed',
): string {
  if (results.length === 0) {
    return `No Home Graph knowledge matched "${query}".`;
  }
  const lines = results.slice(0, mode === 'detailed' ? 5 : mode === 'concise' ? 1 : 3).map((result) => {
    const detail = result.excerpt ?? result.summary ?? result.source?.description ?? result.source?.sourceUri ?? '';
    return detail ? `${result.title}: ${detail}` : result.title;
  });
  return mode === 'concise' ? lines[0]! : lines.map((line) => `- ${line}`).join('\n');
}

export function edgeConnectsNode(edge: KnowledgeEdgeRecord, nodeId: string, relation: string, toId: string): boolean {
  return edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.fromId === nodeId
    && edge.toKind === 'node'
    && edge.toId === toId
    && edge.relation === relation;
}

function readHomeAssistantString(node: KnowledgeNodeRecord, key: string): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const value = homeAssistant[key];
  return typeof value === 'string' ? value : undefined;
}
