import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticGapInput } from './types.js';
import {
  normalizeWhitespace,
  readString,
  readStringArray,
  semanticHash,
  semanticMetadata,
  tokenizeSemanticQuery,
  uniqueStrings,
} from './utils.js';
import {
  GENERIC_ANSWER_INTENT_TOKENS,
  isBroadKnowledgeSpaceAlias,
} from './answer-common.js';
import { hasAny } from './answer-fact-selection.js';

export function shouldPersistNoMatchGap(
  spaceId: string,
  query: string,
  linkedObjects: readonly KnowledgeNodeRecord[],
): boolean {
  if (linkedObjects.length > 0) return true;
  if (!isBroadKnowledgeSpaceAlias(spaceId)) return true;
  const subjectTokens = tokenizeSemanticQuery(query).filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token));
  return subjectTokens.length > 0;
}

export async function persistAnswerGap(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  reason: string,
  context: {
    readonly subject?: string;
    readonly sources?: readonly KnowledgeSourceRecord[];
    readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  } = {},
): Promise<KnowledgeNodeRecord> {
  const linkedObjects = context.linkedObjects ?? [];
  const sources = context.sources ?? [];
  const subject = context.subject ?? linkedObjects[0]?.title;
  const fingerprint = answerGapFingerprint(spaceId, query, subject, linkedObjects[0]?.id);
  const id = `sem-answer-gap-${fingerprint}`;
  const existing = store.getNode(id);
  const node = await store.upsertNode({
    id,
    kind: 'knowledge_gap',
    slug: `answer-gap-${fingerprint}`,
    title: query,
    summary: reason,
    confidence: 70,
    ...(sources[0] ? { sourceId: sources[0].id } : {}),
    metadata: semanticMetadata(spaceId, {
      semanticKind: 'gap',
      gapKind: 'answer',
      query,
      reason,
      subject,
      subjectFingerprint: fingerprint,
      sourceIds: sources.map((source) => source.id),
      linkedObjectIds: linkedObjects.map((node) => node.id),
      repairStatus: readString(existing?.metadata.repairStatus) ?? 'open',
      ...((readStringArray(existing?.metadata.acceptedSourceIds).length > 0) ? { acceptedSourceIds: readStringArray(existing?.metadata.acceptedSourceIds) } : {}),
      ...(typeof existing?.metadata.promotedFactCount === 'number' ? { promotedFactCount: existing.metadata.promotedFactCount } : {}),
      ...(typeof existing?.metadata.nextRepairAttemptAt === 'number' ? { nextRepairAttemptAt: existing.metadata.nextRepairAttemptAt } : {}),
      visibility: 'refinement',
      displayRole: 'knowledge-gap',
    }),
  });
  for (const source of sources) {
    await store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { gapKind: 'answer' }),
    });
  }
  for (const object of linkedObjects) {
    await store.upsertEdge({
      fromKind: 'node',
      fromId: object.id,
      toKind: 'node',
      toId: node.id,
      relation: 'has_gap',
      metadata: semanticMetadata(spaceId, { gapKind: 'answer' }),
    });
  }
  if (!isRepairedAnswerGap(node)) {
    await store.upsertIssue({
      id: `sem-answer-gap-issue-${fingerprint}`,
      severity: 'info',
      code: 'knowledge.answer_gap',
      message: `No knowledge answer available for: ${query}`,
      status: 'open',
      ...(sources[0] ? { sourceId: sources[0].id } : {}),
      nodeId: node.id,
      metadata: semanticMetadata(spaceId, {
        namespace: `knowledge:${spaceId}:answers`,
        query,
        reason,
        subject,
        subjectFingerprint: fingerprint,
        sourceIds: sources.map((source) => source.id),
        linkedObjectIds: linkedObjects.map((entry) => entry.id),
      }),
    });
  } else {
    await resolveAnswerGapIssues(store, spaceId, node.id);
  }
  return node;
}

export async function persistAnswerGaps(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  gaps: readonly KnowledgeSemanticGapInput[],
  context: {
    readonly sources?: readonly KnowledgeSourceRecord[];
    readonly linkedObjects?: readonly KnowledgeNodeRecord[];
  } = {},
): Promise<readonly KnowledgeNodeRecord[]> {
  const nodes: KnowledgeNodeRecord[] = [];
  for (const gap of gaps.slice(0, 8)) {
    const node = await persistAnswerGap(store, spaceId, gap.question || query, gap.reason ?? 'Answer synthesis identified a missing knowledge gap.', {
      ...context,
      ...(gap.subject ? { subject: gap.subject } : {}),
    });
    if (!isRepairedAnswerGap(node)) nodes.push(node);
  }
  return nodes;
}

export function isRepairedAnswerGap(node: KnowledgeNodeRecord): boolean {
  const repairStatus = readString(node.metadata.repairStatus);
  return node.status === 'stale'
    || repairStatus === 'not_applicable'
    || (repairStatus === 'repaired' && typeof node.metadata.promotedFactCount === 'number' && node.metadata.promotedFactCount > 0);
}

async function resolveAnswerGapIssues(store: KnowledgeStore, spaceId: string, nodeId: string): Promise<void> {
  for (const issue of store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === nodeId && entry.status === 'open')) {
    await store.upsertIssue({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      status: 'resolved',
      sourceId: issue.sourceId,
      nodeId: issue.nodeId,
      metadata: semanticMetadata(spaceId, {
        ...issue.metadata,
        resolution: {
          reason: 'Answer gap already has accepted repair evidence.',
          resolvedBy: 'knowledge-answer',
          resolvedAt: Date.now(),
        },
      }),
    });
  }
}

function answerGapFingerprint(spaceId: string, query: string, subject?: string, subjectId?: string): string {
  return semanticHash(spaceId, subjectId ?? normalizeGapSubject(subject), answerGapIntent(query));
}

function normalizeGapSubject(subject: string | undefined): string {
  return normalizeWhitespace(subject ?? 'unscoped').toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'unscoped';
}

function answerGapIntent(query: string): string {
  const tokens = new Set(tokenizeSemanticQuery(query));
  if (hasAny(tokens, ['feature', 'features', 'capability', 'capabilities', 'function', 'functions', 'spec', 'specs', 'specification', 'specifications'])) {
    return 'features-specifications';
  }
  if (hasAny(tokens, ['battery', 'batteries'])) return 'battery';
  if (hasAny(tokens, ['manual', 'documentation', 'source', 'sources'])) return 'source-documentation';
  return uniqueStrings([...tokens].filter((token) => !GENERIC_ANSWER_INTENT_TOKENS.has(token)).sort()).slice(0, 8).join('-') || 'general';
}
