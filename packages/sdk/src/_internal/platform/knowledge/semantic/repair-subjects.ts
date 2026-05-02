import type { KnowledgeNodeRecord } from '../types.js';
import { readString } from './utils.js';

export interface RepairSubjectHint {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
}

export function canonicalRepairSubjectNodes(input: {
  readonly nodes: readonly (KnowledgeNodeRecord | undefined)[];
  readonly text?: string;
}): KnowledgeNodeRecord[] {
  const usable = uniqueNodes(input.nodes)
    .filter((node) => node.status !== 'stale')
    .filter((node) => !readString(node.metadata.semanticKind))
    .filter((node) => !['fact', 'wiki_page', 'knowledge_gap', 'ha_device_passport'].includes(node.kind));
  const devices = usable.filter((node) => node.kind === 'ha_device');
  if (devices.length > 0) return devices;
  const entities = usable.filter((node) => node.kind === 'ha_entity');
  if (entities.length > 0) return entities;
  const concreteKnowledge = usable.filter((node) => node.kind === 'knowledge_entity' && hasConcreteProductIdentity(node));
  if (concreteKnowledge.length > 0) return concreteKnowledge;
  const concreteObjects = usable.filter(isConcreteObjectSubject);
  if (concreteObjects.length > 0) return concreteObjects;
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(input.text ?? '');
  const integrations = usable.filter((node) => node.kind === 'ha_integration');
  return integrationIntent ? integrations : [];
}

export function repairSubjectIds(input: {
  readonly nodes: readonly (KnowledgeNodeRecord | undefined)[];
  readonly text?: string;
}): string[] {
  return canonicalRepairSubjectNodes(input).map((node) => node.id);
}

export function repairSubjectHints(subjects: readonly KnowledgeNodeRecord[]): RepairSubjectHint[] {
  return subjects.map((subject) => ({
    id: subject.id,
    kind: subject.kind,
    title: subject.title,
  }));
}

function hasConcreteProductIdentity(node: KnowledgeNodeRecord): boolean {
  const entityKind = readString(node.metadata.entityKind)?.toLowerCase() ?? '';
  if (/\b(device|product|appliance|controller|hardware|phone|tv|printer|router|sensor|hub|bridge)\b/.test(entityKind)) return true;
  if (readString(node.metadata.model)) return true;
  const text = `${node.title} ${node.summary ?? ''} ${node.aliases.join(' ')}`;
  return /\b[A-Z]{2,}[-_ ]?[0-9][A-Z0-9._-]{2,}\b/.test(text);
}

function isConcreteObjectSubject(node: KnowledgeNodeRecord): boolean {
  if (node.kind === 'ha_area' || node.kind === 'ha_room') return true;
  if (node.kind === 'ha_automation' || node.kind === 'ha_script' || node.kind === 'ha_scene') return true;
  if (node.kind === 'device' || node.kind === 'product' || node.kind === 'appliance' || node.kind === 'controller') return true;
  if (node.kind === 'service' || node.kind === 'provider' || node.kind === 'capability' || node.kind === 'platform' || node.kind === 'tool') return true;
  return false;
}

function uniqueNodes(nodes: readonly (KnowledgeNodeRecord | undefined)[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeNodeRecord[] = [];
  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
  }
  return result;
}
