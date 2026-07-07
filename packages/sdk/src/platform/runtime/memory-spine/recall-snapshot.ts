/**
 * recall-snapshot.ts — the sync-recall seam for the memory spine.
 *
 * THE PROBLEM. Per-turn memory recall wants to inject the recall-eligible records
 * into the system prompt. But the prompt builder is SYNCHRONOUS
 * (`Orchestrator.getSystemPrompt()` returns a string, not a promise), while a wire
 * client's memory reads are ASYNCHRONOUS (a fetch to the adopted daemon). A sync
 * function cannot await a wire read, so it cannot pull fresh memory over the wire
 * inline.
 *
 * THE DESIGN (cached snapshot, freshness-stamped, honest staleness note). Rather
 * than make the whole prompt path async (a large, cross-consumer refactor) or open
 * the store file from a wire client (which would break the single-writer invariant),
 * the spine maintains a CACHED recall snapshot:
 *
 *   1. an ASYNC pre-turn hook calls `MemorySpineClient.refreshRecallSnapshot()` —
 *      this awaits the wire (or local) honest recall search and stamps the result
 *      with a capture time and the access mode it came from;
 *   2. the SYNC prompt builder calls `MemorySpineClient.recallSnapshot()` — this
 *      returns the cached records immediately, with a freshly-computed age, a
 *      `stale` flag, and a human-readable `note`.
 *
 * HONESTY. The snapshot never lies about its own freshness. If it has never been
 * refreshed, it returns an EMPTY snapshot whose note says exactly that — never a
 * silent empty that a reader would misread as "nothing was ever stored". If the last
 * refresh is older than the staleness window, `stale` is true and the note says so,
 * so an injector can choose to note the staleness in the prompt rather than present
 * possibly-old memory as live. The `mode` records WHERE the snapshot was captured
 * (local host store vs the adopted daemon over the wire), so the note never implies
 * a wire read happened when it did not.
 */

import type { MemoryRecord } from '../../state/memory-store.js';
import type { HonestMemorySearchResult } from '../../state/memory-recall-contract.js';
import type { MemoryAccessMode } from './client.js';

/** Default freshness window: a snapshot older than this reports `stale: true`. */
export const DEFAULT_RECALL_SNAPSHOT_STALE_AFTER_MS = 30_000;

export interface MemoryRecallRefreshOptions {
  /**
   * Apply the recall-injection contract when refreshing (exclude flagged records and
   * drop sub-floor records, each exclusion counted). Defaults to TRUE — the snapshot
   * exists for prompt injection, which must honor the recall floor. Pass false to
   * capture an unfiltered browse set instead.
   */
  readonly recall?: boolean | undefined;
}

/**
 * A freshness-stamped, synchronously-readable recall result. `records` is what a
 * sync prompt builder injects; the rest is the honest receipt.
 */
export interface MemoryRecallSnapshot {
  /** The recall-eligible records captured by the last refresh (empty until first refresh). */
  readonly records: readonly MemoryRecord[];
  /** The full honest search envelope the records came from (null until first refresh). */
  readonly search: HonestMemorySearchResult | null;
  /** When the snapshot was captured (epoch ms), or null if never refreshed. */
  readonly capturedAt: number | null;
  /** Age of the snapshot in ms at read time, or null if never refreshed. */
  readonly ageMs: number | null;
  /** True when the snapshot is older than the staleness window (or never captured). */
  readonly stale: boolean;
  /** Where the snapshot was captured from — 'client' (over the wire) or 'local'. */
  readonly mode: MemoryAccessMode;
  /** An honest, human-readable freshness/degradation note — never silent. */
  readonly note: string;
}

const EMPTY_SEARCH_RECORDS: readonly MemoryRecord[] = Object.freeze([]);

/** The snapshot returned before any refresh has happened — empty, and it says so. */
export function emptyRecallSnapshot(mode: MemoryAccessMode): MemoryRecallSnapshot {
  return {
    records: EMPTY_SEARCH_RECORDS,
    search: null,
    capturedAt: null,
    ageMs: null,
    stale: true,
    mode,
    note: 'memory recall snapshot not yet captured — no memory injected this turn. '
      + 'Call refreshRecallSnapshot() in an async pre-turn hook before the synchronous prompt build.',
  };
}

/**
 * Build a snapshot from an honest search envelope captured at `capturedAt`, with age
 * and staleness computed against `now`. The `note` states the source, the age, and
 * — when stale — that the records may be out of date.
 */
export function buildRecallSnapshot(
  search: HonestMemorySearchResult,
  mode: MemoryAccessMode,
  capturedAt: number,
  staleAfterMs: number,
  now: number = Date.now(),
): MemoryRecallSnapshot {
  const ageMs = Math.max(0, now - capturedAt);
  const stale = ageMs > staleAfterMs;
  const source = mode === 'client' ? 'over the wire from the adopted daemon' : 'from the local store';
  // Humanized age, matching the TUI's established freshness vocabulary
  // (session-picker-modal.ts: "may be stale, last synced Ns ago"): lowercase, a
  // hedged "may be stale", and whole seconds — never raw milliseconds a reader
  // cannot comfortably read.
  const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
  const staleAfterSeconds = Math.max(0, Math.round(staleAfterMs / 1000));
  const freshness = stale
    ? `may be stale — captured ${ageSeconds}s ago (older than the ${staleAfterSeconds}s freshness window); a refresh is due`
    : `captured ${ageSeconds}s ago`;
  // Honest count clause: the snapshot's own recall flag decides what its count
  // means. Only a recall-filtered capture (flagged + sub-floor records dropped)
  // holds a "recall-eligible" count; an unfiltered browse capture holds the raw
  // browse-set count and must NOT be labeled recall-eligible.
  const countClause = search.recallFiltered
    ? `${search.records.length} record(s) recall-eligible`
    : `${search.records.length} record(s) in the browse set (unfiltered — recall floor not applied)`;
  const degraded = search.indexUnavailableReason
    ? ` Recall degraded to a literal scan: ${search.indexUnavailableReason}.`
    : '';
  const caveat = search.caveat ? ` ${search.caveat}.` : '';
  return {
    records: search.records,
    search,
    capturedAt,
    ageMs,
    stale,
    mode,
    note: `memory recall snapshot ${source}, ${freshness}; ${countClause}.`
      + degraded + caveat,
  };
}
