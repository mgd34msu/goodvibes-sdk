import type { KnowledgeNodeKind, KnowledgeNodeStatus } from './types.js';

export type KnowledgeNodeRevisionChangeKind = 'create' | 'update';

/**
 * An append-only snapshot of a knowledge node's content at one point in its
 * history. Written on every content-changing upsert so a node's prior state is
 * preserved rather than silently overwritten; `changedFields` records what the
 * mutation changed. This is the "version control built in" invariant of the wiki
 * concept.
 */
export interface KnowledgeNodeRevisionRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly revision: number;
  readonly changeKind: KnowledgeNodeRevisionChangeKind;
  readonly changedFields: readonly string[];
  readonly kind: KnowledgeNodeKind;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly aliases: readonly string[];
  readonly status: KnowledgeNodeStatus;
  readonly confidence: number;
  readonly sourceId?: string | undefined;
  readonly metadata: Record<string, unknown>;
  readonly nodeCreatedAt: number;
  readonly nodeUpdatedAt: number;
  readonly recordedAt: number;
}

/**
 * The review provenance stamped on a node whenever it becomes (or stays) active.
 * Makes activation honest: a node is never silently active — it is either
 * auto-accepted above the configured confidence threshold, held pending review,
 * explicitly reviewed, or (for nodes that predate the gate) marked 'pre-gate'.
 */
export type KnowledgeNodeReviewState = 'auto-accepted' | 'pending-review' | 'reviewed' | 'pre-gate' | 'explicit';

export interface KnowledgeNodeReviewProvenance {
  readonly state: KnowledgeNodeReviewState;
  readonly reason: string;
  readonly decidedAt: number;
  readonly threshold?: number | undefined;
  readonly reviewer?: string | undefined;
}

/**
 * Derived semantic-enrichment bookkeeping for a source, kept in its own record so
 * enrichment never mutates the append-only source row. Holds the enrichment cache
 * key (text hash) and details.
 */
export interface KnowledgeSemanticEnrichmentStateRecord {
  readonly sourceId: string;
  readonly textHash?: string | undefined;
  readonly enrichedAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
