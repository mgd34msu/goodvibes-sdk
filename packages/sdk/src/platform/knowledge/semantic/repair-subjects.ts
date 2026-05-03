import type { KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import { readString } from './utils.js';

export interface RepairSubjectHint {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly [key: string]: unknown;
}

export function canonicalRepairSubjectNodes(input: {
  readonly nodes: readonly (KnowledgeNodeRecord | undefined)[];
  readonly text?: string;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[];
}): KnowledgeNodeRecord[] {
  const objectProfiles = input.objectProfiles ?? [];
  const usable = uniqueNodes(input.nodes)
    .filter((node) => node.status !== 'stale')
    .filter((node) => !readString(node.metadata.semanticKind))
    .filter((node) => !['fact', 'wiki_page', 'knowledge_gap'].includes(node.kind))
    .filter((node) => node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true);
  const profiledSubjects = usable.filter((node) => isProfiledObjectSubject(node, objectProfiles));
  const profiledConcrete = profiledSubjects.filter((node) => hasConcreteProductIdentity(node));
  if (profiledConcrete.length > 0) return profiledConcrete;
  const profiledNonIntegration = profiledSubjects.filter((node) => !/integration|platform|service/i.test(node.kind));
  if (profiledNonIntegration.length > 0) return profiledNonIntegration;
  const concreteKnowledge = usable.filter((node) => node.kind === 'knowledge_entity' && hasConcreteProductIdentity(node));
  if (concreteKnowledge.length > 0) return concreteKnowledge;
  const batteryScopedDevices = /\bbattery\b/i.test(input.text ?? '')
    ? usable.filter((node) => node.kind === 'ha_device')
    : [];
  if (batteryScopedDevices.length > 0) return batteryScopedDevices;
  const concreteObjects = usable.filter(isConcreteObjectSubject);
  if (concreteObjects.length > 0) return concreteObjects;
  const integrationIntent = /\b(integration|platform|add-?on|addon|plugin|service|api|setup|configure|configuration|auth|credential|rate limit)\b/i.test(input.text ?? '');
  const integrations = usable.filter((node) => /integration|platform|service/i.test(node.kind));
  return integrationIntent ? integrations : [];
}

export function repairSubjectIds(input: {
  readonly nodes: readonly (KnowledgeNodeRecord | undefined)[];
  readonly text?: string;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[];
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
  if (node.kind === 'ha_device' || node.kind === 'knowledge_entity') return hasConcreteProductIdentity(node);
  if (node.kind === 'service' || node.kind === 'provider' || node.kind === 'capability') return true;
  return false;
}

function isProfiledObjectSubject(
  node: KnowledgeNodeRecord,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[],
): boolean {
  return objectProfiles.some((profile) => profile.subjectKinds.includes(node.kind));
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
