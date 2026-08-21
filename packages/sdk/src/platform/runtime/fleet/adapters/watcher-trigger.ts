/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { TriggerRecord } from '../../../triggers/types.js';
import type { ProcessNode, ProcessState } from '../types.js';

/**
 * Trigger-family TriggerRecord → ProcessNode.
 *
 * Distinct from adapters/trigger.ts, which adapts the workflow tool's
 * event→action TriggerDefinition. Both surface under the 'trigger' kind, a
 * consumer showing "a thing armed to fire" should not have to learn two
 * vocabularies, so the raw payload is tagged (see isWatcherTriggerRaw) and
 * every control path routes on that tag rather than on the kind alone.
 *
 * State mapping keeps the supervision story visible rather than flattening it:
 *   idle         → 'idle'      armed, waiting for its next check
 *   running      → 'running'-ish: a supervised child or stream is live, so
 *                  'executing-tool' is the honest fleet-shaped state
 *   backoff      → 'retrying'  a failed check is walking the ladder
 *   circuit-open → 'stalled'   parked after its strikes ran out; NOT 'failed',
 *                  because the definition is intact and a reset resumes it
 *   fired        → 'done'      a one-shot that delivered its payload
 *   cancelled    → 'killed'
 *   failed       → 'failed'
 */
export function adaptWatcherTrigger(record: TriggerRecord, now: number): ProcessNode {
  let state: ProcessState;
  switch (record.state) {
    case 'running':
      state = 'executing-tool';
      break;
    case 'backoff':
      state = 'retrying';
      break;
    case 'circuit-open':
      state = 'stalled';
      break;
    case 'fired':
      state = 'done';
      break;
    case 'cancelled':
      state = 'killed';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'idle':
    default:
      state = 'idle';
      break;
  }

  const alive = record.state === 'idle' || record.state === 'running' || record.state === 'backoff';
  const kind = record.definition.spec.kind;
  const startedAt = record.definition.createdAt;

  return {
    id: record.definition.id,
    kind: 'trigger',
    parentId: undefined,
    label: `${record.definition.label} (${kind})`,
    state,
    startedAt,
    elapsedMs: alive ? Math.max(0, now - startedAt) : Math.max(0, record.updatedAt - startedAt),
    costUsd: null,
    costState: 'unpriced',
    currentActivity: describeActivity(record),
    capabilities: {
      interruptible: false,
      // A parked trigger is still cancellable, that is how an operator
      // retires one they no longer want rather than leaving it parked forever.
      killable: record.state !== 'cancelled',
      pausable: false,
      resumable: record.state === 'circuit-open',
      steerable: false,
    },
    raw: { watcherTrigger: record },
  };
}

function describeActivity(record: TriggerRecord): ProcessNode['currentActivity'] {
  const at = record.updatedAt || record.definition.createdAt;
  if (record.state === 'circuit-open') {
    return { kind: 'phase', text: `breaker open after ${record.strikes} strikes: ${record.lastError ?? 'repeated failures'}`, at };
  }
  if (record.state === 'backoff') {
    return { kind: 'phase', text: `retrying after failure: ${record.lastError ?? 'check failed'}`, at };
  }
  if (record.droppedLines > 0) {
    return { kind: 'phase', text: `${record.firedCount} fired; ${record.droppedLines} line(s) dropped by the bounded queue`, at };
  }
  if (record.firedCount > 0) {
    return { kind: 'phase', text: `fired ${record.firedCount} time(s)`, at };
  }
  return { kind: 'phase', text: 'armed', at };
}

/**
 * Discriminates a trigger-family node from a workflow-trigger node. Both use
 * the 'trigger' kind, and routing a control verb to the wrong manager would
 * silently no-op, so every control path asks this rather than assuming.
 */
export function isWatcherTriggerRaw(raw: unknown): raw is { readonly watcherTrigger: TriggerRecord } {
  return typeof raw === 'object'
    && raw !== null
    && 'watcherTrigger' in raw
    && typeof (raw as { watcherTrigger?: unknown }).watcherTrigger === 'object';
}
