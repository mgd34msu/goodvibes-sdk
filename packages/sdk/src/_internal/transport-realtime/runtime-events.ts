// Synced from packages/transport-realtime/src/runtime-events.ts
import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '../contracts/index.js';
import {
  normalizeAuthToken,
  type AuthTokenResolver,
  type StreamReconnectPolicy,
  openRawServerSentEventStream as openServerSentEventStream,
  normalizeStreamReconnectPolicy,
  getStreamReconnectDelay,
} from '../transport-http/index.js';
import { buildUrl, normalizeBaseUrl } from '../transport-http/index.js';
import { injectTraceparentAsync, invokeTransportObserver, type TransportObserver } from '../transport-core/index.js';
import {
  createRemoteDomainEvents,
  type DomainEventConnector,
  type DomainEvents,
  type SerializedEventEnvelope,
} from './domain-events.js';

type RuntimeEventRecord = { readonly type: string };

export type SerializedRuntimeEnvelope<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  SerializedEventEnvelope<TEvent>;

export type RemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord> =
  DomainEvents<RuntimeEventDomain, TEvent>;

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
  readonly reconnect?: StreamReconnectPolicy;
  readonly onError?: (error: unknown) => void;
  readonly observer?: TransportObserver;
  /**
   * Called once the WebSocket connector is set up, providing an `emitLocal`
   * function the caller can use to send messages over this connection.
   * Primarily for test/shim use cases that need to inject outbound frames.
   */
  readonly onEmitter?: (emitLocal: (data: string) => void) => void;
}

type AuthTokenSource = string | null | undefined | AuthTokenResolver;

/** Default max reconnect attempts for WebSocket connections (finite to prevent infinite auth loops). */
export const DEFAULT_WS_MAX_ATTEMPTS = 10;

/** Maximum number of messages that may be queued in the outbound queue before the oldest entry is dropped. */
const MAX_OUTBOUND_QUEUE = 1024;

export function createRemoteRuntimeEvents<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  connect: DomainEventConnector<RuntimeEventDomain, TEvent>,
): RemoteRuntimeEvents<TEvent> {
  return createRemoteDomainEvents(
    RUNTIME_EVENT_DOMAINS,
    connect,
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
  const url = new URL('/api/control-plane/ws', normalizeBaseUrl(baseUrl));
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Unsupported WebSocket base URL protocol: ${url.protocol}`);
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
    throw new Error('Refusing to send GoodVibes WebSocket authentication over insecure ws:// transport. Use https:// or wss://.');
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
    invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'sse' }));
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
        });
      },
      onError: (err) => {
        invokeTransportObserver(() => observer?.onError?.(err instanceof Error ? err : new Error(String(err))));
        handleError?.(err);
      },
    }, {
      reconnect: options.reconnect,
      getAuthToken,
      headers: Object.keys(sseHeaders).length > 0 ? sseHeaders : undefined,
    });
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Bounded outbound message queue — max MAX_OUTBOUND_QUEUE entries, drop-oldest policy.
    // Messages pushed while the socket is not yet open or is reconnecting are buffered here
    // and flushed on the next successful open event.
    const outboundQueue: string[] = [];
    let droppedOutboundCount = 0;
    let queueOverflowNotified = false;

    /**
     * Enqueue a message for delivery over this WebSocket connection.
     *
     * If the socket is currently open the message is sent immediately.
     * If the socket is not yet open (or is reconnecting), the message is
     * buffered and will be flushed once the connection is re-established.
     *
     * When the buffer is full (> MAX_OUTBOUND_QUEUE), the oldest pending
     * message is silently dropped and a counter is incremented. Callers that
     * need back-pressure should check `socket?.readyState` before calling.
     *
     * @param data - Serialised message string to send.
     */
    const emitLocal = (data: string): void => {
      if (socket && socket.readyState === WebSocketImpl.OPEN) {
        socket.send(data);
        return;
      }
      if (outboundQueue.length >= MAX_OUTBOUND_QUEUE) {
        // Drop oldest message to make room (drop-oldest policy).
        outboundQueue.shift();
        droppedOutboundCount += 1;
        if (!queueOverflowNotified) {
          queueOverflowNotified = true;
          options.onError?.(new Error(
            `WebSocket outbound queue full (limit ${MAX_OUTBOUND_QUEUE}). Dropping oldest messages until the socket reconnects.`,
          ));
        }
      }
      outboundQueue.push(data);
    };

    // Notify caller of the emitter handle (for test/shim use cases).
    options.onEmitter?.(emitLocal);

    const closeSocket = () => {
      if (!socket) return;
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
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
      reconnectTimer.unref?.();
    };

    const flushOutboundQueue = (ws: WebSocket) => {
      while (outboundQueue.length > 0) {
        ws.send(outboundQueue.shift()!);
      }
    };

    const onOpen = async (event: Event) => {
      const candidateSocket = event.currentTarget as WebSocket | null;
      const openedSocket = candidateSocket && typeof candidateSocket.send === 'function'
        ? candidateSocket
        : socket;
      try {
        const authToken = (await normalizeAuthToken(token ?? undefined)()) ?? null;
        if (!authToken || !openedSocket || stopped || socket !== openedSocket || openedSocket.readyState !== WebSocketImpl.OPEN) return;
        // Notify observer of outbound WS connection.
        invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'ws' }));
        // Send auth frame first, then drain any messages buffered during resolution.
        // Inject traceparent into the auth frame for W3C Trace Context propagation over WebSocket.
        const wsTraceHeaders: Record<string, string> = {};
        await injectTraceparentAsync(wsTraceHeaders);
        if (stopped || socket !== openedSocket || openedSocket.readyState !== WebSocketImpl.OPEN) return;
        openedSocket.send(JSON.stringify({
          type: 'auth',
          token: authToken,
          domains: [domain],
          ...(wsTraceHeaders['traceparent'] ? { traceparent: wsTraceHeaders['traceparent'] } : {}),
          ...(wsTraceHeaders['tracestate'] ? { tracestate: wsTraceHeaders['tracestate'] } : {}),
        }));
        flushOutboundQueue(openedSocket);
      } catch (error) {
        const sendError = error instanceof Error ? error : new Error(String(error));
        invokeTransportObserver(() => observer?.onError?.(sendError));
        options.onError?.(sendError);
        closeSocket();
        scheduleReconnect();
      }
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string; event?: string; payload?: unknown };
        if (!hasReceivedMessage) {
          hasReceivedMessage = true;
          reconnectAttempt = 0;
        }
        queueOverflowNotified = false;
        if (frame.type === 'event' && frame.event === domain && frame.payload && typeof frame.payload === 'object') {
          const wsPayload = frame.payload as SerializedRuntimeEnvelope<TEvent>;
          onEnvelope(wsPayload);
          // Notify observer of inbound WS event.
          invokeTransportObserver(() => {
            observer?.onTransportActivity?.({ direction: 'recv', url, kind: 'ws' });
            if (wsPayload.payload) {
              (observer as { onEvent?: (e: unknown) => void } | undefined)?.onEvent?.(wsPayload.payload);
            }
          });
        }
      } catch (error) {
        const malformed = new Error(`Malformed WebSocket runtime event frame: ${error instanceof Error ? error.message : String(error)}`);
        invokeTransportObserver(() => observer?.onError?.(malformed));
        options.onError?.(malformed);
      }
    };

    const onClose = () => {
      hasReceivedMessage = false;
      closeSocket();
      scheduleReconnect();
    };

    const onError = (event: Event) => {
      invokeTransportObserver(() => observer?.onError?.(event instanceof Error ? event : new Error(String(event))));
      options.onError?.(event);
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

    await connect();
    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      closeSocket();
    };
  };
}
