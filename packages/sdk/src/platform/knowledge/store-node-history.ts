import type { SQLiteStore } from '../state/sqlite-store.js';
import { nowMs } from './store-schema.js';
import { DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE } from './store-config.js';
import type { KnowledgeStore } from './store.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeNodeReviewProvenance,
  KnowledgeNodeReviewState,
  KnowledgeNodeRevisionChangeKind,
  KnowledgeNodeRevisionRecord,
  KnowledgeNodeUpsertInput,
  KnowledgeSemanticEnrichmentStateRecord,
} from './types.js';

export function writeKnowledgeNodeRow(sqlite: SQLiteStore, record: KnowledgeNodeRecord): void {
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_nodes (
      id, kind, slug, title, summary, aliases, status, confidence, source_id, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.id,
    record.kind,
    record.slug,
    record.title,
    record.summary ?? null,
    JSON.stringify([...record.aliases]),
    record.status,
    record.confidence,
    record.sourceId ?? null,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNodeReviewer(metadata: Record<string, unknown>): string | undefined {
  const review = metadata.review;
  if (!isPlainRecord(review)) return undefined;
  const reviewer = review.reviewer;
  return typeof reviewer === 'string' && reviewer.trim().length > 0 ? reviewer.trim() : 'knowledge-review';
}

function readNodeProvenanceState(metadata: Record<string, unknown>): string | undefined {
  const provenance = metadata.reviewProvenance;
  if (!isPlainRecord(provenance)) return undefined;
  return typeof provenance.state === 'string' ? provenance.state : undefined;
}

function stampNodeProvenance(
  metadata: Record<string, unknown>,
  provenance: KnowledgeNodeReviewProvenance,
): Record<string, unknown> {
  return { ...metadata, reviewProvenance: provenance };
}

/**
 * Decide a node's effective status and stamp honest review provenance so a node is
 * never silently active. (Invariants 2 & 4.)
 * - An explicit producer status (or a review that applied facts) is honored and
 *   labelled 'explicit'/'reviewed'.
 * - An already-active node stays active; if it predates the gate it is labelled
 *   'pre-gate' (folds/migrations never get downgraded).
 * - A new/draft node auto-accepts at/above the configured confidence threshold
 *   (labelled 'auto-accepted') or is held as 'draft' pending review otherwise.
 */
export function resolveNodeActivation(args: {
  readonly input: KnowledgeNodeUpsertInput;
  readonly existing: KnowledgeNodeRecord | undefined;
  readonly confidence: number;
  readonly metadata: Record<string, unknown>;
  readonly now: number;
  readonly autoAcceptConfidence: number;
}): { status: KnowledgeNodeRecord['status']; metadata: Record<string, unknown> } {
  const { input, existing, confidence, metadata, now, autoAcceptConfidence } = args;
  const reviewer = readNodeReviewer(metadata);
  const reviewedByFacts = reviewer !== undefined;
  if (input.status) {
    const state: KnowledgeNodeReviewState = reviewedByFacts ? 'reviewed' : 'explicit';
    return {
      status: input.status,
      metadata: stampNodeProvenance(metadata, {
        state,
        reason: reviewedByFacts
          ? `reviewed: status set to '${input.status}' by ${reviewer}`
          : `explicit: producer set status '${input.status}'`,
        decidedAt: now,
        ...(reviewer !== undefined ? { reviewer } : {}),
      }),
    };
  }
  if (reviewedByFacts && existing) {
    return {
      status: existing.status,
      metadata: stampNodeProvenance(metadata, {
        state: 'reviewed',
        reason: `reviewed by ${reviewer}`,
        decidedAt: now,
        reviewer,
      }),
    };
  }
  if (existing && existing.status === 'active') {
    if (readNodeProvenanceState(metadata)) return { status: 'active', metadata };
    return {
      status: 'active',
      metadata: stampNodeProvenance(metadata, {
        state: 'pre-gate',
        reason: 'pre-gate: node was active before the review gate; left active',
        decidedAt: now,
      }),
    };
  }
  if (confidence >= autoAcceptConfidence) {
    return {
      status: 'active',
      metadata: stampNodeProvenance(metadata, {
        state: 'auto-accepted',
        reason: `auto-accepted: confidence ${confidence} >= auto-accept threshold ${autoAcceptConfidence}`,
        decidedAt: now,
        threshold: autoAcceptConfidence,
      }),
    };
  }
  return {
    status: 'draft',
    metadata: stampNodeProvenance(metadata, {
      state: 'pending-review',
      reason: `pending review: confidence ${confidence} < auto-accept threshold ${autoAcceptConfidence}`,
      decidedAt: now,
      threshold: autoAcceptConfidence,
    }),
  };
}

/**
 * Record an append-only revision on a content-changing upsert: preserve the
 * overwritten prior content and note what changed. (Invariant 8.)
 */
export function recordKnowledgeNodeRevisions(
  sqlite: SQLiteStore,
  nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>,
  record: KnowledgeNodeRecord,
  existing: KnowledgeNodeRecord | undefined,
  now: number,
): void {
  const list = nodeRevisions.get(record.id) ?? [];
  if (existing) {
    const changedFields = diffKnowledgeNodeFields(existing, record);
    if (changedFields.length === 0) return; // idempotent re-upsert (e.g. a provenance-only restamp)
    if (list.length === 0) {
      // First tracked change to a pre-existing node: preserve the overwritten prior
      // content as the baseline revision so it is never lost.
      appendNodeRevision(sqlite, list, existing, 'create', [], now);
    }
    appendNodeRevision(sqlite, list, record, 'update', changedFields, now);
  } else {
    appendNodeRevision(sqlite, list, record, 'create', [], now);
  }
  nodeRevisions.set(record.id, list);
}

export function listKnowledgeNodeRevisions(
  nodeRevisions: Map<string, KnowledgeNodeRevisionRecord[]>,
  nodeId: string,
): KnowledgeNodeRevisionRecord[] {
  return [...(nodeRevisions.get(nodeId) ?? [])].sort((a, b) => a.revision - b.revision);
}

function appendNodeRevision(
  sqlite: SQLiteStore,
  list: KnowledgeNodeRevisionRecord[],
  snapshot: KnowledgeNodeRecord,
  changeKind: KnowledgeNodeRevisionChangeKind,
  changedFields: readonly string[],
  now: number,
): void {
  const revision = (list[list.length - 1]?.revision ?? 0) + 1;
  const rev: KnowledgeNodeRevisionRecord = {
    id: `noderev-${snapshot.id}-${revision}`,
    nodeId: snapshot.id,
    revision,
    changeKind,
    changedFields: [...changedFields],
    kind: snapshot.kind,
    slug: snapshot.slug,
    title: snapshot.title,
    ...(snapshot.summary ? { summary: snapshot.summary } : {}),
    aliases: [...snapshot.aliases],
    status: snapshot.status,
    confidence: snapshot.confidence,
    ...(snapshot.sourceId ? { sourceId: snapshot.sourceId } : {}),
    metadata: snapshot.metadata,
    nodeCreatedAt: snapshot.createdAt,
    nodeUpdatedAt: snapshot.updatedAt,
    recordedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_node_revisions (
      id, node_id, revision, change_kind, changed_fields, kind, slug, title, summary,
      aliases, status, confidence, source_id, metadata, node_created_at, node_updated_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    rev.id,
    rev.nodeId,
    rev.revision,
    rev.changeKind,
    JSON.stringify(rev.changedFields),
    rev.kind,
    rev.slug,
    rev.title,
    rev.summary ?? null,
    JSON.stringify([...rev.aliases]),
    rev.status,
    rev.confidence,
    rev.sourceId ?? null,
    JSON.stringify(rev.metadata),
    rev.nodeCreatedAt,
    rev.nodeUpdatedAt,
    rev.recordedAt,
  ]);
  list.push(rev);
}

function diffKnowledgeNodeFields(prev: KnowledgeNodeRecord, next: KnowledgeNodeRecord): string[] {
  const changed: string[] = [];
  if (prev.title !== next.title) changed.push('title');
  if ((prev.summary ?? '') !== (next.summary ?? '')) changed.push('summary');
  if (prev.status !== next.status) changed.push('status');
  if (prev.confidence !== next.confidence) changed.push('confidence');
  if ((prev.sourceId ?? '') !== (next.sourceId ?? '')) changed.push('sourceId');
  if (!sameStringSet(prev.aliases, next.aliases)) changed.push('aliases');
  if (stableMetadataForDiff(prev.metadata) !== stableMetadataForDiff(next.metadata)) changed.push('metadata');
  return changed;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

// Compare metadata for revision purposes ignoring the volatile review-provenance
// stamp (its decidedAt changes on every write); a provenance-only restamp must not
// count as a content change.
function stableMetadataForDiff(metadata: Record<string, unknown>): string {
  const { reviewProvenance: _reviewProvenance, ...rest } = metadata;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Merge one node into another: re-point every edge that referenced the loser onto
 * the winner (deduping and dropping self-loops), record a `merged_into` edge, and
 * mark the loser 'stale' with a `mergedInto` stamp. Keeps cross-references live on
 * the surviving node. (Invariant 7.)
 */
export async function mergeKnowledgeNodes(
  store: KnowledgeStore,
  loserId: string,
  winnerId: string,
): Promise<{ merged: boolean; repointedEdges: number }> {
  if (loserId === winnerId) return { merged: false, repointedEdges: 0 };
  const loser = store.getNode(loserId);
  const winner = store.getNode(winnerId);
  if (!loser || !winner) return { merged: false, repointedEdges: 0 };
  const mergedAt = nowMs();
  let repointedEdges = 0;
  await store.batch(async () => {
    for (const edge of store.listEdges()) {
      const fromMatch = edge.fromKind === 'node' && edge.fromId === loserId;
      const toMatch = edge.toKind === 'node' && edge.toId === loserId;
      if (!fromMatch && !toMatch) continue;
      const newFromId = fromMatch ? winnerId : edge.fromId;
      const newToId = toMatch ? winnerId : edge.toId;
      await store.deleteEdge(edge.id);
      if (newFromId === newToId && edge.fromKind === edge.toKind) continue;
      await store.upsertEdge({
        fromKind: edge.fromKind,
        fromId: newFromId,
        toKind: edge.toKind,
        toId: newToId,
        relation: edge.relation,
        weight: edge.weight,
        metadata: { ...edge.metadata, repointedFromNodeId: loserId, repointedAt: mergedAt },
      });
      repointedEdges += 1;
    }
    await store.upsertEdge({
      fromKind: 'node',
      fromId: loserId,
      toKind: 'node',
      toId: winnerId,
      relation: 'merged_into',
      metadata: { mergedAt },
    });
    await store.upsertNode({
      id: loser.id,
      kind: loser.kind,
      slug: loser.slug,
      title: loser.title,
      ...(loser.summary ? { summary: loser.summary } : {}),
      aliases: [...loser.aliases],
      status: 'stale',
      confidence: loser.confidence,
      ...(loser.sourceId ? { sourceId: loser.sourceId } : {}),
      metadata: { ...loser.metadata, mergedInto: winnerId, mergedAt },
    });
  });
  return { merged: true, repointedEdges };
}

export function upsertKnowledgeSemanticEnrichmentState(
  sqlite: SQLiteStore,
  states: Map<string, KnowledgeSemanticEnrichmentStateRecord>,
  input: {
    readonly sourceId: string;
    readonly textHash?: string | undefined;
    readonly enrichedAt?: number | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
): KnowledgeSemanticEnrichmentStateRecord {
  const existing = states.get(input.sourceId);
  const now = nowMs();
  const record: KnowledgeSemanticEnrichmentStateRecord = {
    sourceId: input.sourceId,
    ...(input.textHash ? { textHash: input.textHash } : {}),
    ...(typeof input.enrichedAt === 'number' ? { enrichedAt: input.enrichedAt } : {}),
    metadata: input.metadata ?? {},
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  sqlite.run(`
    INSERT OR REPLACE INTO knowledge_semantic_enrichment_state (
      source_id, text_hash, enriched_at, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `, [
    record.sourceId,
    record.textHash ?? null,
    record.enrichedAt ?? null,
    JSON.stringify(record.metadata),
    record.createdAt,
    record.updatedAt,
  ]);
  states.set(record.sourceId, record);
  return record;
}
