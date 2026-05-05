/**
 * Transport emitters — typed emission wrappers for TransportEvent domain.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';
import { transportRetriesTotal } from '../metrics.js';

/** Emit TRANSPORT_INITIALIZING when the transport layer starts. */
export function emitTransportInitializing(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; protocol: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_INITIALIZING', { type: 'TRANSPORT_INITIALIZING', ...data }, ctx));
}

/** Emit TRANSPORT_AUTHENTICATING when transport auth is in progress. */
export function emitTransportAuthenticating(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_AUTHENTICATING', { type: 'TRANSPORT_AUTHENTICATING', ...data }, ctx));
}

/** Emit TRANSPORT_CONNECTED when the connection is ready. */
export function emitTransportConnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; endpoint: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_CONNECTED', { type: 'TRANSPORT_CONNECTED', ...data }, ctx));
}

/** Emit TRANSPORT_SYNCING during state synchronisation. */
export function emitTransportSyncing(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_SYNCING', { type: 'TRANSPORT_SYNCING', ...data }, ctx));
}

/** Emit TRANSPORT_DEGRADED during reduced-reliability operation. */
export function emitTransportDegraded(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; reason: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_DEGRADED', { type: 'TRANSPORT_DEGRADED', ...data }, ctx));
}

/** Emit TRANSPORT_RECONNECTING when retrying after failure. */
export function emitTransportReconnecting(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; attempt: number; maxAttempts: number }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_RECONNECTING', { type: 'TRANSPORT_RECONNECTING', ...data }, ctx));
}

/** Emit TRANSPORT_DISCONNECTED when the connection closes. */
export function emitTransportDisconnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; reason?: string; willRetry: boolean }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_DISCONNECTED', { type: 'TRANSPORT_DISCONNECTED', ...data }, ctx));
}

/** Emit TRANSPORT_TERMINAL_FAILURE on unrecoverable failure. */
export function emitTransportTerminalFailure(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; error: string }
): void {
  bus.emit('transport', createEventEnvelope('TRANSPORT_TERMINAL_FAILURE', { type: 'TRANSPORT_TERMINAL_FAILURE', ...data }, ctx));
}

/** Emit TRANSPORT_RETRY_SCHEDULED when a retry is queued with backoff. */
export function emitTransportRetryScheduled(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; attempt: number; maxAttempts: number; backoffMs: number; reason: string }
): void {
  transportRetriesTotal.add(1, { transport_type: data.transportId, reason: data.reason });
  bus.emit('transport', createEventEnvelope('TRANSPORT_RETRY_SCHEDULED', { type: 'TRANSPORT_RETRY_SCHEDULED', ...data }, ctx));
}

/** Emit TRANSPORT_RETRY_EXECUTED when a retry attempt is fired. */
export function emitTransportRetryExecuted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { transportId: string; attempt: number; maxAttempts: number }
): void {
  transportRetriesTotal.add(1, { transport_type: data.transportId });
  bus.emit('transport', createEventEnvelope('TRANSPORT_RETRY_EXECUTED', { type: 'TRANSPORT_RETRY_EXECUTED', ...data }, ctx));
}

/** Emit STREAM_SUBSCRIBER_CONNECTED when an SSE subscriber connects. */
export function emitStreamSubscriberConnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { streamId: string; subscriberId: string; streamType: string }
): void {
  bus.emit('transport', createEventEnvelope('STREAM_SUBSCRIBER_CONNECTED', { type: 'STREAM_SUBSCRIBER_CONNECTED', ...data }, ctx));
}

/** Emit STREAM_SUBSCRIBER_DISCONNECTED when an SSE subscriber disconnects. */
export function emitStreamSubscriberDisconnected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { streamId: string; subscriberId: string; streamType: string; reason?: string }
): void {
  bus.emit('transport', createEventEnvelope('STREAM_SUBSCRIBER_DISCONNECTED', { type: 'STREAM_SUBSCRIBER_DISCONNECTED', ...data }, ctx));
}
