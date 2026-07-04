/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Scheduler (Wave 4, wo701) — pure capacity-matching helpers, no side
 * effects. The hard departure from WrfcController's pairwise
 * engineer<->reviewer binding (startReview:883/startFix:1042): each tick,
 * for every phase in ordinal order, free capacity slots (capacity minus
 * in-flight) are filled from whichever waiting items are queued for that
 * phase — an item advances the instant ITS gate passes, claimed by
 * whatever slot happens to be free, never bound to a specific sibling item.
 */
import type { Phase, WorkItem, Workstream } from './types.js';

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
    for (const item of waiting) {
      if (free <= 0) break;
      claims.push({ item, phase });
      free -= 1;
    }
  }
  return claims;
}
