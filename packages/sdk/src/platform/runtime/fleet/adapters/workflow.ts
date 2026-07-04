/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { WorkflowInstance } from '../../../tools/workflow/index.js';
import type { ProcessNode, ProcessState } from '../types.js';

/**
 * WorkflowInstance → ProcessNode. Workflow FSMs are a SILENT source (no bus
 * emission); their liveness rides the registry's coalesced tick, and the
 * manager self-evicts completed entries (1 h TTL / 50 cap) so terminal nodes
 * eventually disappear from the snapshot.
 */
export function adaptWorkflow(instance: WorkflowInstance, now: number): ProcessNode {
  let state: ProcessState;
  if (instance.cancelled) state = 'killed';
  else if (instance.completedAt !== undefined) state = 'done';
  else state = 'executing-tool';
  const active = state === 'executing-tool';
  return {
    id: instance.id,
    kind: 'workflow',
    parentId: undefined,
    label: instance.definition,
    task: instance.task,
    state,
    startedAt: instance.startedAt,
    completedAt: instance.completedAt,
    elapsedMs: Math.max(0, (instance.completedAt ?? now) - instance.startedAt),
    costUsd: null,
    costState: 'unpriced',
    // Silent source: anchored to startedAt (no state-transition timestamp).
    currentActivity: active ? { kind: 'phase', text: instance.currentState, at: instance.startedAt } : undefined,
    capabilities: { interruptible: false, killable: active, pausable: false, resumable: false, steerable: false },
    raw: instance,
  };
}
