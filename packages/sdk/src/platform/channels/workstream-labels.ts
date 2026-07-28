/**
 * workstream-labels.ts — naming a workstream by what it is doing, not by its id.
 *
 * The workstream progress lines are the owner's: someone who asked for a long
 * piece of work is owed its legs — which phase it reached, whether review
 * passed, whether a gate failed. Suppressing them would be the "suppress the
 * message that should have been there" failure.
 *
 * But they used to read:
 *
 *     WRFC chain 7f3a91c02b4e started: rewrite the retry backoff
 *     WRFC chain 7f3a91c02b4e moved from reviewing to fixing
 *
 * Both halves of that are internal. `WRFC` is a name for the machinery, and
 * `7f3a91c02b4e` is a register id — and the standing rule is that neither
 * appears in outward-facing text. Plain language only; provenance travels as a
 * decision-record path or a version, not as an identifier a person cannot use.
 *
 * The identifier was doing one real job, though: telling two concurrent
 * workstreams apart. So it is replaced rather than deleted. A workstream
 * announces itself with its task in words, and every later line about it leads
 * with a short form of those same words:
 *
 *     Started work on: rewrite the retry backoff
 *     "rewrite the retry backoff" is now in review
 *
 * ── Two workstreams that would read the same ────────────────────────────────
 *
 * Two tasks can share an opening phrase — the same ask repeated, or two asks
 * whose first clauses only differ past the length a label keeps. The id used to
 * be what told them apart, so something else has to, and it is words rather
 * than a shorter id: the colliding workstreams are counted in the order they
 * started and each carries its place.
 *
 *     Started work on: rewrite the retry backoff
 *     Started work on: rewrite the retry backoff (the second one)
 *     "rewrite the retry backoff" (the first one) is now in review
 *
 * The first one is unqualified until a second appears — there is nothing to
 * distinguish it from, and a bare "(the first one)" on a lone workstream reads
 * as if a second is coming. Once assigned, a place is KEPT for the rest of that
 * workstream's life, including after the other one finishes: a name that
 * changed under the reader mid-run would be worse than a name that is slightly
 * more specific than it needs to be.
 *
 * ── Why this holds state, and what bounds it ────────────────────────────────
 *
 * Only the opening event carries the task; every later one carries the id
 * alone. Something has to remember the mapping, and it is small and lives for
 * the length of a workstream.
 *
 * It is bounded and reaped rather than left to grow: an entry is dropped the
 * moment its workstream reaches a terminal state, and the map is capped so a
 * process that somehow never sees a terminal event cannot grow one unbounded.
 * A workstream whose label was evicted or never seen reads as "the workstream",
 * which is honest — it does not invent an identifier to fill the gap.
 */

import type { WrfcState } from '../../events/workflows.js';

/** Longest label a line will carry. A phrase, not a paragraph. */
const MAX_LABEL_CHARS = 48;

/**
 * Ceiling on remembered workstreams.
 *
 * Generous next to the handful a machine runs at once, and small enough that a
 * process which never sees a terminal event still cannot accumulate. Oldest
 * out first: a workstream that has been running longest is also the one most
 * likely to have already announced itself.
 */
const MAX_REMEMBERED = 64;

interface RememberedWorkstream {
  /** The task phrase this workstream is known by. */
  readonly base: string;
  /**
   * Its place among live workstreams sharing that phrase, or null while it is
   * the only one. Sticky once set — see the header.
   */
  place: number | null;
  /**
   * Set when the workstream reached a terminal state.
   *
   * A finished workstream is NOT dropped on the spot. Several subscribers each
   * build a line from the same terminal event — the channel renderer, the
   * conversation follow-up, the webhook notifier — and whichever ran after a
   * drop would render "the workstream" while the others named it. That is a
   * race decided by subscription order, which is not a thing a reader should be
   * able to see. So a finished entry stays readable and is simply first in line
   * to be evicted when the map is full.
   */
  finished: boolean;
}

const labels = new Map<string, RememberedWorkstream>();

/** Reduce a task to the phrase a person would use for it. */
function toLabel(task: string): string {
  // First sentence or clause only — a task description can be a paragraph, and
  // a label is a handle, not a summary.
  const firstClause = task.split(/[.\n;]/)[0] ?? task;
  const collapsed = firstClause.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  return collapsed.length > MAX_LABEL_CHARS
    ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
    : collapsed;
}

const PLACE_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth',
  'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
] as const;

/**
 * A place in words. Past the words there are digits with an ordinal suffix,
 * which is still something a person reads rather than an identifier they
 * cannot use — eleven concurrent workstreams sharing one phrase is already
 * past the point where prose helps.
 */
function placeWord(place: number): string {
  const word = PLACE_WORDS[place - 1];
  if (word !== undefined) return word;
  const lastTwo = place % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${place}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[place % 10] ?? 'th';
  return `${place}${suffix}`;
}

/** ` (the second one)`, or nothing while this workstream stands alone. */
function placeSuffix(entry: RememberedWorkstream | undefined): string {
  return entry?.place == null ? '' : ` (the ${placeWord(entry.place)} one)`;
}

/**
 * Give every live workstream sharing `base` a place, newest included.
 *
 * Called only when a second LIVE one shows up, so a lone workstream never
 * carries a place it does not need. Entries are numbered in the order they were
 * remembered, which is the order the reader saw them start.
 *
 * A finished workstream still counts for the NUMBERING even though it is never
 * assigned a new place: a number the reader has already seen attached to one
 * piece of work should not turn up on a different one.
 */
function assignPlaces(base: string): void {
  let next = 1;
  for (const entry of labels.values()) {
    if (entry.base !== base) continue;
    if (entry.place === null && !entry.finished) entry.place = next;
    if (entry.place !== null) next = Math.max(next, entry.place + 1);
  }
}

/**
 * Bring the map back under its ceiling: finished workstreams first, oldest
 * first within each group. A live workstream is only evicted when nothing
 * finished is left to drop, which is the case worth keeping legible.
 */
function evictToBound(): void {
  if (labels.size <= MAX_REMEMBERED) return;
  for (const [chainId, entry] of labels) {
    if (labels.size <= MAX_REMEMBERED) return;
    if (entry.finished) labels.delete(chainId);
  }
  for (const chainId of [...labels.keys()]) {
    if (labels.size <= MAX_REMEMBERED) return;
    labels.delete(chainId);
  }
}

/** Remember what a workstream is doing, so later lines can say so. */
export function rememberWorkstreamLabel(chainId: string, task: string): void {
  const base = toLabel(task);
  if (base.length === 0) return;
  // Re-announcing moves it to the newest position rather than duplicating it,
  // and drops any place it held — the collision pass below re-derives it.
  labels.delete(chainId);
  // Only a LIVE namesake forces a place. A workstream that already finished is
  // not something the reader has to tell this one apart from, and numbering
  // against it would qualify a workstream that stands alone.
  const collides = [...labels.values()].some((entry) => entry.base === base && !entry.finished);
  labels.set(chainId, { base, place: null, finished: false });
  if (collides) assignPlaces(base);
  evictToBound();
}

/**
 * Mark a workstream finished. Called on every terminal event.
 *
 * Deliberately not a delete — see `RememberedWorkstream.finished`. Survivors
 * keep the place they were given; a name that changes under the reader is worse
 * than one that stays specific.
 */
export function finishWorkstreamLabel(chainId: string): void {
  const entry = labels.get(chainId);
  if (entry !== undefined) entry.finished = true;
}

/**
 * How to refer to this workstream in a line a person reads.
 *
 * Quoted when known, so the task words read as a name rather than as part of
 * the sentence around them. `The workstream` when not — never the id.
 */
export function workstreamLabel(chainId: string): string {
  const entry = labels.get(chainId);
  if (entry === undefined) return 'The workstream';
  return `"${entry.base}"${placeSuffix(entry)}`;
}

/** Same, lowercased for mid-sentence use. */
export function workstreamLabelInline(chainId: string): string {
  const entry = labels.get(chainId);
  if (entry === undefined) return 'the workstream';
  return `"${entry.base}"${placeSuffix(entry)}`;
}

/**
 * The place suffix alone, for the opening line — which already carries the
 * task in full and would otherwise repeat it.
 */
export function workstreamPlaceSuffix(chainId: string): string {
  return placeSuffix(labels.get(chainId));
}

/** Test seam. The map is process-lifetime state; a test needs a clean one. */
export function resetWorkstreamLabelsForTests(): void {
  labels.clear();
}

/**
 * Workstream states, in the words someone outside the machine would use.
 *
 * `awaiting_gates` is a field name. "waiting for its checks" is what is
 * happening. Keyed by the shared `WrfcState` union rather than by a local list
 * of strings, so a state added upstream is a compile error here rather than a
 * raw field name quietly reaching a channel.
 */
const STATE_WORDS: Record<WrfcState, string> = {
  pending: 'not started yet',
  engineering: 'being built',
  integrating: 'being merged together',
  reviewing: 'in review',
  fixing: 'having review findings fixed',
  awaiting_gates: 'waiting for its checks',
  gating: 'running its checks',
  passed: 'finished',
  failed: 'stopped',
  committing: 'being committed',
};

/**
 * Plain words for a workstream state.
 *
 * The parameter is the shared union, so the map above covers every case a
 * caller inside this package can pass. The runtime fallback is for an envelope
 * that arrived over transport from a peer running a newer build: underscores
 * become spaces, which reads as words rather than as a field name.
 */
export function describeWorkstreamState(state: WrfcState): string {
  return STATE_WORDS[state] ?? String(state).replace(/_/g, ' ');
}
