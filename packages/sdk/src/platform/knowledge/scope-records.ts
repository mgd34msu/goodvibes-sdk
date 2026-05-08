import {
  DEFAULT_KNOWLEDGE_SPACE_ID,
  getExplicitKnowledgeSpaceId,
  getKnowledgeSpaceId,
  isInKnowledgeSpaceScope,
  resolveKnowledgeSpaceScope,
  type KnowledgeSpaceScopeInput,
} from './spaces.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeScopeLookup {
  readonly getSource?: ((id: string) => KnowledgeSourceRecord | null | undefined) | undefined;
  readonly getNode?: ((id: string) => KnowledgeNodeRecord | null | undefined) | undefined;
  readonly sources?: ReadonlyMap<string, KnowledgeSourceRecord> | undefined;
  readonly nodes?: ReadonlyMap<string, KnowledgeNodeRecord> | undefined;
  readonly edges?: readonly KnowledgeEdgeRecord[] | undefined;
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
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (scopedSpaceId === null) return true;
  const relatedSpaces = relatedNodeSpaceIds(node, lookup);
  const ownSpace = getKnowledgeSpaceId(node);
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID && relatedSpaces.length === 0 && isUngroundedSemanticAnswerGapNode(node)) return false;
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID) {
    return ownSpace === scopedSpaceId && (relatedSpaces.length === 0 || relatedSpaces.every((spaceId) => spaceId === scopedSpaceId));
  }
  return ownSpace === scopedSpaceId || relatedSpaces.includes(scopedSpaceId);
}

export function knowledgeIssueMatchesScope(
  issue: KnowledgeIssueRecord,
  scope: KnowledgeSpaceScopeInput = {},
  lookup: KnowledgeScopeLookup = {},
): boolean {
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (scopedSpaceId === null) return true;
  const relatedSpaces = relatedIssueSpaceIds(issue, lookup);
  const ownSpace = getKnowledgeSpaceId(issue);
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID && relatedSpaces.length === 0 && isUngroundedSemanticAnswerGapIssue(issue)) return false;
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID) {
    return ownSpace === scopedSpaceId && (relatedSpaces.length === 0 || relatedSpaces.every((spaceId) => spaceId === scopedSpaceId));
  }
  return ownSpace === scopedSpaceId || relatedSpaces.includes(scopedSpaceId);
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
  for (const edge of lookup.edges ?? []) {
    if (!edgeTouchesRecord(edge, 'issue', issue.id)) continue;
    const edgeSpace = getExplicitKnowledgeSpaceId(edge);
    if (edgeSpace) spaces.add(edgeSpace);
    for (const related of relatedEdgeSpaceIds(edge, lookup)) spaces.add(related);
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
  for (const edge of lookup.edges ?? []) {
    if (!edgeTouchesRecord(edge, 'node', node.id)) continue;
    const edgeSpace = getExplicitKnowledgeSpaceId(edge);
    if (edgeSpace) spaces.add(edgeSpace);
    for (const related of relatedEdgeSpaceIds(edge, lookup)) spaces.add(related);
  }
  return [...spaces];
}

function relatedEdgeSpaceIds(edge: KnowledgeEdgeRecord, lookup: KnowledgeScopeLookup): readonly string[] {
  const spaces = new Set<string>();
  for (const endpoint of [
    { kind: edge.fromKind, id: edge.fromId },
    { kind: edge.toKind, id: edge.toId },
  ]) {
    if (endpoint.kind === 'source') {
      const sourceSpace = getExplicitKnowledgeSpaceId(lookupSource(lookup, endpoint.id));
      if (sourceSpace) spaces.add(sourceSpace);
    }
    if (endpoint.kind === 'node') {
      const node = lookupNode(lookup, endpoint.id);
      const nodeSpace = getExplicitKnowledgeSpaceId(node);
      if (nodeSpace) spaces.add(nodeSpace);
    }
  }
  return [...spaces];
}

function edgeTouchesRecord(edge: KnowledgeEdgeRecord, kind: string, id: string): boolean {
  return (edge.fromKind === kind && edge.fromId === id) || (edge.toKind === kind && edge.toId === id);
}

function isUngroundedSemanticAnswerGapNode(node: KnowledgeNodeRecord): boolean {
  return node.kind === 'knowledge_gap'
    && readString(node.metadata.semanticKind) === 'gap'
    && readString(node.metadata.gapKind) === 'answer'
    && readString(node.metadata.visibility) === 'refinement'
    && uniqueStrings([
      node.sourceId,
      readString(node.metadata.sourceId),
      readString(node.metadata.nodeId),
      ...readStringArray(node.metadata.sourceIds),
      ...readStringArray(node.metadata.linkedObjectIds),
      ...readStringArray(node.metadata.subjectIds),
    ]).length === 0;
}

function isUngroundedSemanticAnswerGapIssue(issue: KnowledgeIssueRecord): boolean {
  return issue.code === 'knowledge.answer_gap'
    && (issue.metadata.semantic === true || readString(issue.metadata.semantic) === 'true')
    && uniqueStrings([
      issue.sourceId,
      issue.nodeId,
      readString(issue.metadata.sourceId),
      readString(issue.metadata.nodeId),
      ...readStringArray(issue.metadata.sourceIds),
      ...readStringArray(issue.metadata.linkedObjectIds),
      ...readStringArray(issue.metadata.subjectIds),
    ]).length === 0;
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
