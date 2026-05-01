import type { KnowledgeIssueRecord, KnowledgeIssueUpsertInput, KnowledgeNodeRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { yieldEvery } from '../cooperative.js';
import { buildIssue, readRecord, stableHash, uniqueStrings } from './helpers.js';
import { readHomeGraphState, sourcesLinkedToNode } from './state.js';

const QUALITY_NAMESPACE_PREFIX = 'homegraph';
const EXCLUDED_SOFTWARE_TERMS = [
  'add-on',
  'addon',
  'automation',
  'cloud',
  'core',
  'helper',
  'home assistant',
  'integration',
  'operating system',
  'scene',
  'script',
  'service',
  'software',
  'supervisor',
  'template',
  'virtual',
];
const EXCLUDED_INFRASTRUCTURE_TERMS = [
  'adapter',
  'bridge',
  'coordinator',
  'dongle',
  'gateway',
  'hub',
];
const EXCLUDED_MAINS_TERMS = [
  'air conditioner',
  'appliance',
  'bulb',
  'dishwasher',
  'dryer',
  'furnace',
  'heat pump',
  'hvac',
  'light',
  'microwave',
  'outlet',
  'plug',
  'power strip',
  'receiver',
  'refrigerator',
  'soundbar',
  'speaker',
  'switch',
  'television',
  'tv',
  'washer',
];
const BATTERY_EVIDENCE_TERMS = [
  'battery',
  'battery powered',
  'button cell',
  'cr123',
  'cr2032',
  'keypad',
  'leak sensor',
  'lithium',
  'motion sensor',
  'remote',
  'rechargeable',
];
const BATTERY_ENTITY_DOMAINS = new Set(['binary_sensor', 'lock', 'remote']);
const BATTERY_DEVICE_CLASSES = new Set([
  'battery',
  'door',
  'gas',
  'moisture',
  'motion',
  'occupancy',
  'opening',
  'safety',
  'smoke',
  'tamper',
  'vibration',
  'window',
]);
const MANUAL_ENTITY_DOMAINS = new Set([
  'alarm_control_panel',
  'binary_sensor',
  'camera',
  'climate',
  'cover',
  'fan',
  'humidifier',
  'light',
  'lock',
  'media_player',
  'remote',
  'sensor',
  'switch',
  'vacuum',
  'water_heater',
]);

export function homeGraphQualityNamespace(spaceId: string): string {
  return `${QUALITY_NAMESPACE_PREFIX}:${spaceId}:quality`;
}

export async function refreshHomeGraphQualityIssues(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
): Promise<readonly KnowledgeIssueRecord[]> {
  const state = readHomeGraphState(store, spaceId);
  const issues: KnowledgeIssueUpsertInput[] = [];
  for (const [index, node] of state.nodes.entries()) {
    await yieldEvery(index, 32);
    if (node.kind !== 'ha_device') continue;
    if (sourcesLinkedToNode(node.id, state).length === 0 && shouldRequireManual(node, state)) {
      issues.push(qualityIssue(spaceId, installationId, 'homegraph.device.missing_manual', `${node.title} has no linked manual or source.`, node));
    }
    if (shouldRequireBatteryType(node, state)) {
      issues.push(qualityIssue(spaceId, installationId, 'homegraph.device.unknown_battery', `${node.title} has no known battery type.`, node));
    }
  }
  return store.replaceIssues(
    issues.filter((issue) => !isSuppressedGeneratedIssue(store.getIssue(issue.id!), issue)),
    homeGraphQualityNamespace(spaceId),
  );
}

function qualityIssue(
  spaceId: string,
  installationId: string,
  code: string,
  message: string,
  node: KnowledgeNodeRecord,
): KnowledgeIssueUpsertInput {
  const issue = buildIssue(spaceId, installationId, code, message, { nodeId: node.id });
  return {
    ...issue,
    metadata: {
      ...(issue.metadata ?? {}),
      generated: true,
      subjectFingerprint: subjectFingerprint(node, code),
    },
  };
}

function isSuppressedGeneratedIssue(
  existing: KnowledgeIssueRecord | null,
  input: KnowledgeIssueUpsertInput,
): boolean {
  if (!existing || existing.status !== 'resolved') return false;
  const existingFingerprint = typeof existing.metadata.subjectFingerprint === 'string'
    ? existing.metadata.subjectFingerprint
    : undefined;
  const inputFingerprint = typeof input.metadata?.subjectFingerprint === 'string'
    ? input.metadata.subjectFingerprint
    : undefined;
  return existingFingerprint === inputFingerprint;
}

function shouldRequireBatteryType(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): boolean {
  if (readNonEmptyString(node.metadata.batteryType)) return false;
  const powered = readBooleanLike(node.metadata.batteryPowered);
  if (powered === false) return false;
  if (powered === true) return true;
  if (isSoftwareOrInfrastructure(node, state)) return false;
  if (hasAny(qualityText(node, state), EXCLUDED_MAINS_TERMS)) return false;
  if (hasAny(qualityText(node, state), BATTERY_EVIDENCE_TERMS)) return true;
  return relatedEntities(node, state).some((entity) => {
    const domain = entityDomain(entity);
    const deviceClass = entityDeviceClass(entity);
    return (domain ? BATTERY_ENTITY_DOMAINS.has(domain) : false)
      || (deviceClass ? BATTERY_DEVICE_CLASSES.has(deviceClass) : false);
  });
}

function shouldRequireManual(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): boolean {
  const required = readBooleanLike(node.metadata.manualRequired);
  if (required === false) return false;
  if (required === true) return true;
  if (isSoftwareOrInfrastructure(node, state)) return false;
  if (readNonEmptyString(node.metadata.manufacturer) || readNonEmptyString(node.metadata.model)) return true;
  return relatedEntities(node, state).some((entity) => {
    const domain = entityDomain(entity);
    return domain ? MANUAL_ENTITY_DOMAINS.has(domain) : false;
  });
}

function isSoftwareOrInfrastructure(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): boolean {
  const text = qualityText(node, state);
  if (hasAny(text, EXCLUDED_SOFTWARE_TERMS)) return true;
  if (hasAny(text, EXCLUDED_INFRASTRUCTURE_TERMS)) return true;
  return relatedEntities(node, state).every((entity) => {
    const domain = entityDomain(entity);
    return domain === 'sun' || domain === 'weather';
  }) && relatedEntities(node, state).length > 0;
}

function subjectFingerprint(node: KnowledgeNodeRecord, code: string): string {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const attributes = readRecord(node.metadata.attributes);
  return stableHash(JSON.stringify({
    code,
    kind: node.kind,
    title: node.title,
    manufacturer: node.metadata.manufacturer,
    model: node.metadata.model,
    batteryPowered: node.metadata.batteryPowered,
    batteryType: node.metadata.batteryType,
    manualRequired: node.metadata.manualRequired,
    objectKind: homeAssistant.objectKind,
    objectId: homeAssistant.objectId,
    entityId: homeAssistant.entityId,
    deviceId: homeAssistant.deviceId,
    integrationId: homeAssistant.integrationId,
    domain: homeAssistant.domain,
    deviceClass: attributes.device_class,
  }));
}

function relatedEntities(
  node: KnowledgeNodeRecord,
  state: ReturnType<typeof readHomeGraphState>,
): KnowledgeNodeRecord[] {
  const byId = new Map(state.nodes.map((entry) => [entry.id, entry]));
  return state.edges
    .filter((edge) => edge.fromKind === 'node' && edge.toKind === 'node' && edge.toId === node.id && edge.relation === 'belongs_to_device')
    .flatMap((edge) => {
      const entry = byId.get(edge.fromId);
      return entry?.kind === 'ha_entity' ? [entry] : [];
    });
}

function qualityText(node: KnowledgeNodeRecord, state: ReturnType<typeof readHomeGraphState>): string {
  const values = uniqueStrings([
    node.title,
    node.summary,
    ...node.aliases,
    ...metadataStrings(node.metadata),
    ...relatedEntities(node, state).flatMap((entity) => [
      entity.title,
      entity.summary,
      ...entity.aliases,
      ...metadataStrings(entity.metadata),
    ]),
  ]);
  return values.join(' ').toLowerCase();
}

function metadataStrings(metadata: Record<string, unknown>): string[] {
  const homeAssistant = readRecord(metadata.homeAssistant);
  const attributes = readRecord(metadata.attributes);
  return uniqueStrings([
    readNonEmptyString(metadata.manufacturer),
    readNonEmptyString(metadata.model),
    readNonEmptyString(metadata.entryType),
    readNonEmptyString(metadata.entry_type),
    readNonEmptyString(homeAssistant.objectKind),
    readNonEmptyString(homeAssistant.objectId),
    readNonEmptyString(homeAssistant.entityId),
    readNonEmptyString(homeAssistant.deviceId),
    readNonEmptyString(homeAssistant.integrationId),
    readNonEmptyString(homeAssistant.domain),
    readNonEmptyString(attributes.device_class),
    readNonEmptyString(attributes.friendly_name),
  ]);
}

function entityDomain(node: KnowledgeNodeRecord): string | undefined {
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  const entityId = readNonEmptyString(homeAssistant.entityId);
  if (entityId?.includes('.')) return entityId.split('.', 1)[0];
  return readNonEmptyString(homeAssistant.domain);
}

function entityDeviceClass(node: KnowledgeNodeRecord): string | undefined {
  return readNonEmptyString(readRecord(node.metadata.attributes).device_class)?.toLowerCase();
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function readBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1'].includes(normalized)) return true;
    if (['false', 'no', '0', 'none', 'not_applicable', 'not applicable'].includes(normalized)) return false;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
