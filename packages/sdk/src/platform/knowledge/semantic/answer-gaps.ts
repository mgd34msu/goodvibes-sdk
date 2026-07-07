import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import {
  DEFAULT_KNOWLEDGE_SPACE_ID,
  normalizeKnowledgeSpaceId,
} from '../spaces.js';
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
  if (normalizeKnowledgeSpaceId(spaceId) === DEFAULT_KNOWLEDGE_SPACE_ID) return false;
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
    readonly subject?: string | undefined;
    readonly sources?: readonly KnowledgeSourceRecord[] | undefined;
    readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
  } = {},
): Promise<KnowledgeNodeRecord> {
  const linkedObjects = context.linkedObjects ?? [];
  const sources = context.sources ?? [];
  const subject = context.subject ?? linkedObjects[0]?.title;
  const fingerprint = answerGapFingerprint(spaceId, query, subject, linkedObjects[0]?.id);
  const id = `sem-answer-gap-${fingerprint}`;
  const existing = store.getNode(id);
  return store.batch(async () => {
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
  });
}

export async function persistAnswerGaps(
  store: KnowledgeStore,
  spaceId: string,
  query: string,
  gaps: readonly KnowledgeSemanticGapInput[],
  context: {
    readonly sources?: readonly KnowledgeSourceRecord[] | undefined;
    readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
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

/**
 * A gap counts as repaired only when there is REAL evidence: the repair pipeline
 * marked it `repaired` AND it carries a concrete signal — one or more promoted
 * facts, or one or more accepted new sources. A node merely going `stale`
 * (superseded) or being marked `not_applicable` (deemed non-repairable) is NOT
 * repair evidence; those gaps stay open honestly instead of being auto-resolved
 * with an invented reason. (Invariant 4 / honesty.)
 */
export function isRepairedAnswerGap(node: KnowledgeNodeRecord): boolean {
  if (readString(node.metadata.repairStatus) !== 'repaired') return false;
  const promotedFactCount = typeof node.metadata.promotedFactCount === 'number' ? node.metadata.promotedFactCount : 0;
  const acceptedSourceIds = readStringArray(node.metadata.acceptedSourceIds);
  return promotedFactCount > 0 || acceptedSourceIds.length > 0;
}

async function resolveAnswerGapIssues(store: KnowledgeStore, spaceId: string, nodeId: string): Promise<void> {
  const node = store.getNode(nodeId);
  const promotedFactCount = typeof node?.metadata.promotedFactCount === 'number' ? node.metadata.promotedFactCount : 0;
  const acceptedSourceIds = readStringArray(node?.metadata.acceptedSourceIds);
  const evidence: string[] = [];
  if (promotedFactCount > 0) evidence.push(`${promotedFactCount} promoted fact${promotedFactCount === 1 ? '' : 's'}`);
  if (acceptedSourceIds.length > 0) evidence.push(`${acceptedSourceIds.length} accepted source${acceptedSourceIds.length === 1 ? '' : 's'}`);
  const reason = `Answer gap resolved from repair evidence: ${evidence.join(', ')}.`;
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
          reason,
          resolvedBy: 'knowledge-answer-repair',
          resolvedAt: Date.now(),
          ...(promotedFactCount > 0 ? { promotedFactCount } : {}),
          ...(acceptedSourceIds.length > 0 ? { acceptedSourceIds } : {}),
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
