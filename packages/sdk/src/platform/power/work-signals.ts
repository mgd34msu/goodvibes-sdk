/**
 * power/work-signals.ts, binds the runtime event bus to the PowerManager's
 * work holds, so "real work" holds the sleep inhibitor automatically:
 *
 * - a running turn (TURN_SUBMITTED → terminal turn event),
 * - an active agent/fleet node (AGENT_SPAWNING/RUNNING → terminal agent event),
 * - a queued-or-running scheduled job (AUTOMATION_RUN_QUEUED/STARTED →
 *   terminal run event), the "schedule due soon" signal at its honest source:
 *   the scheduler queues the run when it comes due.
 *
 * Every hold is keyed by its work id, so overlapping work refcounts naturally
 * and the inhibitor releases exactly when the last piece drains.
 */
import type { EventEnvelope } from '@pellux/goodvibes-transport-core';
import type { PowerManager } from './manager.js';

/**
 * Structural bus slice, typed against the REAL envelope shape
 * (packages/transport-core/src/event-envelope.ts: `type`/`ts`/optional
 * trace-and-id fields/`payload`, never `event`). RuntimeEventBus.on is
 * generic (`on<T extends AnyRuntimeEvent>(eventType: T['type'], callback:
 * EnvelopeListener<T>)`), so it structurally satisfies this non-generic
 * signature without a cast at the call site.
 */
export interface PowerWorkSignalBus {
  on(eventType: string, callback: (envelope: EventEnvelope<string, Record<string, unknown>>) => void): () => void;
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

/**
 * Read a work id off an envelope for the given key ('turnId' | 'agentId' |
 * 'runId'). The PAYLOAD is the primary source: every event type listed above
 * declares its id directly on the payload (verified against events/turn.ts,
 * events/agents.ts, events/automation.ts), so it is always present there.
 * The envelope's own top-level turnId/agentId optionals are checked only as a
 * fallback, callers do not consistently populate them (e.g. TURN_SUBMITTED's
 * emitter context never sets a top-level turnId), and the envelope has no
 * top-level `runId` field at all, so that fallback never fires for 'runId'.
 */
function extractId(key: string, envelope: EventEnvelope<string, Record<string, unknown>>): string | null {
  const fromPayload = envelope.payload[key];
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
  const fromEnvelope = key === 'turnId' ? envelope.turnId : key === 'agentId' ? envelope.agentId : undefined;
  return typeof fromEnvelope === 'string' && fromEnvelope ? fromEnvelope : null;
}

/** Subscribe the manager's work holds to the bus; returns an unbind. */
export function bindPowerWorkSignals(
  bus: PowerWorkSignalBus,
  manager: Pick<PowerManager, 'holdWork' | 'releaseWork'>,
): () => void {
  const unsubscribes: Array<() => void> = [];
  for (const { type, key, reason } of HOLDS) {
    unsubscribes.push(bus.on(type, (envelope) => {
      const id = extractId(key, envelope);
      if (id) manager.holdWork(`${key}:${id}`, reason(id));
    }));
  }
  for (const { type, key } of RELEASES) {
    unsubscribes.push(bus.on(type, (envelope) => {
      const id = extractId(key, envelope);
      if (id) manager.releaseWork(`${key}:${id}`);
    }));
  }
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
