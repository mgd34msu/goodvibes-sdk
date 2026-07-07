import type { KnowledgeStore } from './store.js';
import type { KnowledgeIssueRecord, KnowledgeNodeRecord } from './types.js';
import { tokenize } from './shared.js';
import {
  type KnowledgeScopeLookup,
  knowledgeIssueMatchesScope,
  knowledgeNodeMatchesScope,
} from './scope-records.js';

export interface KnowledgeNodeQueryInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly includeStale?: boolean | undefined;
  readonly query?: string | undefined;
}

export interface KnowledgeIssueQueryInput {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
  readonly severity?: string | undefined;
  readonly status?: string | undefined;
  readonly code?: string | undefined;
  readonly query?: string | undefined;
}

export function queryKnowledgeNodes(
  store: KnowledgeStore,
  scopeLookup: KnowledgeScopeLookup,
  input: KnowledgeNodeQueryInput,
): { total: number; items: KnowledgeNodeRecord[] } {
  const limit = Math.max(1, input.limit ?? 100);
  const offset = Math.max(0, input.offset ?? 0);
  const queryTokens = tokenize(input.query ?? '');
  // Honest default: forgotten/superseded ('stale') nodes are not served unless a
  // caller explicitly asks (status filter or includeStale) — closes the GraphQL
  // serve-surface drift where `forget` hid a node from search but GraphQL still
  // returned it. (Defect 6.)
  const includeStale = input.includeStale === true || input.status !== undefined;
  const items = store.listNodes(Number.MAX_SAFE_INTEGER).filter((node) => {
    if (!knowledgeNodeMatchesScope(node, input, scopeLookup)) return false;
    if (input.kind && node.kind !== input.kind) return false;
    if (!includeStale && node.status === 'stale') return false;
    if (input.status && node.status !== input.status) return false;
    if (queryTokens.length === 0) return true;
    const haystack = [node.title, node.summary ?? '', node.aliases.join(' '), JSON.stringify(node.metadata)].join(' ').toLowerCase();
    return queryTokens.every((token) => haystack.includes(token));
  });
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

export function queryKnowledgeIssues(
  store: KnowledgeStore,
  scopeLookup: KnowledgeScopeLookup,
  input: KnowledgeIssueQueryInput,
): { total: number; items: KnowledgeIssueRecord[] } {
  const limit = Math.max(1, input.limit ?? 100);
  const offset = Math.max(0, input.offset ?? 0);
  const queryTokens = tokenize(input.query ?? '');
  const items = store.listIssues(Number.MAX_SAFE_INTEGER).filter((issue) => {
    if (!knowledgeIssueMatchesScope(issue, input, scopeLookup)) return false;
    if (input.severity && issue.severity !== input.severity) return false;
    if (input.status && issue.status !== input.status) return false;
    if (input.code && issue.code !== input.code) return false;
    if (queryTokens.length === 0) return true;
    const haystack = [issue.message, issue.code, JSON.stringify(issue.metadata)].join(' ').toLowerCase();
    return queryTokens.every((token) => haystack.includes(token));
  });
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

export interface KnowledgeNodeReviewDecisionInput {
  readonly id: string;
  readonly decision: 'accept' | 'reject';
  readonly reviewer?: string | undefined;
}

/**
 * The decide step that governs node activation: accept a pending 'draft' node
 * (activates it with honest 'reviewed' provenance) or reject it (marks it
 * 'stale'). (Defect 2.)
 */
export async function reviewKnowledgeNodeRecord(
  store: KnowledgeStore,
  input: KnowledgeNodeReviewDecisionInput,
): Promise<{ ok: boolean; node?: KnowledgeNodeRecord | undefined }> {
  await store.init();
  const node = store.getNode(input.id);
  if (!node) return { ok: false };
  const reviewer = input.reviewer ?? 'knowledge-review';
  const updated = await store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: node.title,
    ...(node.summary ? { summary: node.summary } : {}),
    aliases: [...node.aliases],
    status: input.decision === 'accept' ? 'active' : 'stale',
    confidence: node.confidence,
    ...(node.sourceId ? { sourceId: node.sourceId } : {}),
    metadata: { ...node.metadata, review: { action: input.decision, reviewer, reviewedAt: Date.now() } },
  });
  return { ok: true, node: updated };
}
