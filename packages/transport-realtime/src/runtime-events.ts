import {
  RUNTIME_EVENT_DOMAINS,
  SerializedEventEnvelopeSchema,
  type RuntimeEventDomain,
  type RuntimeEventRecord,
} from '@pellux/goodvibes-contracts';
import {
  ConfigurationError,
  GoodVibesSdkError,
  isStructuredDaemonErrorBody,
} from '@pellux/goodvibes-errors';
import {
  normalizeAuthToken,
  type AuthTokenResolver,
  type StreamReconnectPolicy,
  openRawServerSentEventStream as openServerSentEventStream,
  normalizeStreamReconnectPolicy,
  getStreamReconnectDelay,
} from '@pellux/goodvibes-transport-http';
import { buildUrl, normalizeBaseUrl } from '@pellux/goodvibes-transport-http';
import {
  describeUnknownTransportError,
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
  type TransportObserver,
} from '@pellux/goodvibes-transport-core';
import {
  createRemoteDomainEvents,
  type DomainEventConnector,
  type DomainEvents,
  type RemoteDomainEventsOptions,
  type SerializedEventEnvelope,
} from './domain-events.js';

/**
 * Typed transport observability events emitted by the WebSocket connector.
 *
 * A structural subset of the SDK-level `TransportEvent` union — the SDK
 * (`@pellux/goodvibes-sdk`) extends this with additional server-side event
 * types. Client code that holds a reference to the full `TransportEvent` union
 * can use this type without narrowing since the shapes are structurally
 * compatible.
 */
export type ConnectorTransportEvent =
  | { type: 'TRANSPORT_CONNECTION_STATE'; transportId: string; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' }
  | { type: 'TRANSPORT_RECONNECT_ATTEMPT'; transportId: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: 'TRANSPORT_BACKPRESSURE'; transportId: string; droppedCount: number; queueLength: number; queueBytes: number; reason: 'message_too_large' | 'queue_full' };

export type SerializedRuntimeEnvelope<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  SerializedEventEnvelope<TEvent>;

export type RemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  DomainEvents<RuntimeEventDomain, TEvent>;

export interface RemoteRuntimeEventsOptions {
  readonly onError?: ((error: Error, domain: RuntimeEventDomain) => void) | undefined;
  readonly observer?: TransportObserver | undefined;
}

/**
 * Returns a filtered view of a {@link RemoteRuntimeEvents} object where every
 * callback only fires for events whose envelope `sessionId` equals the given
 * session identifier.
 *
 * This is a convenience wrapper around {@link forSession} scoped to the
 * canonical runtime-event domains. Use it instead of manually checking
 * `e.sessionId` in every callback.
 *
 * @example
 * const events = sdk.realtime.viaSse();
 * const session = await sdk.operator.sessions.create({ title: 'demo' });
 * const sessionId = session.session.id;
 *
 * // Before forSession — repeated manual guard:
 * events.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   if (e.sessionId !== sessionId) return;
 *   process.stdout.write(e.payload.content);
 * });
 *
 * // After forSession — clean, session-scoped subscription:
 * const sessionEvents = forSessionRuntime(events, sessionId);
 * sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   process.stdout.write(e.payload.content);
 * });
 */
export { forSession as forSessionRuntime } from './domain-events.js';

/**
 * Connection state for a realtime transport.
 *
 * - `connecting`    — the socket is being established (or re-connecting after a clean stop).
 * - `connected`     — the connection is authenticated and open; outbound messages may be sent.
 * - `reconnecting`  — the connection was lost and the connector is waiting before the next attempt.
 * - `disconnected`  — the connector was stopped cleanly (no further reconnects will occur).
 * - `failed`        — the maximum reconnect attempts were exhausted; the connection is permanently closed.
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
   * in {@link BackpressureInfo} is always the cumulative total — use it as the source of
   * truth for exact drop counts; do not count callback invocations.
   */
  readonly onBackpressure?: ((info: BackpressureInfo) => void) | undefined;
  /**
   * Called when a typed {@link TransportEvent} is dispatched by the connector.
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
}

export type AuthTokenSource = string | null | undefined | AuthTokenResolver;
type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

/** Default max reconnect attempts for WebSocket connections (finite to prevent infinite auth loops). */
export const DEFAULT_WS_MAX_ATTEMPTS = 10;

/** Maximum number of messages that may be queued in the outbound queue before the oldest entry is dropped. */
const MAX_OUTBOUND_QUEUE = 1024;
/** Maximum size for a single queued outbound WebSocket message. */
const MAX_OUTBOUND_MESSAGE_BYTES = 1024 * 1024;
/** Maximum total queued outbound WebSocket payload bytes. */
const MAX_OUTBOUND_QUEUE_BYTES = 16 * 1024 * 1024;
/** Maximum size accepted for one inbound WebSocket runtime-event frame. */
const MAX_INBOUND_FRAME_BYTES = 1024 * 1024;
const textEncoder = new TextEncoder();

function getSocketOpenState(WebSocketImpl: typeof WebSocket): number {
  return typeof WebSocketImpl.OPEN === 'number' ? WebSocketImpl.OPEN : 1;
}

function isSocketOpen(socket: WebSocket, WebSocketImpl: typeof WebSocket): boolean {
  return socket.readyState === getSocketOpenState(WebSocketImpl);
}

/**
 * Creates a {@link WebSocketTransportError} from a raw server-sent payload body,
 * unpacking a {@link StructuredDaemonErrorBody} when present — matching the
 * envelope parity that `createHttpStatusError` provides for HTTP errors.
 *
 * When the server sends a structured `{ error, code, category, recoverable, … }` body
 * inside a WS message, consumers receive the same richly-typed envelope as HTTP callers.
 * Unstructured or non-object bodies fall back to the provided `fallbackMessage`.
 *
 * @param fallbackMessage - Used when `body` is not a structured daemon error.
 * @param body - The raw body parsed from the server frame (may be any shape).
 * @param options - Optional overrides for `code`, `hint`, and `cause`.
 */
/**
 * Helper that builds a {@link WebSocketTransportError} options bag without
 * assigning `undefined` to optional keys, satisfying `exactOptionalPropertyTypes`.
 */
function buildWsErrorOpts(
  code: string,
  overrides: {
    hint?: string;
    cause?: unknown;
    category?: import('@pellux/goodvibes-errors').ErrorCategory;
    recoverable?: boolean;
    status?: number;
    requestId?: string;
    provider?: string;
    operation?: string;
    phase?: string;
  } = {},
): { readonly code: string } {
  const opts: Record<string, unknown> = { code };
  if (overrides.hint !== undefined) opts['hint'] = overrides.hint;
  if (overrides.cause !== undefined) opts['cause'] = overrides.cause;
  if (overrides.category !== undefined) opts['category'] = overrides.category;
  if (overrides.recoverable !== undefined) opts['recoverable'] = overrides.recoverable;
  if (overrides.status !== undefined) opts['status'] = overrides.status;
  if (overrides.requestId !== undefined) opts['requestId'] = overrides.requestId;
  if (overrides.provider !== undefined) opts['provider'] = overrides.provider;
  if (overrides.operation !== undefined) opts['operation'] = overrides.operation;
  if (overrides.phase !== undefined) opts['phase'] = overrides.phase;
  return opts as unknown as { readonly code: string };
}

export function createWebSocketRemoteError(
  fallbackMessage: string,
  body: unknown,
  options: { readonly code?: string; readonly hint?: string; readonly cause?: unknown } = {},
): WebSocketTransportError {
  if (isStructuredDaemonErrorBody(body)) {
    const overrides: Parameters<typeof buildWsErrorOpts>[1] = {};
    const effectiveHint = body.hint ?? options.hint;
    if (effectiveHint !== undefined) overrides.hint = effectiveHint;
    if (options.cause !== undefined) overrides.cause = options.cause;
    if (body.category !== undefined) overrides.category = body.category as import('@pellux/goodvibes-errors').ErrorCategory;
    if (body.recoverable !== undefined) overrides.recoverable = body.recoverable;
    if (body.status !== undefined) overrides.status = body.status;
    if (body.requestId !== undefined) overrides.requestId = body.requestId;
    if (body.provider !== undefined) overrides.provider = body.provider;
    if (body.operation !== undefined) overrides.operation = body.operation;
    if (body.phase !== undefined) overrides.phase = body.phase;
    // Use the caller-supplied code (or 'WS_REMOTE_ERROR') as the canonical transport code.
    // The server's body.code is not used as the WebSocketTransportError code because
    // Symbol.hasInstance enforces a canonical-code allowlist; arbitrary server codes
    // would break instanceof checks. The body message and metadata are still preserved.
    const code = options.code ?? 'WS_REMOTE_ERROR';
    return new WebSocketTransportError(body.error, buildWsErrorOpts(code, overrides));
  }
  const message = typeof body === 'string' && body.trim()
    ? body.trim()
    : fallbackMessage;
  const overrides: Parameters<typeof buildWsErrorOpts>[1] = {};
  if (options.hint !== undefined) overrides.hint = options.hint;
  if (options.cause !== undefined) overrides.cause = options.cause;
  else if (body !== null && body !== undefined) overrides.cause = body;
  return new WebSocketTransportError(message, buildWsErrorOpts(options.code ?? 'WS_REMOTE_ERROR', overrides));
}

export class WebSocketTransportError extends GoodVibesSdkError {
  /**
   * WebSocket runtime-event transport error.
   *
   * Canonical internal codes are `WS_CLOSE_ABNORMAL`,
   * `WS_EVENT_ERROR`, `WS_QUEUE_OVERFLOW`, `WS_REMOTE_ERROR`, and
   * `WS_FRAME_TOO_LARGE`.
   *
   * Overrides Symbol.hasInstance to enable cross-realm instanceof checks.
   * Without this, `instanceof WebSocketTransportError` in a different realm
   * (e.g. a Cloudflare Worker or cross-frame context) falls through to the base
   * GoodVibesSdkError brand only and cannot distinguish WS errors from other
   * SDK errors. The brand check here also guards against plain objects with a
   * matching `code`.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== WebSocketTransportError) {
      return typeof value === 'object'
        && value !== null
        && this.prototype.isPrototypeOf(value);
    }
    // Require the base SDK brand AND a WS-specific code prefix to prevent plain
    // objects like { code: 'WEBSOCKET_TRANSPORT_ERROR' } from passing.
    // Use an explicit allowlist of canonical WS codes rather than
    // the open-ended 'WS_' prefix check which would match any hand-crafted
    // GoodVibesSdkError with a WS_* code.
    const CANONICAL_WS_CODES = new Set([
      'WEBSOCKET_TRANSPORT_ERROR',
      'WS_CLOSE_ABNORMAL',
      'WS_EVENT_ERROR',
      'WS_QUEUE_OVERFLOW',
      'WS_REMOTE_ERROR',
      'WS_FRAME_TOO_LARGE',
    ]);
    return GoodVibesSdkError[Symbol.hasInstance](value)
      && typeof (value as Record<PropertyKey, unknown>).code === 'string'
      && CANONICAL_WS_CODES.has(String((value as Record<PropertyKey, unknown>).code));
  }

  // Use one of: WS_CLOSE_ABNORMAL, WS_EVENT_ERROR, WS_QUEUE_OVERFLOW, WS_REMOTE_ERROR, WS_FRAME_TOO_LARGE.
  //
  // Extended options mirror the HttpStatusError / createHttpStatusError envelope so that
  // structured daemon error bodies received over WebSocket produce the same richly-typed
  // error as their HTTP equivalents. Fields omitted default to transport-appropriate values.
  constructor(
    message: string,
    options: {
      readonly cause?: unknown;
      readonly hint?: string;
      readonly code: string;
      /** Defaults to `'network'`. Override when the server sends a structured category (e.g. `'rate_limit'`). */
      readonly category?: import('@pellux/goodvibes-errors').ErrorCategory | undefined;
      /** Defaults to `true`. Override to `false` for unrecoverable structured errors. */
      readonly recoverable?: boolean | undefined;
      readonly status?: number | undefined;
      readonly requestId?: string | undefined;
      readonly provider?: string | undefined;
      readonly operation?: string | undefined;
      readonly phase?: string | undefined;
    },
  ) {
    super(message, {
      code: options.code,
      category: options.category ?? 'network',
      source: 'transport',
      recoverable: options.recoverable ?? true,
      hint: options.hint,
      cause: options.cause,
      status: options.status,
      requestId: options.requestId,
      provider: options.provider,
      operation: options.operation,
      phase: options.phase,
    });
    this.name = 'WebSocketTransportError';
  }
}

export function createRemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  connect: DomainEventConnector<RuntimeEventDomain, TEvent>,
  options: RemoteRuntimeEventsOptions = {},
): RemoteRuntimeEvents<TEvent> {
  const domainOptions: RemoteDomainEventsOptions<RuntimeEventDomain> = {
    onConnectionError: (error, domain) => {
      invokeTransportObserver(() => options.observer?.onError?.(error), options.observer?.onObserverError);
      options.onError?.(error, domain);
    },
  };
  return createRemoteDomainEvents(
    RUNTIME_EVENT_DOMAINS,
    connect,
    domainOptions,
  );
}

export function buildEventSourceUrl(
  baseUrl: string,
  domain: RuntimeEventDomain,
): string {
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', domain);
  return url.toString();
}

export function buildWebSocketUrl(
  baseUrl: string,
  domains: readonly RuntimeEventDomain[],
): string {
  // protocol validation and error messaging here mirrors normalizeBaseUrl in
  // transport-http/src/paths.ts. These two code paths enforce the same rule with
  // different error messages. If the supported protocol set ever changes, update both.
  const url = new URL('/api/control-plane/ws', normalizeBaseUrl(baseUrl));
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConfigurationError(`Unsupported WebSocket base URL protocol: ${url.protocol}`, {
      source: 'transport',
      hint: 'Runtime event WebSocket clients require http, https, ws, or wss base URLs.',
    });
  }
  assertWebSocketAuthTransportIsSafe(url);
  url.searchParams.set('clientKind', 'web');
  if (domains.length > 0) {
    url.searchParams.set('domains', domains.join(','));
  }
  return url.toString();
}

function assertWebSocketAuthTransportIsSafe(url: URL): void {
  if (url.protocol !== 'ws:') return;
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.startsWith('127.');
  if (!isLoopback) {
    throw new ConfigurationError('Refusing to send GoodVibes WebSocket authentication over insecure ws:// transport. Use https:// or wss://.', {
      source: 'transport',
      hint: 'Use https:// or wss:// for non-loopback WebSocket runtime event connections.',
    });
  }
}

export function createEventSourceConnector<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  baseUrl: string,
  token: AuthTokenSource,
  fetchImpl: typeof fetch,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, TEvent> {
  const { observer } = options;
  const handleError = options.onError;
  return async (domain, onEnvelope) => {
    const url = buildEventSourceUrl(baseUrl, domain);
    const getAuthToken = normalizeAuthToken(token ?? undefined);
    // Inject W3C traceparent if OTel is active (async probe for SSE cold-start).
    const sseHeaders: Record<string, string> = {};
    await injectTraceparentAsync(sseHeaders);
    // Notify observer of outbound SSE connection attempt.
    invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'sse' }), observer?.onObserverError);
    try {
      return await openServerSentEventStream(fetchImpl, url, {
        onEvent: (eventName, payload) => {
          if (eventName !== domain) return;
          if (!payload || typeof payload !== 'object') return;
          // Validate the inbound envelope STRUCTURE at the transport boundary, mirroring
          // the WebSocket connector. Use the base envelope schema (payload: unknown): the
          // discriminant lives on the OUTER `type`, and the `payload` carries event-specific
          // data with NO inner `type` field, so the typed-payload schema would reject every
          // real frame. Event-specific payload validation happens at each domain boundary.
          // Unlike the WS path we must NOT throw here (the SSE flush loop has no try/catch
          // around onEvent), so route validation failures through the error channels and
          // drop the frame instead of delivering an unvalidated envelope to typed consumers.
          const parsed = SerializedEventEnvelopeSchema.safeParse(payload);
          if (!parsed.success) {
            const validationError = new GoodVibesSdkError('SSE runtime event payload failed schema validation.', {
              category: 'protocol',
              source: 'transport',
              recoverable: true,
              cause: parsed.error,
            });
            invokeTransportObserver(() => observer?.onError?.(validationError), observer?.onObserverError);
            handleError?.(validationError);
            return;
          }
          const envelope = parsed.data as SerializedRuntimeEnvelope<TEvent>;
          onEnvelope(envelope);
          // Notify observer of inbound event.
          invokeTransportObserver(() => {
            observer?.onTransportActivity?.({ direction: 'recv', url, kind: 'sse' });
            if (envelope.payload) {
              (observer as { onEvent?: (e: unknown) => void } | undefined)?.onEvent?.(envelope.payload);
            }
          }, observer?.onObserverError);
        },
        onError: (err) => {
          const streamError = transportErrorFromUnknown(err, 'SSE runtime event stream error');
          invokeTransportObserver(() => observer?.onError?.(streamError), observer?.onObserverError);
          handleError?.(streamError);
        },
      }, {
        reconnect: options.reconnect,
        getAuthToken,
        headers: Object.keys(sseHeaders).length > 0 ? sseHeaders : undefined,
      });
    } catch (error) {
      const connectionError = transportErrorFromUnknown(error, 'SSE runtime event connection failed');
      invokeTransportObserver(() => observer?.onError?.(connectionError), observer?.onObserverError);
      handleError?.(connectionError);
      throw connectionError;
    }
  };
}

export function createWebSocketConnector<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  baseUrl: string,
  token: AuthTokenSource,
  WebSocketImpl: typeof WebSocket,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, TEvent> {
  const { observer } = options;
  return async (domain, onEnvelope) => {
    const url = buildWebSocketUrl(baseUrl, [domain]);
    const reconnect = options.reconnect;
    const enabled = reconnect?.enabled ?? false;
    // Normalize reconnect policy, defaulting maxAttempts to a finite value to prevent
    // infinite auth-failure loops. Callers can opt-in to a higher limit explicitly.
    const reconnectPolicy = normalizeStreamReconnectPolicy({
      ...reconnect,
      maxAttempts: reconnect?.maxAttempts ?? DEFAULT_WS_MAX_ATTEMPTS,
    });
    let stopped = false;
    let reconnectAttempt = 0;
    let hasReceivedMessage = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: TimeoutHandle | null = null;
    // Once a connection stays open this long past 'connected', treat it as
    // proven-stable and reset the reconnect-attempt budget (see onOpen). This lets a
    // healthy-but-idle domain (no inbound frames) recover its retry budget, while a
    // flapping auth-reject loop that closes before the timer fires keeps counting.
    const CONNECTION_STABILITY_MS = 10_000;
    let stabilityTimer: TimeoutHandle | null = null;
    // Track last emitted connection state to avoid duplicate emissions.
    let lastConnectionState: ConnectionState | null = null;
    // Derive a stable transportId from the WS URL hostname (same URL for
    // the lifetime of this connector, so hostname is an appropriate stable key).
    const transportId = (() => { try { return new URL(url).hostname; } catch { return url; } })();

    const emitConnectionState = (state: ConnectionState): void => {
      if (state === lastConnectionState) return;
      lastConnectionState = state;
      options.onConnectionStateChange?.(state);
      options.onTransportEvent?.({ type: 'TRANSPORT_CONNECTION_STATE', transportId, state });
    };
    // Bounded outbound message queue — max entries and total bytes, drop-oldest policy.
    // Messages pushed while the socket is not yet open or is reconnecting are buffered here
    // and flushed on the next successful open event.
    const outboundQueue: Array<{ readonly data: string; readonly sizeBytes: number }> = [];
    let outboundQueueBytes = 0;
    let droppedOutboundCount = 0;
    // Track overflow bursts so notifications fire on every burst rather than once per
    // connection lifetime. overflowEventCount is reset to 0 in flushOutboundQueue on
    // reconnect, so the first burst after a restore is reported again.
    let overflowEventCount = 0;
    const getAuthToken = normalizeAuthToken(token ?? undefined);

    /**
     * Enqueue a message for delivery over this WebSocket connection.
     *
     * If the socket is currently open the message is sent immediately.
     * If the socket is not yet open (or is reconnecting), the message is
     * buffered and will be flushed once the connection is re-established.
     *
     * When the buffer is full by count or byte budget, the oldest pending
     * message is dropped and a counter is incremented. A single message larger
     * than MAX_OUTBOUND_MESSAGE_BYTES is rejected instead of being queued.
     * Callers that need back-pressure should check `socket?.readyState` before
     * calling.
     *
     * @param data - Serialised message string to send.
     */
    const emitLocal = (data: string): void => {
      if (socket && isSocketOpen(socket, WebSocketImpl)) {
        socket.send(data);
        return;
      }
      const sizeBytes = textEncoder.encode(data).byteLength;
      if (sizeBytes > MAX_OUTBOUND_MESSAGE_BYTES) {
        droppedOutboundCount += 1;
        overflowEventCount += 1;
        // fire on first overflow and every 10th thereafter so bursts between
        // reconnects stay observable after the first.
        if (overflowEventCount === 1 || overflowEventCount % 10 === 0) {
          const bpError = new WebSocketTransportError(
            `WebSocket outbound message too large (${sizeBytes} bytes, limit ${MAX_OUTBOUND_MESSAGE_BYTES}). Dropping the message while the socket reconnects.`,
            {
              code: 'WS_QUEUE_OVERFLOW',
              hint: 'Split large runtime event frames before enqueueing them while the WebSocket is disconnected.',
            },
          );
          options.onError?.(bpError);
          options.onBackpressure?.({
            droppedCount: droppedOutboundCount,
            queueLength: outboundQueue.length,
            queueBytes: outboundQueueBytes,
            reason: 'message_too_large',
          });
          // Dispatch typed event so UI event-bus subscribers receive the same
          // information as the onBackpressure callback.
          options.onTransportEvent?.({
            type: 'TRANSPORT_BACKPRESSURE',
            transportId,
            droppedCount: droppedOutboundCount,
            queueLength: outboundQueue.length,
            queueBytes: outboundQueueBytes,
            reason: 'message_too_large',
          });
        }
        return;
      }
      while (
        outboundQueue.length >= MAX_OUTBOUND_QUEUE
        || outboundQueueBytes + sizeBytes > MAX_OUTBOUND_QUEUE_BYTES
      ) {
        const dropped = outboundQueue.shift();
        if (!dropped) break;
        outboundQueueBytes -= dropped.sizeBytes;
        droppedOutboundCount += 1;
        overflowEventCount += 1;
        // fire on first overflow and every 10th thereafter.
        if (overflowEventCount === 1 || overflowEventCount % 10 === 0) {
          const bpError = new WebSocketTransportError(
            `WebSocket outbound queue full (limit ${MAX_OUTBOUND_QUEUE} messages / ${MAX_OUTBOUND_QUEUE_BYTES} bytes). Dropping oldest messages until the socket reconnects.`,
            {
              code: 'WS_QUEUE_OVERFLOW',
              hint: 'Wait for the runtime event WebSocket to reconnect before sending more local frames.',
            },
          );
          options.onError?.(bpError);
          options.onBackpressure?.({
            droppedCount: droppedOutboundCount,
            queueLength: outboundQueue.length,
            queueBytes: outboundQueueBytes,
            reason: 'queue_full',
          });
          // Dispatch typed event so UI event-bus subscribers receive the same
          // information as the onBackpressure callback.
          options.onTransportEvent?.({
            type: 'TRANSPORT_BACKPRESSURE',
            transportId,
            droppedCount: droppedOutboundCount,
            queueLength: outboundQueue.length,
            queueBytes: outboundQueueBytes,
            reason: 'queue_full',
          });
        }
      }
      outboundQueue.push({ data, sizeBytes });
      outboundQueueBytes += sizeBytes;
    };

    // Notify caller of the emitter handle for tests and local frame injection.
    options.onEmitter?.(emitLocal);

    const closeSocket = () => {
      if (!socket) return;
      // clear any pending reconnect timer so close() cannot schedule
      // a second reconnect while one is already pending.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      socket.close();
      socket = null;
    };

    const scheduleReconnect = (reason = 'connection closed') => {
      if (!enabled || stopped) return;
      const nextAttempt = reconnectAttempt + 1;
      if (nextAttempt > reconnectPolicy.maxAttempts) {
        emitConnectionState('failed');
        return;
      }
      reconnectAttempt = nextAttempt;
      // Use shared backoff helper so WS and SSE are on identical schedule.
      const delayMs = getStreamReconnectDelay(nextAttempt, reconnectPolicy);
      // Fire legacy callback for backward compatibility AND new structured callback.
      options.onReconnect?.(nextAttempt, delayMs);
      options.onReconnectAttempt?.({
        attempt: nextAttempt,
        maxAttempts: reconnectPolicy.maxAttempts,
        delayMs,
        reason,
      });
      // Dispatch typed event so UI event-bus subscribers receive the same
      // metadata as the onReconnectAttempt callback.
      options.onTransportEvent?.({
        type: 'TRANSPORT_RECONNECT_ATTEMPT',
        transportId,
        attempt: nextAttempt,
        maxAttempts: reconnectPolicy.maxAttempts,
        delayMs,
        reason,
      });
      emitConnectionState('reconnecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect().catch((error) => {
          const connectionError = transportErrorFromUnknown(error, 'WebSocket runtime event reconnect failed');
          invokeTransportObserver(() => observer?.onError?.(connectionError), observer?.onObserverError);
          options.onError?.(connectionError);
          scheduleReconnect();
        });
      }, delayMs) as TimeoutHandle;
      // Do not keep Node/Bun processes alive solely to wait for a reconnect.
      reconnectTimer.unref?.();
    };

    const flushOutboundQueue = (ws: WebSocket) => {
      // re-check socket open before each send so queued messages are not
      // lost when the socket closes between the auth frame and the drain loop.
      // Messages that cannot be sent are left in the queue for the next reconnect cycle.
      while (outboundQueue.length > 0) {
        if (!isSocketOpen(ws, WebSocketImpl)) {
          // Socket closed mid-drain; leave the remaining items for the next reconnect.
          break;
        }
        const item = outboundQueue.shift();
        if (!item) break;
        outboundQueueBytes -= item.sizeBytes;
        ws.send(item.data);
      }
      // Reset overflow state on successful reconnect so the next burst is reported.
      overflowEventCount = 0;
    };

    const onOpen = async (event: Event) => {
      // NOTE: do NOT call emitConnectionState('connecting') here — connect()
      // already emits it before creating the socket. Calling it here would
      // be a dedup-suppressed no-op (lastConnectionState is already 'connecting')
      // and is semantically wrong since the socket is now open, not connecting.
      const candidateSocket = event.currentTarget as WebSocket | null;
      const openedSocket = candidateSocket && typeof candidateSocket.send === 'function'
        ? candidateSocket
        : socket;
      try {
        const authToken = (await getAuthToken()) ?? null;
        // surface a diagnostic error when the token resolver returns null
        // before a reconnect loop is scheduled.
        if (authToken === null || authToken === undefined) {
          options.onError?.(new ConfigurationError(
            'WebSocket auth token resolver returned null. Check transport options.authToken / options.getAuthToken.',
            { code: 'SDK_AUTH_TOKEN_MISSING', source: 'config' },
          ));
          closeSocket();
          return;
        }
        if (!openedSocket || stopped || socket !== openedSocket) return;
        // Notify observer of outbound WS connection.
        invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'ws' }), observer?.onObserverError);
        // Send auth frame first, then drain any messages buffered during resolution.
        // Inject traceparent into the auth frame for W3C Trace Context propagation over WebSocket.
        const wsTraceHeaders: Record<string, string> = {};
        await injectTraceparentAsync(wsTraceHeaders);
        if (stopped || socket !== openedSocket) return;
        openedSocket.send(JSON.stringify({
          type: 'auth',
          token: authToken,
          domains: [domain],
          ...(wsTraceHeaders['traceparent'] ? { traceparent: wsTraceHeaders['traceparent'] } : {}),
          ...(wsTraceHeaders['tracestate'] ? { tracestate: wsTraceHeaders['tracestate'] } : {}),
        }));
        flushOutboundQueue(openedSocket);
        emitConnectionState('connected');
        options.onOpen?.();
        // Reset the reconnect-attempt budget only after the connection proves stable.
        // 'connected' is emitted right after the auth frame is sent (before the server
        // validates the token), so resetting here directly would defeat the auth-failure
        // loop guard: an auth-reject that closes immediately must keep counting toward the
        // give-up limit. A connection that survives CONNECTION_STABILITY_MS is treated as
        // genuinely healthy and its budget restored, covering quiet/idle domains too.
        if (stabilityTimer) {
          clearTimeout(stabilityTimer);
          stabilityTimer = null;
        }
        stabilityTimer = setTimeout(() => {
          stabilityTimer = null;
          if (!stopped && socket === openedSocket && isSocketOpen(openedSocket, WebSocketImpl)) {
            reconnectAttempt = 0;
          }
        }, CONNECTION_STABILITY_MS) as TimeoutHandle;
        stabilityTimer.unref?.();
      } catch (error) {
        const sendError = transportErrorFromUnknown(error, 'WebSocket send failed');
        invokeTransportObserver(() => observer?.onError?.(sendError), observer?.onObserverError);
        options.onError?.(sendError);
        closeSocket();
        scheduleReconnect();
      }
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        if (typeof event.data !== 'string') {
          throw new WebSocketTransportError('WebSocket runtime event frame was not a string payload.', { code: 'WS_EVENT_ERROR' });
        }
        // cheap pre-check (1 byte per char worst case) avoids allocating
        // the full UTF-8 buffer for clearly-oversized frames. Only fall through
        // to textEncoder.encode when within the fast bound.
        if (event.data.length > MAX_INBOUND_FRAME_BYTES) {
          throw new WebSocketTransportError(
            `WebSocket runtime event frame too large (>${MAX_INBOUND_FRAME_BYTES} bytes, limit ${MAX_INBOUND_FRAME_BYTES}).`,
            { code: 'WS_FRAME_TOO_LARGE' },
          );
        }
        const frameBytes = textEncoder.encode(event.data).byteLength;
        if (frameBytes > MAX_INBOUND_FRAME_BYTES) {
          throw new WebSocketTransportError(
            `WebSocket runtime event frame too large (${frameBytes} bytes, limit ${MAX_INBOUND_FRAME_BYTES}).`,
            { code: 'WS_FRAME_TOO_LARGE' },
          );
        }
        const frame = JSON.parse(event.data) as { type?: string; event?: string; payload?: unknown };
        if (!hasReceivedMessage) {
          hasReceivedMessage = true;
          reconnectAttempt = 0;
        }
        if (frame.type === 'event' && frame.event === domain && frame.payload && typeof frame.payload === 'object') {
          // Validate envelope structure only; the discriminant is the outer `type` and the
          // `payload` carries event-specific data without an inner `type` (see SSE path).
          const parsedPayload = SerializedEventEnvelopeSchema.safeParse(frame.payload);
          if (!parsedPayload.success) {
            throw new WebSocketTransportError('WebSocket runtime event payload failed schema validation.', {
              code: 'WS_EVENT_ERROR',
              cause: parsedPayload.error,
            });
          }
          const wsPayload = parsedPayload.data as SerializedRuntimeEnvelope<TEvent>;
          onEnvelope(wsPayload);
          // Notify observer of inbound WS event.
          invokeTransportObserver(() => {
            observer?.onTransportActivity?.({ direction: 'recv', url, kind: 'ws' });
            if (wsPayload.payload) {
              (observer as { onEvent?: (e: unknown) => void } | undefined)?.onEvent?.(wsPayload.payload);
            }
          }, observer?.onObserverError);
        }
      } catch (error) {
        const malformed = new GoodVibesSdkError(`Malformed WebSocket runtime event frame: ${transportErrorFromUnknown(error, 'parse error').message}`, {
          category: 'protocol',
          source: 'transport',
          recoverable: true,
          cause: error,
        });
        invokeTransportObserver(() => observer?.onError?.(malformed), observer?.onObserverError);
        options.onError?.(malformed);
      }
    };

    const onClose = (event: CloseEvent) => {
      hasReceivedMessage = false;
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      // RFC 6455 §7.4.1: code 1005 (No Status Received) is synthesized by runtimes
      // when a socket closes WITHOUT a close frame — including abnormal drops (process
      // death, proxy teardown, RST) where wasClean === false. Only a genuine clean
      // shutdown has wasClean === true AND code === 1000. Everything else must reconnect.
      //
      // Compatibility note: the `wasClean` field is present on the browser CloseEvent
      // and on the 'ws' package's CloseEvent (used by Node.js and Bun). If a runtime
      // somehow does not expose wasClean, `event.wasClean` is undefined (falsy), so
      // the expression `event.wasClean === true` correctly falls back to reconnecting
      // for any ambiguous close — never suppresses reconnect incorrectly.
      const isCleanClose = event.wasClean === true && event.code === 1000;
      if (!stopped && !isCleanClose) {
        // Abnormal close — surface error and schedule reconnect.
        // The raw close reason is forwarded so TRANSPORT_RECONNECT_ATTEMPT
        // metadata is meaningful to diagnostic UIs.
        const closeError = webSocketCloseError(event);
        invokeTransportObserver(() => observer?.onError?.(closeError), observer?.onObserverError);
        options.onError?.(closeError);
        closeSocket();
        // Pass the close reason so reconnect metadata is meaningful.
        const rawReason = typeof event.reason === 'string' && event.reason.trim()
          ? event.reason.trim()
          : `code=${event.code}`;
        scheduleReconnect(rawReason);
      } else {
        // Clean close (wasClean === true && code === 1000) — deliberate server-side
        // disconnect. We do NOT schedule a reconnect: the server explicitly terminated
        // the session and the client should stay disconnected.
        //
        // **Contract:** `scheduleReconnect` is only called for non-clean closes.
        // UIs observing `TRANSPORT_CONNECTION_STATE` will see the state transition
        // to 'disconnected' emitted directly here in onClose, and will NOT see
        // 'reconnecting' following a clean close.
        closeSocket();
        emitConnectionState('disconnected');
      }
    };

    const onError = (event: Event) => {
      const streamError = webSocketEventError(event, socket, url);
      invokeTransportObserver(() => observer?.onError?.(streamError), observer?.onObserverError);
      options.onError?.(streamError);
    };

    const connect = async () => {
      if (stopped) return;
      closeSocket();
      emitConnectionState('connecting');
      const nextSocket = new WebSocketImpl(url);
      socket = nextSocket;
      nextSocket.addEventListener('open', onOpen);
      nextSocket.addEventListener('message', onMessage);
      nextSocket.addEventListener('close', onClose);
      nextSocket.addEventListener('error', onError);
    };

    // connect() is async but new WebSocket() does not throw synchronously;
    // transport-level failures surface through onError/onClose. The try/catch
    // here was dead code. Remove it and rely entirely on those event handlers.
    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      closeSocket();
      emitConnectionState('disconnected');
      // reset the outbound buffer on disposal so a future reconnect
      // (or re-use of the returned cleanup path in tests) does not accumulate
      // stale byte totals. Both must be reset together to prevent accounting drift.
      outboundQueue.length = 0;
      outboundQueueBytes = 0;
    };
  };
}

function webSocketCloseError(event: CloseEvent): Error {
  // Cap reason length to prevent oversized error messages.
  const rawReason = typeof event.reason === 'string' ? event.reason.trim() : '';
  const reason = rawReason.length > 256 ? `${rawReason.slice(0, 256)}…` : rawReason;
  const code = typeof event.code === 'number' ? event.code : 1005;
  const wasClean = typeof event.wasClean === 'boolean' ? event.wasClean : false;
  const detail = [
    `code=${code}`,
    reason ? `reason=${reason}` : undefined,
    `wasClean=${wasClean}`,
  ].filter(Boolean).join(' ');
  return new WebSocketTransportError(`WebSocket runtime event stream closed unexpectedly: ${detail}`, {
    code: 'WS_CLOSE_ABNORMAL',
    cause: { code, reason, wasClean },
  });
}

function webSocketEventError(event: Event, socket: WebSocket | null, url: string): Error {
  // We cast to ErrorEvent to access `error`/`message` fields.
  // Per the WHATWG spec, WebSocket `error` events are plain Events — not ErrorEvents
  // — so `candidate.error` and `candidate.message` may be undefined in compliant
  // browsers. The safe-extract path below handles both cases: if `candidate.error`
  // is defined we treat it as an ErrorEvent (V8/Bun do populate it on some failures);
  // if not, we fall through to the generic `describeUnknownTransportError` branch.
  // Using `socket.onerror` directly instead would lose the envelope-unwrap logic here.
  const candidate = event as ErrorEvent;
  // avoid retaining the raw event.error (which may hold currentTarget/target
  // back-references to the WebSocket, creating retention chains over many reconnects).
  // Capture only name+message from Error instances; stringify anything else.
  const safeError = candidate.error instanceof Error
    ? { name: candidate.error.name, message: candidate.error.message }
    : candidate.error !== undefined && candidate.error !== null
      ? String(candidate.error)
      : undefined;
  const cause = {
    eventType: event.type,
    url,
    readyState: socket?.readyState,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
    error: safeError,
  };
  if (candidate.error) {
    return new WebSocketTransportError(
      `WebSocket runtime event stream error: ${transportErrorFromUnknown(candidate.error, 'WebSocket error').message}`,
      { code: 'WS_REMOTE_ERROR', cause },
    );
  }
  const eventMessage = typeof candidate.message === 'string' && candidate.message.trim().length > 0
    ? candidate.message.trim()
    : undefined;
  return new WebSocketTransportError(
    eventMessage
      ? `WebSocket runtime event stream error: ${eventMessage}`
      : `WebSocket runtime event stream error: ${describeUnknownTransportError(event)}`,
    { code: 'WS_REMOTE_ERROR', cause },
  );
}
