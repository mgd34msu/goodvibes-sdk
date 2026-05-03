import type { ArtifactStore } from '../../artifacts/index.js';
import {
  listGeneratedKnowledgePages,
  type GeneratedKnowledgePageGraph,
} from '../generated-pages.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedPageSource, readRecord } from './helpers.js';
import type { HomeGraphPageGraphNode, HomeGraphPageListResult } from './types.js';

export async function listHomeGraphPages(input: {
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
}): Promise<HomeGraphPageListResult> {
  return listGeneratedKnowledgePages<HomeGraphPageGraphNode>({
    artifactStore: input.artifactStore,
    spaceId: input.spaceId,
    sources: input.sources,
    nodes: input.nodes,
    edges: input.edges,
    limit: input.limit,
    includeMarkdown: input.includeMarkdown,
    isGeneratedSource: isGeneratedPageSource,
    isPageSubjectNode,
    resolvePageSubject,
    projectNode: pageGraphNode,
    compareGeneratedPages,
  });
}

function resolvePageSubject(target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph): KnowledgeNodeRecord | undefined {
  if (target.kind === 'ha_device_passport') {
    const deviceEdge = graph.edges.find((edge) => (
      edge.fromKind === 'node'
      && edge.fromId === target.id
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
    ));
    return deviceEdge ? graph.nodesById.get(deviceEdge.toId) : undefined;
  }
  if (isPageSubjectNode(target)) return target;
  return undefined;
}

function isPageSubjectNode(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (node.metadata.semanticKind) return false;
  return !['fact', 'knowledge_gap', 'wiki_page', 'ha_device_passport'].includes(node.kind);
}

function pageGraphNode(node: KnowledgeNodeRecord): HomeGraphPageGraphNode {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(typeof ha.objectKind === 'string' ? { objectKind: ha.objectKind } : {}),
    ...(typeof ha.objectId === 'string' ? { objectId: ha.objectId } : {}),
    ...(typeof ha.entityId === 'string' ? { entityId: ha.entityId } : {}),
    ...(typeof ha.deviceId === 'string' ? { deviceId: ha.deviceId } : {}),
    ...(typeof ha.areaId === 'string' ? { areaId: ha.areaId } : {}),
    ...(typeof ha.integrationId === 'string' ? { integrationId: ha.integrationId } : {}),
  };
}

function compareGeneratedPages(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord, graph: GeneratedKnowledgePageGraph): number {
  const leftKind = typeof left.metadata.projectionKind === 'string' ? left.metadata.projectionKind : '';
  const rightKind = typeof right.metadata.projectionKind === 'string' ? right.metadata.projectionKind : '';
  return generatedPagePriority(right, graph) - generatedPagePriority(left, graph)
    || leftKind.localeCompare(rightKind)
    || (left.title ?? left.id).localeCompare(right.title ?? right.id)
    || left.id.localeCompare(right.id);
}

function generatedPagePriority(source: KnowledgeSourceRecord, graph: GeneratedKnowledgePageGraph): number {
  const target = graph.targetBySourceId.get(source.id);
  const subject = target ? resolvePageSubject(target, graph) : undefined;
  const projectionKind = typeof source.metadata.projectionKind === 'string' ? source.metadata.projectionKind : '';
  const subjectMetadata = subject?.metadata ?? {};
  const text = [
    source.title,
    source.summary,
    subject?.title,
    subject?.summary,
    typeof subjectMetadata.manufacturer === 'string' ? subjectMetadata.manufacturer : undefined,
    typeof subjectMetadata.model === 'string' ? subjectMetadata.model : undefined,
  ].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  if (projectionKind === 'device-passport') score += 30;
  if (projectionKind === 'room-page') score += 18;
  if (subject?.kind === 'ha_device') score += 24;
  if (subject?.kind === 'ha_area' || subject?.kind === 'ha_room') score += 16;
  if (/\b(tv|television|webos|iphone|phone|router|printer|camera|thermostat|lock|garage|espresso|appliance|esp32|proxy|speaker|receiver)\b/.test(text)) score += 12;
  if (/\b(home assistant|plugin|theme|card|conversation|tts|stt|task|backup)\b/.test(text)) score -= 10;
  return score;
}
