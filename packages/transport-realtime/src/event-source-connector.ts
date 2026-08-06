/**
 * event-source-connector.ts — the SSE runtime-event connector.
 *
 * Lifted out of runtime-events.ts so the two things a fresh-stream-per-turn
 * client needs have somewhere to live and something to be tested against:
 *
 *  RESUMPTION. The stream underneath already remembers its position across its
 *  OWN reconnects, but a caller that closes the stream and opens a new one for
 *  the next turn used to start from nothing — and a gateway replays "recent
 *  traffic" to a client claiming no position, which hands the new stream the
 *  tail of the previous turn, terminal frames included. The connector now keeps
 *  the last event id it saw per URL and presents it as `Last-Event-ID` on every
 *  (re)establishment, so the gateway replays only what this connector has not
 *  already been given.
 *
 *  TURN IDENTITY. Second line, for the replays we cannot prevent — a gateway
 *  that cannot resolve the position, a server that predates the resume, a frame
 *  that genuinely arrives twice. Turn frames carry a `turnId`; the gate drops
 *  the ones addressed to a turn this connection is not rendering, so a replayed
 *  `TURN_COMPLETED` can never finish a different turn. On by default —
 *  `turnScope: 'off'` opts out, `{ turnId }` pins the connection to one turn.
 */

import {
  SerializedEventEnvelopeSchema,
  type RuntimeEventDomain,
  type RuntimeEventRecord,
} from '@pellux/goodvibes-contracts';
import { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import {
  buildUrl,
  normalizeAuthToken,
  openRawServerSentEventStream as openServerSentEventStream,
} from '@pellux/goodvibes-transport-http';
import {
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
} from '@pellux/goodvibes-transport-core';
import type { DomainEventConnector, SerializedEventEnvelope } from './domain-events.js';
import {
  createTurnLifecycleGate,
  readTurnLifecycleFrame,
  type TurnLifecycleGate,
} from './turn-lifecycle-gate.js';
import type {
  AuthTokenSource,
  RuntimeEventConnectorOptions,
  RuntimeEventTurnScope,
} from './connector-options.js';

function buildGate(scope: RuntimeEventTurnScope | undefined): TurnLifecycleGate | null {
  if (scope === 'off') return null;
  if (typeof scope === 'object' && scope !== null) return createTurnLifecycleGate({ turnId: scope.turnId });
  return createTurnLifecycleGate();
}

export function buildEventSourceUrl(
  baseUrl: string,
  domain: RuntimeEventDomain,
): string {
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', domain);
  return url.toString();
}

export function createEventSourceConnector<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  baseUrl: string,
  token: AuthTokenSource,
  fetchImpl: typeof fetch,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, TEvent> {
  const { observer } = options;
  const handleError = options.onError;
  // Position per URL, held for the life of the connector rather than the life
  // of one stream: that is the whole point — a NEW stream for the next turn
  // resumes where the closed one stopped.
  const resumePositions = new Map<string, string>();
  // One gate per connector, not per domain: tool frames and turn frames arrive
  // on separate streams and must be judged against the same binding.
  const gate = buildGate(options.turnScope);

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
        onEventId: (id) => { resumePositions.set(url, id); },
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
          const envelope = parsed.data as SerializedEventEnvelope<TEvent>;
          if (gate) {
            const frame = readTurnLifecycleFrame(envelope.sessionId, envelope.payload);
            if (frame && !gate.accepts(frame)) return;
          }
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
        lastEventId: resumePositions.get(url) ?? null,
      });
    } catch (error) {
      const connectionError = transportErrorFromUnknown(error, 'SSE runtime event connection failed');
      invokeTransportObserver(() => observer?.onError?.(connectionError), observer?.onObserverError);
      handleError?.(connectionError);
      throw connectionError;
    }
  };
}
