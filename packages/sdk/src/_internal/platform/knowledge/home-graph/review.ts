import type {
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { belongsToSpace, buildHomeGraphMetadata, readRecord } from './helpers.js';
import type { HomeGraphReviewInput } from './types.js';

export interface HomeGraphReviewResult {
  readonly ok: true;
  readonly spaceId: string;
  readonly issue?: KnowledgeIssueRecord;
  readonly node?: KnowledgeNodeRecord;
  readonly source?: KnowledgeSourceRecord;
  readonly suppression?: Record<string, unknown>;
  readonly appliedFacts?: Record<string, unknown>;
}

export async function reviewHomeGraphFact(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  input: HomeGraphReviewInput,
): Promise<HomeGraphReviewResult> {
  const reviewedAt = Date.now();
  if (input.issueId) {
    const issue = store.getIssue(input.issueId);
    if (!issue || !belongsToSpace(issue, spaceId)) throw new Error(`Unknown Home Graph issue: ${input.issueId}`);
    const subjectNode = issue.nodeId ? store.getNode(issue.nodeId) : null;
    const appliedFacts = await applyHomeGraphReviewFacts(store, spaceId, issue, subjectNode, input);
    const suppression = buildSuppression(input, issue, reviewedAt);
    const updatedIssue = await store.upsertIssue({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      status: issueStatusForAction(input.action, issue.status),
      sourceId: issue.sourceId,
      nodeId: issue.nodeId,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        review: reviewMetadata(input, reviewedAt),
        ...(suppression ? { suppression } : {}),
      }),
    });
    const node = appliedFacts?.node ?? subjectNode ?? undefined;
    return {
      ok: true,
      spaceId,
      issue: updatedIssue,
      ...(node ? { node } : {}),
      ...(suppression ? { suppression } : {}),
      ...(appliedFacts?.facts ? { appliedFacts: appliedFacts.facts } : {}),
    };
  }
  if (input.nodeId) {
    const node = store.getNode(input.nodeId);
    if (!node || !belongsToSpace(node, spaceId)) throw new Error(`Unknown Home Graph node: ${input.nodeId}`);
    const facts = normalizeReviewFacts(input);
    const updated = await store.upsertNode({
      id: node.id,
      kind: node.kind,
      slug: node.slug,
      title: node.title,
      summary: node.summary,
      aliases: node.aliases,
      status: input.action === 'forget' ? 'stale' : node.status,
      confidence: input.action === 'accept' ? 100 : node.confidence,
      sourceId: node.sourceId,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        ...facts,
        review: reviewMetadata(input, reviewedAt),
      }),
    });
    return { ok: true, spaceId, node: updated, ...(Object.keys(facts).length > 0 ? { appliedFacts: facts } : {}) };
  }
  if (input.sourceId) {
    const source = store.getSource(input.sourceId);
    if (!source || !belongsToSpace(source, spaceId)) throw new Error(`Unknown Home Graph source: ${input.sourceId}`);
    const updated = await store.upsertSource({
      id: source.id,
      connectorId: source.connectorId,
      sourceType: source.sourceType,
      title: source.title,
      sourceUri: source.sourceUri,
      canonicalUri: source.canonicalUri,
      summary: source.summary,
      description: source.description,
      tags: source.tags,
      folderPath: source.folderPath,
      status: input.action === 'forget' ? 'stale' : source.status,
      artifactId: source.artifactId,
      contentHash: source.contentHash,
      lastCrawledAt: source.lastCrawledAt,
      crawlError: source.crawlError,
      sessionId: source.sessionId,
      metadata: buildHomeGraphMetadata(spaceId, installationId, {
        review: reviewMetadata(input, reviewedAt),
      }),
    });
    return { ok: true, spaceId, source: updated };
  }
  throw new Error('reviewFact requires issueId, nodeId, or sourceId.');
}

async function applyHomeGraphReviewFacts(
  store: KnowledgeStore,
  spaceId: string,
  issue: KnowledgeIssueRecord,
  node: KnowledgeNodeRecord | null,
  input: HomeGraphReviewInput,
): Promise<{ readonly node?: KnowledgeNodeRecord; readonly facts?: Record<string, unknown> } | undefined> {
  if (!node || !belongsToSpace(node, spaceId)) return undefined;
  const facts = deriveIssueFacts(issue, input);
  if (Object.keys(facts).length === 0) return undefined;
  const updated = await store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: node.title,
    summary: node.summary,
    aliases: node.aliases,
    status: node.status,
    confidence: Math.max(node.confidence, input.action === 'accept' ? 100 : node.confidence),
    sourceId: node.sourceId,
    metadata: facts,
  });
  return { node: updated, facts };
}

function deriveIssueFacts(issue: KnowledgeIssueRecord, input: HomeGraphReviewInput): Record<string, unknown> {
  const facts = normalizeReviewFacts(input);
  if (issue.code === 'homegraph.device.unknown_battery') {
    const category = readCategory(input);
    const batteryType = readString(facts.batteryType);
    if (batteryType && batteryType !== 'none' && typeof facts.batteryPowered !== 'boolean') {
      return { ...facts, batteryPowered: true };
    }
    if (facts.batteryPowered === false && !batteryType) {
      return { ...facts, batteryType: 'none' };
    }
    if (Object.keys(facts).length > 0) return facts;
    if (input.action === 'reject' || input.action === 'resolve' || category === 'not_applicable') {
      return { batteryPowered: false, batteryType: 'none' };
    }
  }
  if (issue.code === 'homegraph.device.missing_manual') {
    const category = readCategory(input);
    if (Object.keys(facts).length > 0) return facts;
    if (input.action === 'reject' || input.action === 'resolve' || category === 'not_applicable') {
      return { manualRequired: false };
    }
  }
  return facts;
}

function normalizeReviewFacts(input: HomeGraphReviewInput): Record<string, unknown> {
  const value = readRecord(input.value);
  const fact = readRecord(value.fact);
  const source = Object.keys(fact).length > 0 ? fact : value;
  const allowed: Record<string, unknown> = {};
  for (const key of [
    'batteryPowered',
    'batteryType',
    'manualRequired',
    'manufacturer',
    'model',
    'serial',
    'firmware',
    'installDate',
    'purchaseDate',
    'warrantyExpiration',
  ]) {
    if (key in source) allowed[key] = source[key];
  }
  return allowed;
}

function reviewMetadata(input: HomeGraphReviewInput, reviewedAt: number): Record<string, unknown> {
  return {
    action: input.action,
    reviewer: input.reviewer ?? 'homeassistant',
    reviewedAt,
    ...(input.value ? { value: input.value } : {}),
  };
}

function buildSuppression(
  input: HomeGraphReviewInput,
  issue: KnowledgeIssueRecord,
  reviewedAt: number,
): Record<string, unknown> | undefined {
  if (!['accept', 'reject', 'resolve'].includes(input.action)) return undefined;
  return {
    suppressed: true,
    action: input.action,
    reviewedAt,
    reviewer: input.reviewer ?? 'homeassistant',
    issueId: issue.id,
    code: issue.code,
    subjectId: issue.metadata.subjectId ?? issue.nodeId ?? issue.sourceId ?? issue.id,
  };
}

function issueStatusForAction(action: HomeGraphReviewInput['action'], current: KnowledgeIssueRecord['status']): KnowledgeIssueRecord['status'] {
  return action === 'reject' || action === 'resolve' || action === 'accept' ? 'resolved' : current;
}

function readCategory(input: HomeGraphReviewInput): string | undefined {
  return readString(readRecord(input.value).category)?.toLowerCase().replace(/[-\s]+/g, '_');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
