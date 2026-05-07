import {
  getExplicitKnowledgeSpaceId,
  isInKnowledgeSpaceScope,
  resolveKnowledgeSpaceScope,
  type KnowledgeSpaceScopeInput,
} from './spaces.js';
import type {
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeScopeLookup {
  readonly getSource?: ((id: string) => KnowledgeSourceRecord | null | undefined) | undefined;
  readonly getNode?: ((id: string) => KnowledgeNodeRecord | null | undefined) | undefined;
  readonly sources?: ReadonlyMap<string, KnowledgeSourceRecord> | undefined;
  readonly nodes?: ReadonlyMap<string, KnowledgeNodeRecord> | undefined;
}

export function knowledgeSourceMatchesScope(
  source: KnowledgeSourceRecord,
  scope: KnowledgeSpaceScopeInput = {},
): boolean {
  return isInKnowledgeSpaceScope(source, scope);
}

export function knowledgeNodeMatchesScope(
  node: KnowledgeNodeRecord,
  scope: KnowledgeSpaceScopeInput = {},
  lookup: KnowledgeScopeLookup = {},
): boolean {
  if (!isInKnowledgeSpaceScope(node, scope)) return false;
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (scopedSpaceId === null) return true;
  const relatedSpaces = relatedNodeSpaceIds(node, lookup);
  return relatedSpaces.length === 0 || relatedSpaces.every((spaceId) => spaceId === scopedSpaceId);
}

export function knowledgeIssueMatchesScope(
  issue: KnowledgeIssueRecord,
  scope: KnowledgeSpaceScopeInput = {},
  lookup: KnowledgeScopeLookup = {},
): boolean {
  if (!isInKnowledgeSpaceScope(issue, scope)) return false;
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (scopedSpaceId === null) return true;
  const relatedSpaces = relatedIssueSpaceIds(issue, lookup);
  return relatedSpaces.length === 0 || relatedSpaces.every((spaceId) => spaceId === scopedSpaceId);
}

function relatedIssueSpaceIds(issue: KnowledgeIssueRecord, lookup: KnowledgeScopeLookup): readonly string[] {
  const spaces = new Set<string>();
  for (const sourceId of uniqueStrings([
    issue.sourceId,
    readString(issue.metadata.sourceId),
    ...readStringArray(issue.metadata.sourceIds),
  ])) {
    const sourceSpace = getExplicitKnowledgeSpaceId(lookupSource(lookup, sourceId));
    if (sourceSpace) spaces.add(sourceSpace);
  }
  const linkedNodeIds = uniqueStrings([
    issue.nodeId,
    readString(issue.metadata.nodeId),
    ...readStringArray(issue.metadata.linkedObjectIds),
    ...readStringArray(issue.metadata.subjectIds),
  ]);
  for (const nodeId of linkedNodeIds) {
    const node = lookupNode(lookup, nodeId);
    const nodeSpace = getExplicitKnowledgeSpaceId(node);
    if (nodeSpace) spaces.add(nodeSpace);
    if (node) for (const related of relatedNodeSpaceIds(node, lookup)) spaces.add(related);
  }
  return [...spaces];
}

function relatedNodeSpaceIds(node: KnowledgeNodeRecord, lookup: KnowledgeScopeLookup): readonly string[] {
  const spaces = new Set<string>();
  for (const sourceId of uniqueStrings([
    node.sourceId,
    readString(node.metadata.sourceId),
    ...readStringArray(node.metadata.sourceIds),
  ])) {
    const sourceSpace = getExplicitKnowledgeSpaceId(lookupSource(lookup, sourceId));
    if (sourceSpace) spaces.add(sourceSpace);
  }
  for (const nodeId of uniqueStrings([
    ...readStringArray(node.metadata.linkedObjectIds),
    ...readStringArray(node.metadata.subjectIds),
  ])) {
    const linkedSpace = getExplicitKnowledgeSpaceId(lookupNode(lookup, nodeId));
    if (linkedSpace) spaces.add(linkedSpace);
  }
  return [...spaces];
}

function lookupSource(lookup: KnowledgeScopeLookup, id: string | undefined): KnowledgeSourceRecord | null {
  if (!id) return null;
  return lookup.getSource?.(id) ?? lookup.sources?.get(id) ?? null;
}

function lookupNode(lookup: KnowledgeScopeLookup, id: string | undefined): KnowledgeNodeRecord | null {
  if (!id) return null;
  return lookup.getNode?.(id) ?? lookup.nodes?.get(id) ?? null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => readStringArray(entry));
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry && entry.trim().length > 0)))];
}
