/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { ScheduleEntry } from '../../../tools/workflow/index.js';
import type { ProcessNode } from '../types.js';

/** Schedule node ids are namespaced: entries are keyed by user-chosen names. */
export function scheduleNodeId(name: string): string {
  return `schedule:${name}`;
}

/**
 * ScheduleEntry → ProcessNode. A schedule between runs is honestly 'idle'
 * (not force-fit into an active state); disabled maps to 'killed' (their only
 * controls ARE remove/disable). lastRun doubles as startedAt; nextRun/lastRun
 * stay available on `raw`. Silent source: liveness rides the tick.
 */
export function adaptSchedule(entry: ScheduleEntry): ProcessNode {
  return {
    id: scheduleNodeId(entry.name),
    kind: 'schedule',
    parentId: undefined,
    label: `${entry.name} (${entry.interval})`,
    task: entry.command,
    state: entry.enabled ? 'idle' : 'killed',
    startedAt: entry.lastRun,
    elapsedMs: 0,
    costUsd: null,
    costState: 'unpriced',
    capabilities: { interruptible: false, killable: true, pausable: entry.enabled, steerable: false },
    raw: entry,
  };
}
