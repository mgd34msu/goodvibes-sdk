import {
  RUNTIME_EVENT_DOMAINS,
  TypedSerializedEventEnvelopeSchema,
  type RuntimeEventDomain,
  type RuntimeEventRecord,
} from '@pellux/goodvibes-contracts';
import { ConfigurationError, GoodVibesSdkError } from '@pellux/goodvibes-errors';
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

export interface RuntimeEventConnectorOptions {
  readonly reconnect?: StreamReconnectPolicy | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onReconnect?: ((attempt: number, delayMs: number) => void) | undefined;
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
  constructor(message: string, options: { readonly cause?: unknown; readonly hint?: string; readonly code: string }) {
    super(message, {
      code: options.code,
      category: 'network',
      source: 'transport',
      recoverable: true,
      hint: options.hint,
      cause: options.cause,
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
          const envelope = payload as SerializedRuntimeEnvelope<TEvent>;
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
    // Bounded outbound message queue — max entries and total bytes, drop-oldest policy.
    // Messages pushed while the socket is not yet open or is reconnecting are buffered here
    // and flushed on the next successful open event.
    const outboundQueue: Array<{ readonly data: string; readonly sizeBytes: number }> = [];
    let outboundQueueBytes = 0;
    let droppedOutboundCount = 0;
    // track overflow notification count so we fire on every overflow burst
    // rather than once per connection lifetime. queueOverflowNotified is reset in
    // flushOutboundQueue when the connection restores.
    let queueOverflowNotified = false;
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
          queueOverflowNotified = true;
          options.onError?.(new WebSocketTransportError(
            `WebSocket outbound message too large (${sizeBytes} bytes, limit ${MAX_OUTBOUND_MESSAGE_BYTES}). Dropping the message while the socket reconnects.`,
            {
              code: 'WS_QUEUE_OVERFLOW',
              hint: 'Split large runtime event frames before enqueueing them while the WebSocket is disconnected.',
            },
          ));
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
          queueOverflowNotified = true;
          options.onError?.(new WebSocketTransportError(
            `WebSocket outbound queue full (limit ${MAX_OUTBOUND_QUEUE} messages / ${MAX_OUTBOUND_QUEUE_BYTES} bytes). Dropping oldest messages until the socket reconnects.`,
            {
              code: 'WS_QUEUE_OVERFLOW',
              hint: 'Wait for the runtime event WebSocket to reconnect before sending more local frames.',
            },
          ));
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
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      socket.close();
      socket = null;
    };

    const scheduleReconnect = () => {
      if (!enabled || stopped) return;
      const nextAttempt = reconnectAttempt + 1;
      if (nextAttempt > reconnectPolicy.maxAttempts) return;
      reconnectAttempt = nextAttempt;
      // Use shared backoff helper so WS and SSE are on identical schedule.
      const delayMs = getStreamReconnectDelay(nextAttempt, reconnectPolicy);
      options.onReconnect?.(nextAttempt, delayMs);
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
      queueOverflowNotified = false;
      overflowEventCount = 0;
    };

    const onOpen = async (event: Event) => {
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
        options.onOpen?.();
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
          const parsedPayload = TypedSerializedEventEnvelopeSchema.safeParse(frame.payload);
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
      if (!stopped && event.code !== 1000 && event.code !== 1005) {
        const closeError = webSocketCloseError(event);
        invokeTransportObserver(() => observer?.onError?.(closeError), observer?.onObserverError);
        options.onError?.(closeError);
      }
      closeSocket();
      scheduleReconnect();
    };

    const onError = (event: Event) => {
      const streamError = webSocketEventError(event, socket, url);
      invokeTransportObserver(() => observer?.onError?.(streamError), observer?.onObserverError);
      options.onError?.(streamError);
    };

    const connect = async () => {
      if (stopped) return;
      closeSocket();
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
