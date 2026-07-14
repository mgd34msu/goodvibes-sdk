/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Scheduler (see CHANGELOG 0.38.0) — pure capacity-matching helpers, no side
 * effects. The hard departure from WrfcController's pairwise
 * engineer<->reviewer binding (startReview:883/startFix:1042): each tick,
 * for every phase in ordinal order, free capacity slots (capacity minus
 * in-flight) are filled from whichever waiting items are queued for that
 * phase — an item advances the instant ITS gate passes, claimed by
 * whatever slot happens to be free, never bound to a specific sibling item.
 */
import type { Phase, WorkItem, Workstream } from './types.js';
import { remainingDepths } from './graph-dynamics.js';

/** True when `dep` RELEASES its dependents under the workstream's release policy. */
export function dependencySatisfied(workstream: Workstream, dep: WorkItem): boolean {
  if (dep.state !== 'passed') return false;
  if (workstream.releasePolicy !== 'reviewed-and-merged') return true;
  // Reviewed-and-merged: passed means every phase (incl. the adversarial slice
  // review) passed; the merge must ALSO have landed. Claimed-done — an agent
  // report, an in-flight phase, or passed-but-unmerged — releases nothing.
  if (workstream.isolation !== 'worktree') return true;
  return dep.mergeState === 'merged';
}

export function sortedPhases(workstream: Workstream): Phase[] {
  return [...workstream.phases].sort((a, b) => a.ordinal - b.ordinal);
}

export function firstPhase(workstream: Workstream): Phase | undefined {
  return sortedPhases(workstream)[0];
}

/**
 * The next phase in ORDINARY forward progression. Deliberately skips
 * 'fix'-kind phases: a dynamically-inserted fix phase sits at an ordinal
 * after its review (see engine.ts findOrInsertFixPhase) but is reachable
 * ONLY via the explicit review-failure re-route, never as "what comes next"
 * for an item whose review already passed — otherwise a later item that
 * never needed fixing would wrongly detour through it.
 */
export function nextPhaseAfter(workstream: Workstream, ordinal: number): Phase | undefined {
  return sortedPhases(workstream).find((p) => p.ordinal > ordinal && p.kind !== 'fix');
}

export function phaseById(workstream: Workstream, phaseId: string): Phase | undefined {
  return workstream.phases.find((p) => p.id === phaseId);
}

/** The nearest preceding review-kind phase — the return target after a dynamically-inserted fix phase's gate passes. Purely structural (survives serialization with zero extra bookkeeping). */
export function reviewPhaseBefore(workstream: Workstream, phase: Phase): Phase | undefined {
  return sortedPhases(workstream).filter((p) => p.ordinal < phase.ordinal && p.kind === 'review').pop();
}

export interface PhaseClaim {
  readonly item: WorkItem;
  readonly phase: Phase;
}

/**
 * Whether an item's inter-item dependencies (BIG-3 item 2) are all satisfied,
 * and — when not — WHY, split into dependencies still in flight vs. ones that
 * have terminally failed. Pure (no side effects): the engine's per-tick
 * dependency pre-pass (applyDependencyGates, engine.ts) calls this and applies
 * the state/blockedReason transition. Missing dependency ids (no item in the
 * workstream matches) are ignored here — assembly (fromPlanProposal) already
 * asserts referential integrity, so a dangling id at runtime is treated as
 * "not blocking" rather than an eternal block.
 */
export interface DependencyStatus {
  /** True when every dependency has reached 'passed' (or there are none). */
  readonly ready: boolean;
  /** Titles of dependencies still pending/in flight (neither passed nor failed). */
  readonly waiting: string[];
  /** Titles of dependencies that have terminally FAILED — a recoverable block, not a terminal one for the dependent. */
  readonly failed: string[];
}

export function dependencyStatus(workstream: Workstream, item: WorkItem): DependencyStatus {
  const waiting: string[] = [];
  const failed: string[] = [];
  for (const depId of item.dependsOn) {
    const dep = workstream.items.find((i) => i.id === depId);
    if (!dep) {
      // No item with this id. It may be a NON-LEAF best-of-N source id that was
      // expanded into sibling attempts (attempts.ts) — resolve it to the group.
      // Otherwise it is a truly dangling id (assembly guarantees this can't
      // happen); ignore rather than block forever.
      const groupStatus = attemptGroupDependencyStatus(workstream, depId);
      if (groupStatus === 'satisfied') continue;
      if (groupStatus === 'waiting') { waiting.push(bestOfNWaitingLabel(workstream, depId)); continue; }
      if (groupStatus === 'failed') { failed.push(bestOfNWaitingLabel(workstream, depId)); continue; }
      continue; // 'not-a-group' → truly dangling, ignore
    }
    if (dependencySatisfied(workstream, dep)) continue;
    if (dep.state === 'failed') { failed.push(dep.title); continue; }
    if (dep.state === 'passed') { waiting.push(`${dep.title} (merge pending)`); continue; }
    waiting.push(dep.title);
  }
  return { ready: waiting.length === 0 && failed.length === 0, waiting, failed };
}

/**
 * Resolve a dependency on a best-of-N SOURCE id (an id that was expanded into
 * sibling attempts, so no live item carries it) against the group's outcome:
 *   - 'satisfied' — the winner was picked and its branch merged onto base (the
 *     losers are cleaned), so a dependent may build on the selected result.
 *   - 'waiting'   — attempts are still running or held for a pick, or the winner
 *     is picked but its merge has not landed yet.
 *   - 'failed'    — every attempt failed, so no winner can be picked (a
 *     recoverable block for the dependent, mirroring a failed ordinary dep).
 *   - 'not-a-group' — no sibling references this id; it is not a best-of-N group.
 */
function attemptGroupDependencyStatus(
  workstream: Workstream,
  sourceId: string,
): 'satisfied' | 'waiting' | 'failed' | 'not-a-group' {
  const siblings = workstream.items.filter((i) => i.attemptSourceId === sourceId);
  if (siblings.length === 0) return 'not-a-group';
  const winner = siblings.find((s) => s.attemptWinner === true);
  if (winner) return winner.mergeState === 'merged' ? 'satisfied' : 'waiting';
  // No winner picked yet. Still waiting unless every attempt has terminally
  // failed (nothing left to pick).
  const anyNonFailed = siblings.some((s) => s.state !== 'failed');
  return anyNonFailed ? 'waiting' : 'failed';
}

/** A readable label for a best-of-N group in a dependency-wait/failed report. */
function bestOfNWaitingLabel(workstream: Workstream, sourceId: string): string {
  const sibling = workstream.items.find((i) => i.attemptSourceId === sourceId);
  const base = sibling ? sibling.title.replace(/\s*\(attempt \d+\/\d+\)\s*$/, '') : sourceId;
  return `${base} (best-of-N winner)`;
}

/**
 * Which (item, phase) pairs have free capacity to claim RIGHT NOW. Pure —
 * no side effects, no budget check (the caller applies budget.checkBudget
 * before actually claiming, since budget is a *decision*, not a capacity
 * fact this function should own).
 *
 * 'blocked-budget' items are deliberately included in the waiting set, not
 * just 'pending'/'awaiting-capacity': a budget block is a recoverable
 * decision (see BudgetCeiling/WorkItemState docs, types.ts), never a
 * capacity fact, so a previously-blocked item must be reconsidered on every
 * tick the instant a slot is free — the caller's budget.checkBudget call
 * re-decides it fresh each time, honestly re-blocking it if the ceiling
 * still refuses.
 */
export function computeClaims(workstream: Workstream): PhaseClaim[] {
  const claims: PhaseClaim[] = [];
  for (const phase of sortedPhases(workstream)) {
    const inFlight = workstream.items.filter((item) => item.currentPhaseId === phase.id && item.state === 'in-phase').length;
    let free = phase.capacity - inFlight;
    if (free <= 0) continue;
    const waiting = workstream.items.filter(
      (item) => item.currentPhaseId === phase.id
        && (item.state === 'pending' || item.state === 'awaiting-capacity' || item.state === 'blocked-budget'),
    );
    // Deepest-remaining-path first within the ready set, so the critical path
    // never idles; cluster is the tiebreak (adjacent same-cluster tasks run
    // consecutively — the bounded warm-adjacency the planner's clusters buy).
    const depths = remainingDepths(workstream);
    waiting.sort((a, b) =>
      (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0)
      || (a.cluster ?? '').localeCompare(b.cluster ?? '')
      || a.createdAt - b.createdAt);
    for (const item of waiting) {
      if (free <= 0) break;
      claims.push({ item, phase });
      free -= 1;
    }
  }
  return claims;
}
