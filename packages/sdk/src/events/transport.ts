/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * TransportEvent — discriminated union covering ACP/daemon transport lifecycle events.
 *
 * Covers transport lifecycle events for the runtime event bus.
 */

export type TransportEvent =
  /** Transport layer is being initialised. */
  | { type: 'TRANSPORT_INITIALIZING'; transportId: string; protocol: string }
  /** Transport is authenticating with the remote endpoint. */
  | { type: 'TRANSPORT_AUTHENTICATING'; transportId: string }
  /** Transport connection is established and ready. */
  | { type: 'TRANSPORT_CONNECTED'; transportId: string; endpoint: string }
  /** Transport is synchronising state with the remote. */
  | { type: 'TRANSPORT_SYNCING'; transportId: string }
  /** Transport is operating with reduced reliability or throughput. */
  | { type: 'TRANSPORT_DEGRADED'; transportId: string; reason: string }
  /** Transport is attempting to reconnect after a failure. */
  | { type: 'TRANSPORT_RECONNECTING'; transportId: string; attempt: number; maxAttempts: number }
  /** Transport connection has been closed. */
  | { type: 'TRANSPORT_DISCONNECTED'; transportId: string; reason?: string; willRetry: boolean }
  /** Transport has failed unrecoverably and will not retry. */
  | { type: 'TRANSPORT_TERMINAL_FAILURE'; transportId: string; error: string }
  /** A retry has been scheduled after a transient failure. */
  | { type: 'TRANSPORT_RETRY_SCHEDULED'; transportId: string; attempt: number; maxAttempts: number; backoffMs: number; reason: string }
  /** A scheduled retry is now being executed. */
  | { type: 'TRANSPORT_RETRY_EXECUTED'; transportId: string; attempt: number; maxAttempts: number }
  /** An SSE subscriber connected to the event stream. */
  | { type: 'STREAM_SUBSCRIBER_CONNECTED'; streamId: string; subscriberId: string; streamType: string }
  /** An SSE subscriber disconnected from the event stream. */
  | { type: 'STREAM_SUBSCRIBER_DISCONNECTED'; streamId: string; subscriberId: string; streamType: string; reason?: string }
  /**
   * The outbound WebSocket queue has saturated and messages are being dropped.
   *
   * This event is emitted when `MAX_OUTBOUND_QUEUE` entries or `MAX_OUTBOUND_QUEUE_BYTES`
   * total bytes are exceeded, or when a single message exceeds `MAX_OUTBOUND_MESSAGE_BYTES`.
   * Subscribe to this in UI layers to show a "connection lagging" indicator.
   *
   * The `onBackpressure` callback in `RuntimeEventConnectorOptions` fires at the same
   * time and provides identical information for non-event-bus consumers.
   */
  | {
      type: 'TRANSPORT_BACKPRESSURE';
      /** Transport/connector identifier (domain name for WS connectors). */
      transportId: string;
      /** Number of messages dropped since the last successful queue flush. */
      droppedCount: number;
      /** Current number of messages waiting in the outbound buffer. */
      queueLength: number;
      /** Current byte footprint of the outbound buffer. */
      queueBytes: number;
      /** Overflow reason. */
      reason: 'message_too_large' | 'queue_full';
    }
  /**
   * The realtime transport connection state has changed.
   *
   * Emitted by `createWebSocketConnector` on every state transition. Subscribe
   * to this in UI layers to drive connection-state badges (e.g. online/reconnecting
   * indicators).
   *
   * The `onConnectionStateChange` callback in `RuntimeEventConnectorOptions` fires
   * at the same time and provides the same state string for non-event-bus consumers.
   */
  | {
      type: 'TRANSPORT_CONNECTION_STATE';
      /** Transport/connector identifier (domain name for WS connectors). */
      transportId: string;
      /** New connection state. */
      state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
    }
  /**
   * A realtime transport reconnect attempt is scheduled.
   *
   * Provides richer reconnect metadata than `TRANSPORT_RECONNECTING` (which only
   * carries `attempt` and `maxAttempts`). Subscribe to this for detailed backoff
   * visualisation in diagnostic UIs.
   */
  | {
      type: 'TRANSPORT_RECONNECT_ATTEMPT';
      /** Transport/connector identifier (domain name for WS connectors). */
      transportId: string;
      /** 1-based attempt index. */
      attempt: number;
      /** Maximum attempts configured. */
      maxAttempts: number;
      /** Milliseconds the connector will wait before the next connect call. */
      delayMs: number;
      /** Human-readable reason for the reconnect. */
      reason: string;
    };

/** All transport event type literals as a union. */
export type TransportEventType = TransportEvent['type'];
