/**
 * Fleet emitters — typed wrappers for the FleetEvent domain.
 *
 * Used by the fleet emit-bridge (runtime/fleet/emit-bridge.ts) to surface
 * process-registry lifecycle deltas onto the runtime event bus `fleet` domain,
 * which the control-plane gateway fans out to subscribed clients unchanged.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type {
  FleetAttentionReason,
  FleetEvent,
  FleetNodeKind,
  FleetNodeState,
} from '../../../events/fleet.js';
import type { EmitterContext } from './index.js';

function fleetEvent<T extends FleetEvent['type']>(
  type: T,
  data: Omit<Extract<FleetEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<FleetEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<FleetEvent, { type: T }>, ctx);
}

export function emitFleetNodeStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { nodeId: string; kind: FleetNodeKind; label: string; state: FleetNodeState; parentId?: string | undefined; sessionId?: string | undefined },
): void {
  bus.emit('fleet', fleetEvent('FLEET_NODE_STARTED', data, ctx));
}

export function emitFleetNodeStateChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { nodeId: string; kind: FleetNodeKind; state: FleetNodeState; previousState: FleetNodeState; label: string; sessionId?: string | undefined },
): void {
  bus.emit('fleet', fleetEvent('FLEET_NODE_STATE_CHANGED', data, ctx));
}

export function emitFleetNodeFinished(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { nodeId: string; kind: FleetNodeKind; state: FleetNodeState; previousState: FleetNodeState; label: string; sessionId?: string | undefined },
): void {
  bus.emit('fleet', fleetEvent('FLEET_NODE_FINISHED', data, ctx));
}

export function emitFleetNodeBlockedOnUser(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { nodeId: string; kind: FleetNodeKind; reason: FleetAttentionReason; label: string; detail?: string | undefined; sessionId?: string | undefined; agentId?: string | undefined },
): void {
  bus.emit('fleet', fleetEvent('FLEET_NODE_BLOCKED_ON_USER', data, ctx));
}

export function emitFleetNodeUnblocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { nodeId: string; kind: FleetNodeKind; state: FleetNodeState; label: string; sessionId?: string | undefined },
): void {
  bus.emit('fleet', fleetEvent('FLEET_NODE_UNBLOCKED', data, ctx));
}
