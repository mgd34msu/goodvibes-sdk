/**
 * memory-consolidation.ts — idle-time memory consolidation policy (HOISTED to the SDK).
 *
 * PROVENANCE. Promoted verbatim (semantics-preserving) from the agent surface
 * (`src/agent/memory-consolidation.ts`) so every consumer shares ONE
 * consolidation contract with injectable I/O, rather than each re-deriving it.
 * The only surface-coupled part — the record writes — is expressed as an
 * injected `MemoryConsolidationRegistry` seam; `MemoryRegistry` satisfies it
 * structurally.
 *
 * The pass performs only REVERSIBLE operations on existing records: it merges
 * duplicate records into a survivor and marks the losers stale (never deletes),
 * and it decays never-referenced, aged records (lowering confidence, then marking
 * stale once the confidence floor is crossed). Anything that would require a NEW
 * standing memory or a destructive delete is emitted as a PROPOSAL routed to the
 * existing confirmation-gated path — this pass never silently writes a new memory
 * or deletes a record. Every run returns a RECEIPT describing exactly what it
 * merged, archived, decayed, and proposed.
 */

import type { MemoryRecord, MemoryReviewPatch, MemoryScope } from './memory-store.js';
import type { ResolvedMemoryConsolidationConfig } from './memory-consolidation-config.js';

/** Honest per-memory usage signal consumed by the decay ordering. */
export interface MemoryConsolidationUsageSignal {
  readonly injectedCount: number;
  readonly referencedCount: number;
  readonly lastReferencedAt: number | null;
}

/** Lookup of the usage signal for a memory id; undefined when never instrumented. */
export type MemoryConsolidationUsageLookup = (memoryId: string) => MemoryConsolidationUsageSignal | undefined;

export type MemoryConsolidationTrigger = 'idle' | 'schedule' | 'manual';

/**
 * The record-mutation seam the pass writes through. Structural, so a concrete
 * MemoryRegistry (or any equivalent wrapper) satisfies it and the policy stays
 * decoupled from the store implementation. Only reversible writes are used:
 * `review` (mark stale / lower confidence) and `update` (merge tag unions).
 */
export interface MemoryConsolidationRegistry {
  getAll(): readonly MemoryRecord[];
  review(id: string, patch: MemoryReviewPatch): MemoryRecord | null;
  update(id: string, patch: { scope?: MemoryScope; summary?: string; detail?: string; tags?: string[] }): MemoryRecord | null;
}

export interface MemoryConsolidationInput {
  readonly memoryRegistry: MemoryConsolidationRegistry;
  readonly config: ResolvedMemoryConsolidationConfig;
  readonly now: number;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  /** Optional usage instrumentation. When present, never-referenced records decay first. */
  readonly usageLookup?: MemoryConsolidationUsageLookup;
  /**
   * Optional deterministic random-suffix seam for the receipt `runId`. Defaults
   * to `Math.random()`-derived. Injected only so tests can assert a stable id;
   * production leaves it unset for the same behavior as the agent original.
   */
  readonly randomSuffix?: () => string;
}

export interface MemoryConsolidationMergeEntry {
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly scope: string;
  readonly cls: string;
}

export interface MemoryConsolidationArchiveEntry {
  readonly id: string;
  readonly reason: string;
  readonly previousConfidence: number;
}

export interface MemoryConsolidationDecayEntry {
  readonly id: string;
  readonly fromConfidence: number;
  readonly toConfidence: number;
  readonly referencedCount: number;
}

export interface MemoryConsolidationProposal {
  readonly kind: 'contradiction' | 'cross-scope-duplicate' | 'stale-delete';
  readonly ids: readonly string[];
  readonly route: string;
  readonly reason: string;
}

export interface MemoryConsolidationRunReceipt {
  readonly runId: string;
  readonly ranAt: string;
  readonly trigger: MemoryConsolidationTrigger;
  readonly idle: boolean;
  readonly scanned: number;
  readonly merged: readonly MemoryConsolidationMergeEntry[];
  readonly archived: readonly MemoryConsolidationArchiveEntry[];
  readonly decayed: readonly MemoryConsolidationDecayEntry[];
  readonly proposed: readonly MemoryConsolidationProposal[];
  readonly usageSignalAvailable: boolean;
  readonly note: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DELETE_PROPOSAL_AGE_DAYS = 90;

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function verifiedRank(record: MemoryRecord): number {
  if (record.reviewState === 'reviewed') return 2;
  if (record.reviewState === 'fresh') return 1;
  return 0;
}

/** Active for consolidation purposes: fresh or reviewed only. Stale/contradicted are already resolved. */
function isActive(record: MemoryRecord): boolean {
  return record.reviewState === 'fresh' || record.reviewState === 'reviewed';
}

/** Prefer the newer, more-verified, higher-confidence record as the survivor. */
function chooseSurvivor(records: readonly MemoryRecord[]): MemoryRecord {
  return [...records].sort((left, right) => {
    if (verifiedRank(right) !== verifiedRank(left)) return verifiedRank(right) - verifiedRank(left);
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.updatedAt - left.updatedAt;
  })[0]!;
}

function usageSignalFor(
  lookup: MemoryConsolidationUsageLookup | undefined,
  id: string,
): MemoryConsolidationUsageSignal {
  return lookup?.(id) ?? { injectedCount: 0, referencedCount: 0, lastReferencedAt: null };
}

interface MergePlanResult {
  readonly merged: MemoryConsolidationMergeEntry[];
  readonly proposals: MemoryConsolidationProposal[];
  /** Ids consumed by a merge/contradiction this run, excluded from decay. */
  readonly touched: Set<string>;
}

/**
 * Group active records by distinctive summary key and, within each group, merge
 * exact duplicates into a survivor. Records with the same key but materially
 * different detail are treated as a contradiction: newer verified beats older
 * (the older is marked stale). Cross-scope collisions are only proposed, never
 * merged automatically.
 */
function planAndApplyMerges(input: MemoryConsolidationInput, active: readonly MemoryRecord[]): MergePlanResult {
  const merged: MemoryConsolidationMergeEntry[] = [];
  const proposals: MemoryConsolidationProposal[] = [];
  const touched = new Set<string>();

  const groups = new Map<string, MemoryRecord[]>();
  for (const record of active) {
    const key = normalizeKey(record.summary);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }

  for (const bucket of groups.values()) {
    if (merged.length >= input.config.maxMergesPerRun) break;
    if (bucket.length < 2) continue;

    const scopes = new Set(bucket.map((record) => record.scope));
    if (scopes.size > 1) {
      proposals.push({
        kind: 'cross-scope-duplicate',
        ids: bucket.map((record) => record.id),
        route: 'memory action:"curator" query:"consolidation"',
        reason: 'Same-summary records span multiple scopes; merging across scope needs review.',
      });
      continue;
    }

    const survivor = chooseSurvivor(bucket);
    const losers = bucket.filter((record) => record.id !== survivor.id);
    const survivorDetail = normalizeKey(survivor.detail ?? '');
    const mergedTags = new Set(survivor.tags);
    const duplicateIds: string[] = [];

    for (const loser of losers) {
      const loserDetail = normalizeKey(loser.detail ?? '');
      const sameDetail = loserDetail === '' || loserDetail === survivorDetail;
      if (sameDetail) {
        for (const tag of loser.tags) mergedTags.add(tag);
        input.memoryRegistry.review(loser.id, {
          state: 'stale',
          staleReason: `Duplicate of ${survivor.id}; merged by idle consolidation.`,
          reviewedBy: 'consolidation',
        });
        duplicateIds.push(loser.id);
        touched.add(loser.id);
      } else if (verifiedRank(survivor) >= verifiedRank(loser) && survivor.updatedAt > loser.updatedAt) {
        input.memoryRegistry.review(loser.id, {
          state: 'stale',
          staleReason: `Superseded by newer verified record ${survivor.id}; resolved by idle consolidation.`,
          reviewedBy: 'consolidation',
        });
        duplicateIds.push(loser.id);
        touched.add(loser.id);
      } else {
        proposals.push({
          kind: 'contradiction',
          ids: [survivor.id, loser.id],
          route: 'memory action:"curator" query:"consolidation"',
          reason: 'Same-summary records disagree and neither is a clearly-newer verified winner.',
        });
        touched.add(loser.id);
      }
    }

    if (duplicateIds.length === 0) continue;
    if (mergedTags.size !== survivor.tags.length) {
      input.memoryRegistry.update(survivor.id, { tags: [...mergedTags] });
    }
    touched.add(survivor.id);
    merged.push({ survivorId: survivor.id, duplicateIds, scope: survivor.scope, cls: survivor.cls });
  }

  return { merged, proposals, touched };
}

/**
 * Decay never-referenced, aged records — never-referenced first (that is what the
 * usage instrumentation feeds). A record's confidence drops by decayConfidenceStep;
 * once it would fall to/below archiveConfidenceFloor it is marked stale (archived).
 */
function applyDecay(
  input: MemoryConsolidationInput,
  active: readonly MemoryRecord[],
  touched: ReadonlySet<string>,
): { decayed: MemoryConsolidationDecayEntry[]; archived: MemoryConsolidationArchiveEntry[] } {
  const decayed: MemoryConsolidationDecayEntry[] = [];
  const archived: MemoryConsolidationArchiveEntry[] = [];
  const ageCutoff = input.now - input.config.decayAgeDays * DAY_MS;

  const candidates = active
    .filter((record) => !touched.has(record.id))
    .filter((record) => record.updatedAt <= ageCutoff)
    .map((record) => ({ record, usage: usageSignalFor(input.usageLookup, record.id) }))
    .filter((entry) => entry.usage.referencedCount === 0)
    .sort((left, right) => {
      const leftLast = left.usage.lastReferencedAt ?? 0;
      const rightLast = right.usage.lastReferencedAt ?? 0;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return left.record.updatedAt - right.record.updatedAt;
    });

  for (const { record, usage } of candidates) {
    if (decayed.length + archived.length >= input.config.maxDecaysPerRun) break;
    const nextConfidence = record.confidence - input.config.decayConfidenceStep;
    if (nextConfidence <= input.config.archiveConfidenceFloor) {
      input.memoryRegistry.review(record.id, {
        state: 'stale',
        staleReason: `Never referenced since injection and aged past ${input.config.decayAgeDays}d; archived by idle consolidation.`,
        reviewedBy: 'consolidation',
      });
      archived.push({ id: record.id, reason: 'never-referenced-aged', previousConfidence: record.confidence });
    } else {
      input.memoryRegistry.review(record.id, {
        state: record.reviewState,
        confidence: nextConfidence,
        reviewedBy: 'consolidation',
      });
      decayed.push({
        id: record.id,
        fromConfidence: record.confidence,
        toConfidence: nextConfidence,
        referencedCount: usage.referencedCount,
      });
    }
  }

  return { decayed, archived };
}

/** Propose (never perform) deletion of long-stale records through the gated memory route. */
function planStaleDeleteProposals(
  input: MemoryConsolidationInput,
  records: readonly MemoryRecord[],
  used: number,
): MemoryConsolidationProposal[] {
  const proposals: MemoryConsolidationProposal[] = [];
  const cutoff = input.now - STALE_DELETE_PROPOSAL_AGE_DAYS * DAY_MS;
  for (const record of records) {
    if (used + proposals.length >= input.config.maxProposalsPerRun) break;
    if (record.reviewState !== 'stale') continue;
    if (record.updatedAt > cutoff) continue;
    proposals.push({
      kind: 'stale-delete',
      ids: [record.id],
      route: `memory action:"delete" id:"${record.id}" explicitUserRequest:"..."`,
      reason: `Stale for over ${STALE_DELETE_PROPOSAL_AGE_DAYS}d; propose removal through the confirmed delete route.`,
    });
  }
  return proposals;
}

export function runMemoryConsolidation(input: MemoryConsolidationInput): MemoryConsolidationRunReceipt {
  const all = input.memoryRegistry.getAll();
  const active = all.filter(isActive);

  const mergeResult = planAndApplyMerges(input, active);
  const decayResult = applyDecay(input, active, mergeResult.touched);
  const proposals = [
    ...mergeResult.proposals,
    ...planStaleDeleteProposals(input, all, mergeResult.proposals.length),
  ].slice(0, input.config.maxProposalsPerRun);

  const suffix = input.randomSuffix ? input.randomSuffix() : Math.random().toString(36).slice(2, 8);
  const runId = `mcon-${input.now.toString(36)}-${suffix}`;
  return {
    runId,
    ranAt: new Date(input.now).toISOString(),
    trigger: input.trigger,
    idle: input.idle,
    scanned: all.length,
    merged: mergeResult.merged,
    archived: decayResult.archived,
    decayed: decayResult.decayed,
    proposed: proposals,
    usageSignalAvailable: input.usageLookup !== undefined,
    note: 'Idle consolidation performs only reversible merges (loser marked stale, not deleted) and never-referenced-first decay. New memories and deletes are proposed through the existing confirmation-gated routes, never written silently.',
  };
}
