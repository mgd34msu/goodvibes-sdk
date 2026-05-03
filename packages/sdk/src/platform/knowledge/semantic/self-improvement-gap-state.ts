import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
} from '../types.js';
import {
  semanticMetadata,
} from './utils.js';

export const SELF_IMPROVEMENT_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export async function suppressGap(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  reason: string | undefined,
  spaceId: string,
): Promise<void> {
  await store.upsertNode({
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: 'stale',
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...gap.metadata,
      repairStatus: 'not_applicable',
      repairReason: reason,
      repairedAt: Date.now(),
    },
  });
  for (const issue of store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open')) {
    await resolveIssue(store, issue, spaceId, reason ?? 'Gap was classified as not applicable.');
  }
}

export async function markGapRepairAttempt(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  spaceId: string,
  details: {
    readonly status: string;
    readonly reason?: string;
    readonly query?: string;
    readonly acceptedSourceIds?: readonly string[];
    readonly promotedFactCount?: number;
    readonly nextRepairAttemptAt?: number;
  },
): Promise<void> {
  const nextRepairAttemptAt = details.nextRepairAttemptAt ?? (
    details.status === 'searched_no_sources' || details.status === 'failed' || details.status === 'deferred'
      ? Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS
      : undefined
  );
  await store.upsertNode({
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: gap.status,
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...gap.metadata,
      repairStatus: details.status,
      ...(details.reason ? { repairReason: details.reason } : {}),
      ...(details.query ? { repairQuery: details.query } : {}),
      ...((details.acceptedSourceIds?.length ?? 0) > 0 ? { acceptedSourceIds: details.acceptedSourceIds } : {}),
      ...(typeof details.promotedFactCount === 'number' ? { promotedFactCount: details.promotedFactCount } : {}),
      lastRepairAttemptAt: Date.now(),
      nextRepairAttemptAt,
      knowledgeSpaceId: spaceId,
    },
  });
  if (details.status === 'repaired') {
    for (const issue of store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open')) {
      await resolveIssue(store, issue, spaceId, details.reason ?? 'Gap was repaired with accepted source-backed evidence.');
    }
  }
}

async function resolveIssue(store: KnowledgeStore, issue: KnowledgeIssueRecord, spaceId: string, reason: string): Promise<void> {
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
        resolvedBy: 'semantic-self-improvement',
        resolvedAt: Date.now(),
      },
    }),
  });
}
