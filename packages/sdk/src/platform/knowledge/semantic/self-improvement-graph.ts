import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import {
  readString,
  readStringArray,
  uniqueStrings,
} from './utils.js';
import {
  hasConcreteFeatureSignal,
  isLowValueFeatureOrSpecText,
  semanticFactText,
} from './fact-quality.js';

export const BASE_OBJECT_PROFILES: readonly KnowledgeObjectProfilePolicy[] = [
  {
    id: 'base-knowledge-service',
    subjectKinds: ['service', 'provider', 'capability'],
    intrinsicFactKinds: ['identity', 'capability', 'configuration', 'troubleshooting'],
    searchHints: ['official documentation capabilities setup'],
  },
];

export function linkedObjectsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.status !== 'stale')
    .filter((node) => node.metadata.semanticKind !== 'fact' && node.metadata.semanticKind !== 'gap' && node.kind !== 'wiki_page'));
}

export function factsForSource(
  sourceId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

export function sourcesForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  sourcesById: ReadonlyMap<string, KnowledgeSourceRecord>,
): KnowledgeSourceRecord[] {
  return uniqueById(edges
    .filter((edge) => edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === objectId)
    .map((edge) => sourcesById.get(edge.fromId))
    .filter((source): source is KnowledgeSourceRecord => Boolean(source))
    .filter((source) => source.status === 'indexed' && !isGeneratedKnowledgeSource(source)));
}

export function factsForObject(
  objectId: string,
  edges: readonly KnowledgeEdgeRecord[],
  nodesById: ReadonlyMap<string, KnowledgeNodeRecord>,
): KnowledgeNodeRecord[] {
  const directlyDescribing = edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === objectId && edge.relation === 'describes')
    .map((edge) => nodesById.get(edge.fromId));
  return uniqueById(directlyDescribing
    .filter((node): node is KnowledgeNodeRecord => Boolean(node))
    .filter((node) => node.kind === 'fact' && node.status !== 'stale'));
}

export function isConcreteRepairSubject(node: KnowledgeNodeRecord, objectProfiles: readonly KnowledgeObjectProfilePolicy[]): boolean {
  if (node.status === 'stale') return false;
  if (typeof node.metadata.semanticKind === 'string') return false;
  if (matchingObjectProfiles([node], objectProfiles).length > 0) return true;
  if (node.kind === 'ha_device') return hasSpecificIdentity(node);
  if (node.kind !== 'knowledge_entity') return false;
  const entityKind = readString(node.metadata.entityKind)?.toLowerCase() ?? '';
  return /\b(device|product|service|appliance|controller|platform|provider|tool)\b/.test(entityKind);
}

export function matchingObjectProfiles(
  nodes: readonly KnowledgeNodeRecord[],
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): readonly KnowledgeObjectProfilePolicy[] {
  const kinds = new Set(nodes.map((node) => node.kind));
  return objectProfiles.filter((profile) => profile.subjectKinds.some((kind) => kinds.has(kind)));
}

export function hasSpecificIdentity(subject: KnowledgeNodeRecord, source?: KnowledgeSourceRecord): boolean {
  if (readString(subject.metadata.model)) return true;
  if (readString(subject.metadata.manufacturer) && readString(subject.metadata.model)) return true;
  const text = `${subject.title} ${subject.aliases.join(' ')} ${source?.title ?? ''}`;
  return /\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/.test(text);
}

export function factCoverage(facts: readonly KnowledgeNodeRecord[]): { readonly coreFactCount: number; readonly coveredAreas: Set<string> } {
  const coveredAreas = new Set<string>();
  let coreFactCount = 0;
  for (const fact of facts) {
    if (!isUsableSelfImprovementFact(fact)) continue;
    const kind = readString(fact.metadata.factKind);
    if (!['feature', 'capability', 'specification', 'compatibility', 'configuration'].includes(kind ?? '')) continue;
    coreFactCount += 1;
    const text = `${fact.title} ${fact.summary ?? ''} ${fact.aliases.join(' ')} ${JSON.stringify(fact.metadata)}`.toLowerCase();
    for (const [area, pattern] of [
      ['display', /\b(display|screen|resolution|hdr|dolby vision|refresh|panel)\b/],
      ['ports', /\b(hdmi|usb|ethernet|port|input|output|earc|arc)\b/],
      ['audio', /\b(audio|speaker|dolby|pcm|sound)\b/],
      ['network', /\b(wi-?fi|bluetooth|ethernet|network|wireless)\b/],
      ['smart', /\b(app|webos|smart|assistant|voice|stream)\b/],
      ['control', /\b(remote|rs-?232|control|automation|api)\b/],
    ] as const) {
      if (pattern.test(text)) coveredAreas.add(area);
    }
  }
  return { coreFactCount, coveredAreas };
}

export function isUsableSelfImprovementFact(fact: KnowledgeNodeRecord, subjectIds: ReadonlySet<string> = new Set()): boolean {
  if (fact.status === 'stale') return false;
  if (fact.metadata.semanticKind !== 'fact') return false;
  const kind = readString(fact.metadata.factKind);
  if (!['feature', 'capability', 'specification', 'compatibility', 'configuration', 'identity'].includes(kind ?? '')) return false;
  const text = semanticFactText(fact);
  if (isLowValueFeatureOrSpecText(text) || !hasConcreteFeatureSignal(text)) return false;
  if (subjectIds.size === 0) return true;
  const linkedIds = uniqueStrings([
    ...readStringArray(fact.metadata.linkedObjectIds),
    ...readStringArray(fact.metadata.subjectIds),
  ]);
  return linkedIds.length > 0 && linkedIds.some((id) => subjectIds.has(id));
}

export function repairTargetFactCount(gap: KnowledgeNodeRecord): number {
  const text = `${gap.title} ${gap.summary ?? ''}`.toLowerCase();
  if (/\b(complete|full|features?|capabilities|specifications?|profile)\b/.test(text)) return 3;
  return 1;
}

export function subjectTitle(subject: KnowledgeNodeRecord): string {
  return uniqueStrings([
    readString(subject.metadata.manufacturer),
    readString(subject.metadata.model),
    subject.title,
  ]).join(' ');
}

export function uniqueById<T extends { readonly id: string }>(items: readonly (T | undefined)[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}
