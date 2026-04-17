import { RUNTIME_EVENT_DOMAINS, type RuntimeEventDomain } from '@pellux/goodvibes-contracts';
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
}

type AuthTokenSource = string | null | undefined | AuthTokenResolver;

/** Default max reconnect attempts for WebSocket connections (finite to prevent infinite auth loops). */
export const DEFAULT_WS_MAX_ATTEMPTS = 10;

/** Maximum number of messages that may be queued in outboundQueue pending a producer API. */
const MAX_OUTBOUND_QUEUE = 256;

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
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL('/api/control-plane/ws', base.replace(/^http(s?):\/\//, 'ws$1://'));
  url.searchParams.set('clientKind', 'web');
  if (domains.length > 0) {
    url.searchParams.set('domains', domains.join(','));
  }
  return url.toString();
}

export function createEventSourceConnector(
  baseUrl: string,
  token: AuthTokenSource,
  fetchImpl: typeof fetch,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, RuntimeEventRecord> {
  const handleError = options.onError ?? (options.reconnect?.enabled ? (() => {}) : undefined);
  return async (domain, onEnvelope) => {
    const url = buildEventSourceUrl(baseUrl, domain);
    const getAuthToken = normalizeAuthToken(token ?? undefined);
    return await openServerSentEventStream(fetchImpl, url, {
      onEvent: (eventName, payload) => {
        if (eventName !== domain) return;
        if (!payload || typeof payload !== 'object') return;
        onEnvelope(payload as SerializedRuntimeEnvelope);
      },
      onError: handleError,
    }, {
      reconnect: options.reconnect,
      getAuthToken,
    });
  };
}

export function createWebSocketConnector(
  baseUrl: string,
  token: AuthTokenSource,
  WebSocketImpl: typeof WebSocket,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, RuntimeEventRecord> {
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
    // TODO: producer API not yet wired. When added, bound queue size via
    // MAX_OUTBOUND_QUEUE (see below) and drop oldest or reject with onError.
    const outboundQueue: string[] = [];

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
      if (nextAttempt >= reconnectPolicy.maxAttempts) return;
      reconnectAttempt = nextAttempt;
      // Use shared backoff helper so WS and SSE are on identical schedule.
      const delayMs = getStreamReconnectDelay(nextAttempt, reconnectPolicy);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
    };

    const flushOutboundQueue = (ws: WebSocket) => {
      while (outboundQueue.length > 0) {
        ws.send(outboundQueue.shift()!);
      }
    };

    const onOpen = async () => {
      const authToken = (await normalizeAuthToken(token ?? undefined)()) ?? null;
      if (!authToken || !socket) return;
      // Send auth frame first, then drain any messages buffered during resolution.
      socket.send(JSON.stringify({
        type: 'auth',
        token: authToken,
        domains: [domain],
      }));
      flushOutboundQueue(socket);
    };

    const onMessage = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string; event?: string; payload?: unknown };
        if (frame.type === 'event' && frame.event === domain && frame.payload && typeof frame.payload === 'object') {
          // Reset reconnect counter on first successful message — transient mid-session
          // failures should not compound with failures from the initial connection phase.
          if (!hasReceivedMessage) {
            hasReceivedMessage = true;
            reconnectAttempt = 0;
          }
          onEnvelope(frame.payload as SerializedRuntimeEnvelope);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    const onClose = () => {
      hasReceivedMessage = false;
      closeSocket();
      scheduleReconnect();
    };

    const onError = (event: Event) => {
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
