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
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  if (isDefaultExtensionContaminatedSource(source)) return false;
  if (scopedSpaceId === null) return true;
  return isInKnowledgeSpaceScope(source, scope);
}

export function knowledgeNodeMatchesScope(
  node: KnowledgeNodeRecord,
  scope: KnowledgeSpaceScopeInput = {},
  lookup: KnowledgeScopeLookup = {},
): boolean {
  const scopedSpaceId = resolveKnowledgeSpaceScope(scope);
  const relatedSpaces = relatedNodeSpaceIds(node, lookup);
  const ownSpace = getKnowledgeSpaceId(node);
  if (isDefaultExtensionContaminatedNode(node, lookup)) return false;
  if (scopedSpaceId === null) return true;
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID
    && relatedSpaces.length === 0
    && (isUngroundedSemanticAnswerGapNode(node) || isUngroundedCatalogDerivedNode(node))) return false;
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
  const relatedSpaces = relatedIssueSpaceIds(issue, lookup);
  const ownSpace = getKnowledgeSpaceId(issue);
  if (isDefaultExtensionContaminatedIssue(issue, lookup)) return false;
  if (scopedSpaceId === null) return true;
  if (scopedSpaceId === DEFAULT_KNOWLEDGE_SPACE_ID
    && (isUngroundedSemanticAnswerGapIssue(issue, lookup) || isIssueLinkedOnlyToUngroundedAnswerGap(issue, lookup))) return false;
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

function isDefaultExtensionContaminatedSource(source: KnowledgeSourceRecord): boolean {
  if (getKnowledgeSpaceId(source) !== DEFAULT_KNOWLEDGE_SPACE_ID) return false;
  const text = [
    source.id,
    source.connectorId,
    source.sourceType,
    source.title,
    source.summary,
    source.description,
    source.sourceUri,
    source.canonicalUri,
    source.url,
    source.tags.join(' '),
    metadataSearchText(source.metadata),
  ].join(' ');
  return hasLegacyDefaultAgentWikiMarker(text)
    || hasDefaultGoodVibesProductNavigationMarker(text)
    || hasDefaultSemanticRepairGithubChromeMarker(source, text)
    || hasExtensionOnlyKnowledgeMarker(text);
}

function isDefaultExtensionContaminatedNode(node: KnowledgeNodeRecord, lookup: KnowledgeScopeLookup): boolean {
  if (getKnowledgeSpaceId(node) !== DEFAULT_KNOWLEDGE_SPACE_ID) return false;
  if (isDefaultAnswerGapNode(node)) return true;
  if (/^ha[_:-]/i.test(node.kind)) return true;
  if (isDefaultNavigationChromeNode(node)) return true;
  if (nodeReferencesDefaultExtensionSource(node, lookup)) return true;
  if (nodeReferencesExtensionObject(node, lookup)) return true;
  const text = [
    node.id,
    node.kind,
    node.slug,
    node.title,
    node.summary,
    node.aliases.join(' '),
    metadataSearchText(node.metadata),
  ].join(' ');
  return hasLegacyDefaultAgentWikiMarker(text)
    || hasDefaultGoodVibesProductNavigationMarker(text)
    || hasExtensionOnlyKnowledgeMarker(text);
}

function nodeReferencesExtensionObject(node: KnowledgeNodeRecord, lookup: KnowledgeScopeLookup): boolean {
  for (const nodeId of uniqueStrings([
    ...readStringArray(node.metadata.linkedObjectIds),
    ...readStringArray(node.metadata.subjectIds),
  ])) {
    const linked = lookupNode(lookup, nodeId);
    if (!linked) continue;
    if (/^ha[_:-]/i.test(linked.kind)) return true;
    if (hasExtensionOnlyKnowledgeMarker(`${linked.kind} ${linked.title} ${metadataSearchText(linked.metadata)}`)) return true;
  }
  return false;
}

function isDefaultExtensionContaminatedIssue(issue: KnowledgeIssueRecord, lookup: KnowledgeScopeLookup): boolean {
  if (getKnowledgeSpaceId(issue) !== DEFAULT_KNOWLEDGE_SPACE_ID) return false;
  if (issue.code === 'knowledge.answer_gap') return true;
  if (issueReferencesDefaultExtensionSource(issue, lookup)) return true;
  for (const nodeId of issueNodeIds(issue)) {
    const node = lookupNode(lookup, nodeId);
    if (node && isDefaultExtensionContaminatedNode(node, lookup)) return true;
  }
  const text = [
    issue.id,
    issue.code,
    issue.message,
    issue.sourceId,
    issue.nodeId,
    metadataSearchText(issue.metadata),
  ].join(' ');
  return hasLegacyDefaultAgentWikiMarker(text)
    || hasDefaultGoodVibesProductNavigationMarker(text)
    || hasExtensionOnlyKnowledgeMarker(text);
}

function isDefaultAnswerGapNode(node: KnowledgeNodeRecord): boolean {
  return node.kind === 'knowledge_gap'
    && readString(node.metadata.semanticKind) === 'gap'
    && readString(node.metadata.gapKind) === 'answer'
    && readString(node.metadata.visibility) === 'refinement';
}

function nodeReferencesDefaultExtensionSource(node: KnowledgeNodeRecord, lookup: KnowledgeScopeLookup): boolean {
  for (const sourceId of uniqueStrings([
    node.sourceId,
    readString(node.metadata.sourceId),
    ...readStringArray(node.metadata.sourceIds),
  ])) {
    const source = lookupSource(lookup, sourceId);
    if (source && isDefaultExtensionContaminatedSource(source)) return true;
  }
  for (const edge of lookup.edges ?? []) {
    if (!edgeTouchesRecord(edge, 'node', node.id)) continue;
    const sourceId = edge.fromKind === 'source' ? edge.fromId : edge.toKind === 'source' ? edge.toId : undefined;
    const source = lookupSource(lookup, sourceId);
    if (source && isDefaultExtensionContaminatedSource(source)) return true;
  }
  return false;
}

function issueReferencesDefaultExtensionSource(issue: KnowledgeIssueRecord, lookup: KnowledgeScopeLookup): boolean {
  for (const sourceId of uniqueStrings([
    issue.sourceId,
    readString(issue.metadata.sourceId),
    ...readStringArray(issue.metadata.sourceIds),
  ])) {
    const source = lookupSource(lookup, sourceId);
    if (source && isDefaultExtensionContaminatedSource(source)) return true;
  }
  return false;
}

function isUngroundedSemanticAnswerGapIssue(issue: KnowledgeIssueRecord, lookup: KnowledgeScopeLookup): boolean {
  return issue.code === 'knowledge.answer_gap'
    && (issue.metadata.semantic === true || readString(issue.metadata.semantic) === 'true')
    && uniqueStrings([
      issue.sourceId,
      readString(issue.metadata.sourceId),
      ...readStringArray(issue.metadata.sourceIds),
      ...readStringArray(issue.metadata.linkedObjectIds),
      ...readStringArray(issue.metadata.subjectIds),
    ]).length === 0
    && issueNodeIds(issue).every((nodeId) => {
      const node = lookupNode(lookup, nodeId);
      return node ? isUngroundedSemanticAnswerGapNode(node) : true;
    });
}

function isIssueLinkedOnlyToUngroundedAnswerGap(issue: KnowledgeIssueRecord, lookup: KnowledgeScopeLookup): boolean {
  if (issue.code !== 'knowledge.answer_gap') return false;
  const nodeIds = issueNodeIds(issue);
  return nodeIds.length > 0 && nodeIds.every((nodeId) => {
    const node = lookupNode(lookup, nodeId);
    return Boolean(node && isUngroundedSemanticAnswerGapNode(node));
  });
}

function issueNodeIds(issue: KnowledgeIssueRecord): readonly string[] {
  return uniqueStrings([
    issue.nodeId,
    readString(issue.metadata.nodeId),
  ]);
}

function isUngroundedCatalogDerivedNode(node: KnowledgeNodeRecord): boolean {
  if (node.sourceId || readString(node.metadata.sourceId) || readStringArray(node.metadata.sourceIds).length > 0) return false;
  if (readString(node.metadata.linkedObjectIds) || readStringArray(node.metadata.linkedObjectIds).length > 0) return false;
  if (readString(node.metadata.subjectIds) || readStringArray(node.metadata.subjectIds).length > 0) return false;
  if (node.kind === 'domain') return Boolean(readString(node.metadata.hostname));
  if (node.kind === 'bookmark_folder') return Boolean(readString(node.metadata.folderPath));
  if (node.kind !== 'topic') return false;
  const tag = readString(node.metadata.tag);
  return Boolean(tag && readOnlyMetadataKeys(node.metadata).every((key) => key === 'tag'));
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

function readOnlyMetadataKeys(metadata: Record<string, unknown>): readonly string[] {
  // 'reviewProvenance' is system bookkeeping stamped by the node review gate, not
  // content — excluded so it never changes a node's content-shape classification.
  return Object.keys(metadata).filter((key) => !['knowledgeSpaceId', 'namespace', 'reviewProvenance'].includes(key));
}

function metadataSearchText(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .filter(([key]) => !['content', 'raw', 'html', 'reviewProvenance'].includes(key))
    .flatMap(([, value]) => flattenMetadataText(value))
    .join(' ');
}

function flattenMetadataText(value: unknown): readonly string[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(flattenMetadataText);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(flattenMetadataText);
}

function hasExtensionOnlyKnowledgeMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return /\bhome\s*assistant\b/.test(lower)
    || /\bhome[-_]?assistant\b/.test(lower)
    || /\bhome\s*graph\b/.test(lower)
    || /\bhome[-_]?graph\b/.test(lower)
    || /\bhomegraph\b/.test(lower)
    || /\bgoodvibes[-_]?homeassistant\b/.test(lower)
    || /\bha_(?:device|entity|area|integration|device_passport|room)\b/.test(lower)
    || /\bhomeassistant:/.test(lower);
}

function hasLegacyDefaultAgentWikiMarker(value: string): boolean {
  const lower = value.toLowerCase();
  const mentionsGoodVibesAgent = /\bgoodvibes\s+agents?\b/.test(lower)
    || /\bgoodvibes[-_]?agents?\b/.test(lower);
  if (!mentionsGoodVibesAgent) return false;
  return /\bdefault[-_]?specification\b/.test(lower)
    || /\byaml\s+frontmatter\b/.test(lower)
    || /\bfrontmatter\b/.test(lower)
    || /\bgoodvibes:\/\/wiki\/default\b/.test(lower);
}

function hasDefaultGoodVibesProductNavigationMarker(value: string): boolean {
  const lower = value.toLowerCase();
  const isGoodVibesRepo = /\bgithub\.com\/mgd34msu\/goodvibes(?:\b|[-_][a-z0-9._-]+\b)/.test(lower)
    || /\bmgd34msu\/goodvibes(?:\b|[-_][a-z0-9._-]+\b)/.test(lower);
  if (!isGoodVibesRepo) return false;
  return hasGithubNavigationChromeMarker(lower);
}

function hasDefaultSemanticRepairGithubChromeMarker(source: KnowledgeSourceRecord, value: string): boolean {
  const lower = value.toLowerCase();
  const sourceDiscovery = typeof source.metadata.sourceDiscovery === 'object' && source.metadata.sourceDiscovery !== null
    ? source.metadata.sourceDiscovery as Record<string, unknown>
    : {};
  const isSemanticRepairSource = source.connectorId === 'semantic-gap-repair'
    || source.tags.some((tag) => tag.toLowerCase() === 'semantic-gap-repair' || tag.toLowerCase() === 'gap-repair')
    || readString(sourceDiscovery.purpose) === 'semantic-gap-repair';
  if (!isSemanticRepairSource) return false;
  if (!/\bgithub\.com\//.test(lower)) return false;
  return hasGithubNavigationChromeMarker(lower);
}

function isDefaultNavigationChromeNode(node: KnowledgeNodeRecord): boolean {
  if (node.title.trim().toLowerCase() !== 'navigation menu') return false;
  if (node.kind === 'memory') return true;
  const text = [
    node.summary,
    node.slug,
    metadataSearchText(node.metadata),
  ].join(' ').toLowerCase();
  return hasGithubNavigationChromeMarker(text)
    || /\bgithub\.com\//.test(text)
    || /\bgithub\b/.test(text)
    || /\brepository files navigation\b/.test(text);
}

function hasGithubNavigationChromeMarker(lower: string): boolean {
  return /\bnavigation\s+menu\b/.test(lower)
    || /\bskip\s+to\s+content\b/.test(lower)
    || /\bgithub\s+navigation\b/.test(lower)
    || /\brepository\s+files\s+navigation\b/.test(lower)
    || /\bsearch\s+code,\s*repositories,\s*users,\s*issues,\s*pull\s+requests\b/.test(lower)
    || /\bsaved\s+searches\b/.test(lower)
    || /\bwe\s+read\s+every\s+piece\s+of\s+feedback\b/.test(lower);
}
