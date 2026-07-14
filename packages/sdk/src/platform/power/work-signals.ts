/**
 * power/work-signals.ts — binds the runtime event bus to the PowerManager's
 * work holds, so "real work" holds the sleep inhibitor automatically:
 *
 * - a running turn (TURN_SUBMITTED → terminal turn event),
 * - an active agent/fleet node (AGENT_SPAWNING/RUNNING → terminal agent event),
 * - a queued-or-running scheduled job (AUTOMATION_RUN_QUEUED/STARTED →
 *   terminal run event) — the "schedule due soon" signal at its honest source:
 *   the scheduler queues the run when it comes due.
 *
 * Every hold is keyed by its work id, so overlapping work refcounts naturally
 * and the inhibitor releases exactly when the last piece drains.
 */
import type { PowerManager } from './manager.js';

/** Structural bus slice (RuntimeEventBus.on satisfies it). */
export interface PowerWorkSignalBus {
  on(eventType: string, callback: (envelope: { readonly event: Record<string, unknown> }) => void): () => void;
}

const HOLDS: ReadonlyArray<{ type: string; key: string; reason: (id: string) => string }> = [
  { type: 'TURN_SUBMITTED', key: 'turnId', reason: () => 'a turn is running' },
  { type: 'AGENT_SPAWNING', key: 'agentId', reason: (id) => `agent ${id} is active` },
  { type: 'AGENT_RUNNING', key: 'agentId', reason: (id) => `agent ${id} is active` },
  { type: 'AUTOMATION_RUN_QUEUED', key: 'runId', reason: (id) => `scheduled run ${id} is due` },
  { type: 'AUTOMATION_RUN_STARTED', key: 'runId', reason: (id) => `scheduled run ${id} is running` },
];

const RELEASES: ReadonlyArray<{ type: string; key: string }> = [
  { type: 'TURN_COMPLETED', key: 'turnId' },
  { type: 'TURN_ERROR', key: 'turnId' },
  { type: 'TURN_CANCEL', key: 'turnId' },
  { type: 'PREFLIGHT_FAIL', key: 'turnId' },
  { type: 'AGENT_COMPLETED', key: 'agentId' },
  { type: 'AGENT_FAILED', key: 'agentId' },
  { type: 'AGENT_CANCELLED', key: 'agentId' },
  { type: 'AUTOMATION_RUN_COMPLETED', key: 'runId' },
  { type: 'AUTOMATION_RUN_FAILED', key: 'runId' },
  { type: 'AUTOMATION_RUN_CANCELLED', key: 'runId' },
];

function workId(key: string, event: Record<string, unknown>): string | null {
  const value = event[key];
  return typeof value === 'string' && value ? `${key}:${value}` : null;
}

/** Subscribe the manager's work holds to the bus; returns an unbind. */
export function bindPowerWorkSignals(
  bus: PowerWorkSignalBus,
  manager: Pick<PowerManager, 'holdWork' | 'releaseWork'>,
): () => void {
  const unsubscribes: Array<() => void> = [];
  for (const { type, key, reason } of HOLDS) {
    unsubscribes.push(bus.on(type, (envelope) => {
      const id = workId(key, envelope.event);
      if (id) manager.holdWork(id, reason(String(envelope.event[key])));
    }));
  }
  for (const { type, key } of RELEASES) {
    unsubscribes.push(bus.on(type, (envelope) => {
      const id = workId(key, envelope.event);
      if (id) manager.releaseWork(id);
    }));
  }
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
