/**
 * scheduler-capacity.ts
 *
 * Standalone capacity-reporting logic for the AutomationManager.
 * Extracted so the report can be computed and tested independently
 * of the full manager class (QA-05).
 *
 * Wire format uses camelCase at the API boundary per SDK convention.
 */

import type { AutomationRun } from './runs.js';

/**
 * Scheduler capacity report returned at the API boundary.
 * All field names are camelCase per SDK wire convention.
 */
export interface SchedulerCapacityReport {
  readonly slotsTotal: number;
  readonly slotsInUse: number;
  readonly queueDepth: number;
  readonly oldestQueuedAgeMs: number | null;
}

/**
 * Compute a scheduler capacity report from raw scheduler state.
 *
 * @param slotsTotal - Maximum concurrent run slots (from config)
 * @param runs - Current run map values
 * @param nowMs - Current timestamp in ms (injectable for testability; defaults to Date.now())
 */
export function computeSchedulerCapacity(
  slotsTotal: number,
  runs: Iterable<AutomationRun>,
  nowMs = Date.now(),
): SchedulerCapacityReport {
  let slotsInUse = 0;
  const queuedRuns: AutomationRun[] = [];

  for (const run of runs) {
    if (run.status === 'running') slotsInUse += 1;
    if (run.status === 'queued') queuedRuns.push(run);
  }

  const queueDepth = queuedRuns.length;
  const oldestQueuedAgeMs = queueDepth > 0
    ? nowMs - Math.min(...queuedRuns.map((r) => r.queuedAt))
    : null;

  return { slotsTotal, slotsInUse, queueDepth, oldestQueuedAgeMs };
}
