/**
 * memory-recall-contract.ts — the CROSS-SURFACE recall-honesty contract (see CHANGELOG 1.0.0).
 *
 * PROVENANCE. This is the agent's memory-honesty discipline, promoted
 * verbatim from a single surface (the agent's memory-prompt.ts) into the SDK so it
 * is ONE shared contract, not a discipline re-derived (and re-weakened) per surface.
 * Under memory unification the store is unified and cross-surface, which multiplies the cost of a
 * dishonest recall — so this discipline becomes MORE load-bearing, not less. A
 * unified store must not be able to lie more loudly than the siloed one did.
 *
 * The contract is three rules:
 *   1. INJECTION FLOOR = the store's own declared baseline trust (60), never higher.
 *      MemoryStore.add() stamps every new record at confidence 60 unless the caller
 *      says otherwise. A floor above 60 would starve every honestly-stored fact — a
 *      freshly-learned fact could never clear recall on its own. The floor trusts a
 *      record exactly as much as the store already vouches for it; anything stored
 *      BELOW 60 (explicitly marked less certain) still does not qualify.
 *   2. FLAGGED RECORDS ARE NEVER INJECTED. stale/contradicted records are excluded
 *      outright, regardless of confidence — the surface already knows they are wrong
 *      or superseded, so no confidence number buys them back into a prompt.
 *   3. DEGRADED STATES ARE HONEST, NOT SILENT. an unavailable semantic index yields
 *      a STATED reason and a literal fallback — never a silent empty result that
 *      reads as "nothing was ever stored." 'no match' and 'index unavailable' are
 *      distinct and both said out loud.
 */

import type { MemoryRecord, MemorySearchFilter, MemorySemanticSearchResult } from './memory-store.js';
import type { MemoryVectorStats } from './memory-vector-store.js';
import { HASHED_MEMORY_EMBEDDING_PROVIDER } from './memory-embeddings.js';

/**
 * Recall-prompt confidence floor. Tied to the store's own baseline: MemoryStore.add
 * stamps new records at confidence 60. This is NOT a number chosen to make things
 * pass — it is the store's own definition of "a real, usable fact."
 */
export const MIN_PROMPT_MEMORY_CONFIDENCE = 60;

export interface MemoryPromptEligibility {
  readonly eligible: boolean;
  /** Why this record did or did not clear the recall floor — confidence, review state, and provenance, never silent. */
  readonly reason: string;
}

function provenanceSummary(record: MemoryRecord): string {
  if (record.provenance.length === 0) return 'no provenance recorded';
  return `provenance ${record.provenance.slice(0, 2).map((entry) => `${entry.kind}:${entry.ref}`).join(', ')}`;
}

/**
 * Recall-eligibility decision for one record, with an honest human-readable reason
 * attached (never a silent yes/no). This is the receipt every surface surfaces.
 *
 * Flagged records (stale/contradicted) are excluded outright regardless of
 * confidence. Everything else is judged on its own stored confidence against
 * MIN_PROMPT_MEMORY_CONFIDENCE — the store's own baseline. Nothing is blanket-boosted.
 */
export function describeMemoryPromptEligibility(record: MemoryRecord): MemoryPromptEligibility {
  const provenance = provenanceSummary(record);
  if (record.reviewState === 'stale' || record.reviewState === 'contradicted') {
    return {
      eligible: false,
      reason: `reviewState is ${record.reviewState} — flagged memory is never injected regardless of confidence (${provenance})`,
    };
  }
  if (record.confidence < MIN_PROMPT_MEMORY_CONFIDENCE) {
    return {
      eligible: false,
      reason: `confidence ${record.confidence}% is below the ${MIN_PROMPT_MEMORY_CONFIDENCE}% recall floor (${provenance})`,
    };
  }
  return {
    eligible: true,
    reason: `confidence ${record.confidence}% clears the ${MIN_PROMPT_MEMORY_CONFIDENCE}% recall floor, reviewState ${record.reviewState} (${provenance})`,
  };
}

export function isPromptActiveMemory(record: MemoryRecord): boolean {
  return describeMemoryPromptEligibility(record).eligible;
}

/**
 * A HARD unavailable reason: the semantic index cannot be consulted at all, so a
 * search must fall back to a literal scan and SAY SO — never a silent empty result
 * that reads as "no memory matches" when the index was never asked. Returns null
 * when the index is available and can be consulted.
 */
export function describeMemoryIndexUnavailable(stats: MemoryVectorStats): string | null {
  if (!stats.enabled) return 'the semantic memory index is disabled for this store';
  if (!stats.available) return `the semantic memory index is unavailable${stats.error ? `: ${stats.error}` : ''}`;
  if (stats.indexedRecords === 0) return 'the semantic memory index has no indexed records yet';
  return null;
}

/**
 * A SOFT caveat: the index is up and consulted, but running on the built-in
 * hashed-only fallback embedding provider rather than a modeled semantic provider.
 * Still ranks real matches better than a literal scan, but say so rather than
 * presenting it as equivalent. Returns null when a real provider is configured.
 */
export function describeMemoryIndexCaveat(stats: MemoryVectorStats): string | null {
  if (stats.embeddingProviderId === HASHED_MEMORY_EMBEDDING_PROVIDER.id) {
    return 'running on the hashed-only fallback embedding provider (no dedicated semantic model configured) — ranking is approximate, not modeled semantic understanding';
  }
  return null;
}

/**
 * The minimal read surface a honest search needs. MemoryStore (and MemoryRegistry)
 * satisfy this structurally — the function stays decoupled from either concrete
 * class so it can run over any store that exposes the three read paths.
 */
export interface HonestSearchStore {
  search(filter: MemorySearchFilter): MemoryRecord[];
  searchSemantic(filter: MemorySearchFilter): MemorySemanticSearchResult[];
  vectorStats(): MemoryVectorStats;
}

export interface HonestMemorySearchOptions {
  /**
   * Apply the recall-INJECTION contract to the result set: exclude flagged
   * (stale/contradicted) records outright and drop records below the confidence
   * floor, counting each exclusion honestly. Off by default — a review/browse
   * caller wants to SEE flagged and low-confidence records; only a prompt-recall
   * caller filters them out.
   */
  readonly recall?: boolean | undefined;
}

/**
 * The honest search envelope. `records` is what a caller should use; the rest is
 * the receipt: which path actually ran, and — when a degraded path was taken —
 * WHY, out loud. A wire client and a local surface serialize the SAME envelope, so
 * the honesty contract cannot be re-weakened per surface.
 */
export interface HonestMemorySearchResult {
  readonly records: readonly MemoryRecord[];
  /** The path that actually ran. `'literal'` even when semantic was requested but the index could not be consulted. */
  readonly mode: 'literal' | 'semantic';
  readonly requestedSemantic: boolean;
  /** Non-null ONLY when semantic was requested and the index could not be consulted, forcing the literal fallback. The stated reason — never a silent empty. */
  readonly indexUnavailableReason: string | null;
  /** Soft caveat when the semantic path ran on the hashed-only fallback provider. */
  readonly caveat: string | null;
  /** Whether the recall-injection contract filtered the set (options.recall). */
  readonly recallFiltered: boolean;
  readonly excludedFlaggedCount: number;
  readonly excludedBelowFloorCount: number;
  /** Result count BEFORE any recall-injection filtering — so a caller can tell "index empty" from "everything filtered out". */
  readonly totalBeforeRecallFilter: number;
}

/**
 * Run a search that HONORS the recall-honesty contract end to end:
 *  - semantic requested + index consultable → semantic ranking (+ soft caveat when
 *    on the hashed fallback provider);
 *  - semantic requested + index NOT consultable → literal scan WITH the stated
 *    `indexUnavailableReason`, never a silent empty that reads as "nothing stored";
 *  - `recall: true` → flagged records excluded outright and sub-floor records
 *    dropped, each exclusion counted rather than silently vanished.
 *
 * This is the ONE composition every surface (daemon route, wire client, offline
 * local store) calls, so the contract is applied identically everywhere.
 */
export function runHonestMemorySearch(
  store: HonestSearchStore,
  filter: MemorySearchFilter = {},
  options: HonestMemorySearchOptions = {},
): HonestMemorySearchResult {
  const requestedSemantic = filter.semantic === true;
  let mode: 'literal' | 'semantic' = 'literal';
  let indexUnavailableReason: string | null = null;
  let caveat: string | null = null;
  let baseRecords: MemoryRecord[];

  if (requestedSemantic) {
    const stats = store.vectorStats();
    indexUnavailableReason = describeMemoryIndexUnavailable(stats);
    if (indexUnavailableReason !== null) {
      // Honest degrade: the index cannot be consulted, so fall back to a literal
      // scan and SAY SO via indexUnavailableReason.
      baseRecords = store.search({ ...filter, semantic: false });
    } else {
      mode = 'semantic';
      caveat = describeMemoryIndexCaveat(stats);
      baseRecords = store.searchSemantic(filter).map((entry) => entry.record);
    }
  } else {
    baseRecords = store.search(filter);
  }

  const totalBeforeRecallFilter = baseRecords.length;
  if (!options.recall) {
    return {
      records: baseRecords,
      mode,
      requestedSemantic,
      indexUnavailableReason,
      caveat,
      recallFiltered: false,
      excludedFlaggedCount: 0,
      excludedBelowFloorCount: 0,
      totalBeforeRecallFilter,
    };
  }

  const kept: MemoryRecord[] = [];
  let excludedFlaggedCount = 0;
  let excludedBelowFloorCount = 0;
  for (const record of baseRecords) {
    if (isPromptActiveMemory(record)) {
      kept.push(record);
      continue;
    }
    if (record.reviewState === 'stale' || record.reviewState === 'contradicted') {
      excludedFlaggedCount += 1;
    } else {
      excludedBelowFloorCount += 1;
    }
  }
  return {
    records: kept,
    mode,
    requestedSemantic,
    indexUnavailableReason,
    caveat,
    recallFiltered: true,
    excludedFlaggedCount,
    excludedBelowFloorCount,
    totalBeforeRecallFilter,
  };
}
