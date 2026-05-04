import type { KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import type { KnowledgeStore } from './store.js';

export type KnowledgeReviewAction = 'accept' | 'reject' | 'resolve' | 'reopen' | 'edit' | 'forget';

export interface KnowledgeIssueReviewInput {
  readonly issueId: string;
  readonly action: KnowledgeReviewAction;
  readonly reviewer?: string | undefined;
  readonly value?: Record<string, unknown> | undefined;
}

export interface KnowledgeIssueReviewResult {
  readonly ok: true;
  readonly issue: KnowledgeIssueRecord;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly suppression?: Record<string, unknown> | undefined;
  readonly appliedFacts?: Record<string, unknown> | undefined;
}

export async function reviewKnowledgeIssue(
  store: KnowledgeStore,
  input: KnowledgeIssueReviewInput,
): Promise<KnowledgeIssueReviewResult> {
  await store.init();
  const issue = store.getIssue(input.issueId);
  if (!issue) throw new Error(`Unknown knowledge issue: ${input.issueId}`);
  const reviewedAt = Date.now();
  const facts = readReviewFacts(input.value);
  const source = issue.sourceId ? store.getSource(issue.sourceId) : null;
  const node = issue.nodeId ? store.getNode(issue.nodeId) : null;
  const updatedSource = source && Object.keys(facts).length > 0
    ? await applySourceFacts(store, source, facts, input, reviewedAt)
    : source ?? undefined;
  const updatedNode = node && Object.keys(facts).length > 0
    ? await applyNodeFacts(store, node, facts, input, reviewedAt)
    : node ?? undefined;
  const suppression = buildSuppression(input, issue, reviewedAt);
  const updatedIssue = await store.upsertIssue({
    id: issue.id,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    status: statusForAction(input.action, issue.status),
    sourceId: issue.sourceId,
    nodeId: issue.nodeId,
    metadata: {
      review: {
        action: input.action,
        reviewer: input.reviewer ?? 'knowledge-review',
        reviewedAt,
        ...(input.value ? { value: input.value } : {}),
      },
      ...(suppression ? { suppression } : {}),
    },
  });
  return {
    ok: true,
    issue: updatedIssue,
    ...(updatedNode ? { node: updatedNode } : {}),
    ...(updatedSource ? { source: updatedSource } : {}),
    ...(suppression ? { suppression } : {}),
    ...(Object.keys(facts).length > 0 ? { appliedFacts: facts } : {}),
  };
}

async function applySourceFacts(
  store: KnowledgeStore,
  source: KnowledgeSourceRecord,
  facts: Record<string, unknown>,
  input: KnowledgeIssueReviewInput,
  reviewedAt: number,
): Promise<KnowledgeSourceRecord> {
  return store.upsertSource({
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    title: typeof facts.title === 'string' ? facts.title : source.title,
    sourceUri: source.sourceUri,
    canonicalUri: source.canonicalUri,
    summary: typeof facts.summary === 'string' ? facts.summary : source.summary,
    description: typeof facts.description === 'string' ? facts.description : source.description,
    tags: source.tags,
    folderPath: source.folderPath,
    status: input.action === 'forget' ? 'stale' : source.status,
    artifactId: source.artifactId,
    contentHash: source.contentHash,
    lastCrawledAt: source.lastCrawledAt,
    crawlError: source.crawlError,
    sessionId: source.sessionId,
    metadata: {
      reviewedFacts: facts,
      review: { action: input.action, reviewer: input.reviewer ?? 'knowledge-review', reviewedAt },
    },
  });
}

async function applyNodeFacts(
  store: KnowledgeStore,
  node: KnowledgeNodeRecord,
  facts: Record<string, unknown>,
  input: KnowledgeIssueReviewInput,
  reviewedAt: number,
): Promise<KnowledgeNodeRecord> {
  return store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: typeof facts.title === 'string' ? facts.title : node.title,
    summary: typeof facts.summary === 'string' ? facts.summary : node.summary,
    aliases: node.aliases,
    status: input.action === 'forget' ? 'stale' : node.status,
    confidence: input.action === 'accept' ? 100 : node.confidence,
    sourceId: node.sourceId,
    metadata: {
      reviewedFacts: facts,
      review: { action: input.action, reviewer: input.reviewer ?? 'knowledge-review', reviewedAt },
    },
  });
}

function readReviewFacts(value: unknown): Record<string, unknown> {
  const record = readRecord(value);
  const fact = readRecord(record.fact);
  const metadata = readRecord(record.metadata);
  if (Object.keys(fact).length > 0) return fact;
  if (Object.keys(metadata).length > 0) return metadata;
  return {};
}

function buildSuppression(
  input: KnowledgeIssueReviewInput,
  issue: KnowledgeIssueRecord,
  reviewedAt: number,
): Record<string, unknown> | undefined {
  if (!['accept', 'reject', 'resolve'].includes(input.action)) return undefined;
  return {
    suppressed: true,
    issueId: issue.id,
    code: issue.code,
    action: input.action,
    reviewer: input.reviewer ?? 'knowledge-review',
    reviewedAt,
    subjectId: issue.nodeId ?? issue.sourceId ?? issue.id,
  };
}

function statusForAction(action: KnowledgeReviewAction, current: KnowledgeIssueRecord['status']): KnowledgeIssueRecord['status'] {
  if (action === 'reopen' || action === 'edit') return 'open';
  if (action === 'accept' || action === 'reject' || action === 'resolve' || action === 'forget') return 'resolved';
  return current;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
