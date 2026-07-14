/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * elastic-pool.ts — the elastic-fleet muscles of the ONE workstream engine
 * : a ready task with no available agent SPAWNS one (the phase-runner's
 * fresh per-task agent), up to `fleet.maxSize`; at-cap is a VISIBLE state
 * ("N ready, M running, at cap"), never a silent stall; a spawn refusal
 * leaves the task visibly ready with its reason; and when the ready set is
 * empty with no imminent edge release, the finishing agent RETIRES instead of
 * idling warm — fleet size tracks the graph's width over time.
 *
 * Also owns the bounded per-task retry decision (auto-retry a failed task up
 * to the bound, then hard-fail → the orphan pass surfaces dependents).
 */
import type { OrchestrationEvent, WorkItem, Workstream } from './types.js';
import type { PoolStateSnapshot } from './graph-dynamics.js';

/** Live probe of the ONE fleet ceiling (fleet.maxSize), injected by the composition root. */
export interface FleetCapacityProbe {
  /** Agents the daemon is responsible for right now (native + ACP-hosted + elastic fixers). */
  readonly active: number;
  readonly maxSize: number;
  readonly capKey: string;
  /** A policy refusal independent of the ceiling (host resources, spawn policy), when any. */
  readonly refusal?: string | undefined;
}

export type FleetCapacityFn = () => FleetCapacityProbe;

/** Whether this workstream runs under the elastic pool (the review-sourced fix graphs do). */
export function isElastic(workstream: Workstream): boolean {
  return workstream.releasePolicy === 'reviewed-and-merged';
}

export function readyCount(workstream: Workstream): number {
  return workstream.items.filter(
    (item) => item.state === 'pending' || item.state === 'awaiting-capacity',
  ).length;
}

export function runningCount(workstream: Workstream): number {
  return workstream.items.filter((item) => item.state === 'in-phase').length;
}

export interface PoolGateDecision {
  readonly allow: boolean;
  /** The visible reason stamped on the still-ready item when refused. */
  readonly reason?: string | undefined;
  readonly event?: OrchestrationEvent | undefined;
}

/**
 * Gate ONE claim against the fleet ceiling. Allowing the claim IS the spawn —
 * the phase-runner spawns a fresh per-task agent for it. Refusals leave the
 * item in its ready state with the honest reason; the at-cap event fires once
 * per transition (the caller tracks the edge).
 */
export function gateClaimAgainstFleet(
  workstream: Workstream,
  item: WorkItem,
  probe: FleetCapacityProbe,
  wasAtCap: boolean,
): PoolGateDecision {
  if (probe.refusal) {
    return {
      allow: false,
      reason: `spawn refused: ${probe.refusal} (task stays ready)`,
      event: { type: 'pool-spawn-refused', workstreamId: workstream.id, itemId: item.id, reason: probe.refusal },
    };
  }
  if (probe.active >= probe.maxSize) {
    const ready = readyCount(workstream);
    const running = runningCount(workstream);
    return {
      allow: false,
      reason: `${ready} ready, ${running} running, at cap (${probe.capKey}=${probe.maxSize})`,
      event: wasAtCap
        ? undefined
        : { type: 'pool-at-cap', workstreamId: workstream.id, ready, running, capKey: probe.capKey, maxSize: probe.maxSize },
    };
  }
  return { allow: true };
}

/** The pool state a graph snapshot serves. */
export function poolState(workstream: Workstream, probe: FleetCapacityProbe | null): PoolStateSnapshot | null {
  if (!isElastic(workstream) || !probe) return null;
  return {
    ready: readyCount(workstream),
    running: runningCount(workstream),
    atCap: probe.active >= probe.maxSize,
    capKey: probe.capKey,
    maxSize: probe.maxSize,
    refusal: probe.refusal,
  };
}

/**
 * Bounded auto-retry decision for a failed item. True = consume one retry
 * (the caller resets the item and re-ticks); false = hard-fail (the orphan
 * pass then surfaces dependents). Cancellations never retry.
 */
export function shouldAutoRetry(item: WorkItem, reason: string, maxItemRetries: number): boolean {
  if (maxItemRetries <= 0) return false;
  if (reason.startsWith('cancelled')) return false;
  return (item.retryCount ?? 0) < maxItemRetries;
}

/** True when a FAILED item is past its retry bound (the orphan pass's blocker predicate). */
export function isHardFailed(item: WorkItem, maxItemRetries: number): boolean {
  return item.state === 'failed' && (maxItemRetries <= 0 || (item.retryCount ?? 0) >= maxItemRetries);
}

/**
 * Retirement check, run when a phase agent finishes and its tick found no
 * claim: with an empty ready set and NO imminent edge release (nothing
 * in-phase that could release an edge), the agent retires cleanly instead of
 * idling warm. Returns the event to emit, or null.
 */
export function retirementEvent(workstream: Workstream, agentId: string | undefined): OrchestrationEvent | null {
  if (!isElastic(workstream)) return null;
  if (!agentId) return null;
  if (readyCount(workstream) > 0) return null;
  if (runningCount(workstream) > 0) return null; // an in-flight sibling may release an edge imminently
  return {
    type: 'agent-retired',
    workstreamId: workstream.id,
    agentId,
    reason: 'ready set empty; no imminent edge release',
  };
}
