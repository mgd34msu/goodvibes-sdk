/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Fleet emit-bridge — turns the ProcessRegistry's in-process coalesced snapshot
 * tick into poll-free lifecycle events on the runtime event bus `fleet` domain.
 *
 * The registry's `subscribe()` hands out whole snapshots on material change; it
 * is deliberately NOT a wire-event contract. This bridge is the one place that
 * derives per-node lifecycle deltas (started / state-changed / finished /
 * blocked-on-user / unblocked) from consecutive snapshots and emits them via the
 * typed fleet emitters. The control-plane gateway already fans every runtime-bus
 * domain out to subscribed SSE/WebSocket clients, so no gateway/channel change is
 * needed once the `fleet` domain exists.
 *
 * Honesty invariants:
 * - The FIRST snapshot only SEEDS the prior-state table; it emits nothing, so a
 *   bridge that attaches to an already-populated fleet does not fabricate a burst
 *   of STARTED events for nodes that did not just start.
 * - A node that simply disappears from the snapshot (archived / gc'd) emits no
 *   FINISHED — finish is claimed only on an observed transition INTO a terminal
 *   state, never inferred from absence.
 * - Every emitted field is copied straight from the authoritative snapshot; the
 *   bridge owns no state beyond the small prior-state diff table.
 */

import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from '../emitters/index.js';
import {
  emitFleetNodeBlockedOnUser,
  emitFleetNodeFinished,
  emitFleetNodeStarted,
  emitFleetNodeStateChanged,
  emitFleetNodeUnblocked,
} from '../emitters/fleet.js';
import type { FleetSnapshot, ProcessNode, ProcessState } from './types.js';
import type { ProcessRegistry } from './types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set<ProcessState>([
  'done',
  'failed',
  'killed',
  'interrupted',
]);

function isTerminal(state: ProcessState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The minimal per-node prior state the diff needs. */
interface PriorNodeState {
  readonly state: ProcessState;
  readonly attentionReason: 'approval' | 'input' | undefined;
}

export interface FleetEmitBridgeDeps {
  /** The live registry — only its snapshot subscription is used. */
  readonly registry: Pick<ProcessRegistry, 'subscribe'>;
  /** The runtime event bus the fleet events are emitted onto. */
  readonly bus: RuntimeEventBus;
  /**
   * Trace id source for the emitted envelopes. Fleet lifecycle deltas are not
   * born of a single caller turn, so absent a real trace a fresh id per event
   * is honest (default). Injected in tests for determinism.
   */
  readonly traceId?: (() => string) | undefined;
}

/**
 * Attach the bridge. Returns an unsubscribe function that detaches the registry
 * subscription. Safe to call once at composition time; the subscription lives
 * for the registry's lifetime (there is no daemon-wide shutdown seam — mirrors
 * the fleet/push verb registrations).
 */
export function attachFleetEmitBridge(deps: FleetEmitBridgeDeps): () => void {
  const nextTraceId = deps.traceId ?? ((): string => randomUUID());
  const prior = new Map<string, PriorNodeState>();
  let seeded = false;

  // Envelope sessionId is required; a node without a bound session uses a clear
  // non-session sentinel (mirrors the bus's own 'runtime-bus' synthetic). The
  // PAYLOAD carries a sessionId only when the node actually has one, so a
  // subscriber never mistakes the sentinel for a real session.
  const ctxFor = (node: ProcessNode): EmitterContext => ({
    traceId: nextTraceId(),
    source: 'fleet-registry',
    sessionId: node.sessionRef?.sessionId ?? 'fleet-registry',
  });

  const onSnapshot = (snapshot: FleetSnapshot): void => {
    try {
      const seenIds = new Set<string>();
      for (const node of snapshot.nodes) {
        seenIds.add(node.id);
        const attentionReason = node.needsAttention?.reason;
        const prev = prior.get(node.id);

        if (seeded && !prev) {
          // Newly observed node.
          emitFleetNodeStarted(deps.bus, ctxFor(node), {
            nodeId: node.id,
            kind: node.kind,
            label: node.label,
            state: node.state,
            ...(node.parentId ? { parentId: node.parentId } : {}),
            ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
          });
          if (attentionReason) {
            emitFleetNodeBlockedOnUser(deps.bus, ctxFor(node), {
              nodeId: node.id,
              kind: node.kind,
              reason: attentionReason,
              label: node.label,
              ...(node.needsAttention?.detail ? { detail: node.needsAttention.detail } : {}),
              ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
              ...(node.sessionRef?.agentId ? { agentId: node.sessionRef.agentId } : {}),
            });
          }
        } else if (seeded && prev) {
          const attentionAppeared = attentionReason !== undefined && prev.attentionReason === undefined;
          const attentionCleared = attentionReason === undefined && prev.attentionReason !== undefined;
          if (attentionAppeared) {
            emitFleetNodeBlockedOnUser(deps.bus, ctxFor(node), {
              nodeId: node.id,
              kind: node.kind,
              reason: attentionReason,
              label: node.label,
              ...(node.needsAttention?.detail ? { detail: node.needsAttention.detail } : {}),
              ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
              ...(node.sessionRef?.agentId ? { agentId: node.sessionRef.agentId } : {}),
            });
          }
          if (attentionCleared) {
            emitFleetNodeUnblocked(deps.bus, ctxFor(node), {
              nodeId: node.id,
              kind: node.kind,
              state: node.state,
              label: node.label,
              ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
            });
          }
          if (node.state !== prev.state) {
            if (isTerminal(node.state) && !isTerminal(prev.state)) {
              emitFleetNodeFinished(deps.bus, ctxFor(node), {
                nodeId: node.id,
                kind: node.kind,
                state: node.state,
                previousState: prev.state,
                label: node.label,
                ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
              });
            } else if (!attentionAppeared) {
              // A transition INTO the block is already reported by BLOCKED_ON_USER;
              // suppress the redundant STATE_CHANGED for that one case.
              emitFleetNodeStateChanged(deps.bus, ctxFor(node), {
                nodeId: node.id,
                kind: node.kind,
                state: node.state,
                previousState: prev.state,
                label: node.label,
                ...(node.sessionRef?.sessionId ? { sessionId: node.sessionRef.sessionId } : {}),
              });
            }
          }
        }

        prior.set(node.id, { state: node.state, attentionReason });
      }

      // Drop prior entries for nodes that left the snapshot (archived / gc'd).
      // No FINISHED is claimed from absence — see the module honesty invariants.
      for (const id of [...prior.keys()]) {
        if (!seenIds.has(id)) prior.delete(id);
      }
      seeded = true;
    } catch (error) {
      logger.warn('[fleet] emit-bridge snapshot handling failed', { error: summarizeError(error) });
    }
  };

  return deps.registry.subscribe(onSnapshot);
}
