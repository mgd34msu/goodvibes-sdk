/**
 * connector-options.ts, the option and observability types both runtime-event
 * connectors (SSE and WebSocket) are configured with.
 *
 * Their own file so the SSE connector can be read and tested apart from the
 * WebSocket one without either importing the other's implementation.
 * `runtime-events.ts` re-exports everything here, so nothing about where a
 * caller imports these from has changed.
 */

import type { AuthTokenResolver, StreamReconnectPolicy } from '@pellux/goodvibes-transport-http';
import type { TransportObserver } from '@pellux/goodvibes-transport-core';

/**
 * Typed transport observability events emitted by the WebSocket connector.
 *
 * A structural subset of the SDK-level `TransportEvent` union, the SDK
 * (`@pellux/goodvibes-sdk`) extends this with additional server-side event
 * types. Client code that holds a reference to the full `TransportEvent` union
 * can use this type without narrowing since the shapes are structurally
 * compatible.
 */
export type ConnectorTransportEvent =
  | { type: 'TRANSPORT_CONNECTION_STATE'; transportId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' }
  | { type: 'TRANSPORT_RECONNECT_ATTEMPT'; transportId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: 'TRANSPORT_BACKPRESSURE'; transportId: string; droppedCount: number; queueLength: number; queueBytes: number; reason: 'message_too_large' | 'queue_full' };

/**
 * Connection lifecycle state.
 *
 * - `connecting`    , the initial connection attempt is in flight.
 * - `connected`     , the connection is open and delivering events.
 * - `reconnecting`  , the connection dropped and a retry is scheduled or in flight.
 * - `disconnected`  , the connection was closed deliberately by the caller.
 * - `failed`        , the maximum reconnect attempts were exhausted; the connection is permanently closed.
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

/** Metadata emitted on every reconnect attempt. */
export interface ReconnectAttemptInfo {
  /** 1-based reconnect attempt index. */
  readonly attempt: number;
  /** Maximum attempts configured; `Infinity` means unlimited. */
  readonly maxAttempts: number;
  /** Milliseconds the connector will wait before the attempt. */
  readonly delayMs: number;
  /** Human-readable reason for the reconnect (e.g. the error message or WS close code). */
  readonly reason: string;
}

/** Metadata emitted when the outbound queue saturates. */
export interface BackpressureInfo {
  /** Number of messages dropped since the last successful flush. */
  readonly droppedCount: number;
  /** Current number of messages in the outbound queue. */
  readonly queueLength: number;
  /** Current byte footprint of the outbound queue. */
  readonly queueBytes: number;
  /** The overflow reason: 'message_too_large' or 'queue_full'. */
  readonly reason: 'message_too_large' | 'queue_full';
}

/**
 * How an SSE connection decides which turn's frames it is rendering.
 *
 * - `'session-current'` (default), each session's frames belong to the turn
 *   that session was last seen to START; a terminal frame for any other turn,
 *   or for a turn this connection never saw run, is ignored. This is what stops
 *   a replayed `TURN_COMPLETED` from finishing the turn now in flight.
 * - `{ turnId }`, this connection renders exactly one turn, stated by the
 *   caller that submitted it.
 * - `'off'`, deliver every frame as it arrives, for a consumer that does its
 *   own turn bookkeeping and wants the raw feed.
 */
export type RuntimeEventTurnScope = 'session-current' | 'off' | { readonly turnId: string };

export interface RuntimeEventConnectorOptions {
  readonly reconnect?: StreamReconnectPolicy | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  /** @deprecated Use `onReconnectAttempt` for richer metadata. This callback is still fired for backward compatibility. */
  readonly onReconnect?: ((attempt: number, delayMs: number) => void) | undefined;
  /** Called on every reconnect attempt with structured metadata. */
  readonly onReconnectAttempt?: ((info: ReconnectAttemptInfo) => void) | undefined;
  /** Called when the connection state changes. Subscribe to drive connection-state UI badges. */
  readonly onConnectionStateChange?: ((state: ConnectionState) => void) | undefined;
  /**
   * Called when the outbound queue saturates or a single message is too large to queue.
   *
   * **Throttling:** callbacks are emitted on the 1st overflow and every 10th overflow
   * thereafter to avoid flooding callers during sustained disconnections. `droppedCount`
   * in {@link BackpressureInfo} is always the cumulative total, use it as the source of
   * truth for exact drop counts; do not count callback invocations.
   */
  readonly onBackpressure?: ((info: BackpressureInfo) => void) | undefined;
  /**
   * Called when a typed {@link ConnectorTransportEvent} is dispatched by the connector.
   *
   * Fires for `TRANSPORT_CONNECTION_STATE`, `TRANSPORT_RECONNECT_ATTEMPT`, and
   * `TRANSPORT_BACKPRESSURE` events in addition to the dedicated callbacks above.
   * Subscribe to this to receive a single unified stream of observability events
   * suitable for forwarding to an event bus or UI state store.
   */
  readonly onTransportEvent?: ((event: ConnectorTransportEvent) => void) | undefined;
  readonly observer?: TransportObserver | undefined;
  /**
   * Called once the WebSocket connector is set up, providing an `emitLocal`
   * function the caller can use to send messages over this connection.
   * Primarily for tests and local harnesses that need to inject outbound frames.
   */
  readonly onEmitter?: ((emitLocal: (data: string) => void) => void) | undefined;
  /** SSE only. Defaults to `'session-current'`; see {@link RuntimeEventTurnScope}. */
  readonly turnScope?: RuntimeEventTurnScope | undefined;
}

export type AuthTokenSource = string | null | undefined | AuthTokenResolver;
