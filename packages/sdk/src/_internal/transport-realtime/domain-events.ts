// Synced from packages/transport-realtime/src/domain-events.ts
import type { EventEnvelope } from '../transport-core/index.js';
import { createRuntimeEventFeeds, type RuntimeEventFeed, type RuntimeEventFeeds } from '../transport-core/index.js';

type EventLike = { readonly type: string };

export interface SerializedEventEnvelope<TEvent extends EventLike = EventLike> {
  readonly type: string;
  readonly timestamp?: number;
  readonly ts?: number;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly payload: TEvent;
}

export type DomainEventConnector<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = (
  domain: TDomain,
  onEnvelope: (envelope: SerializedEventEnvelope<TEvent>) => void,
) => void | Promise<() => void>;

export type DomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
> = RuntimeEventFeeds<TDomain, TEvent>;

function addListener<T>(map: Map<string, Set<T>>, type: string, listener: T): () => void {
  const listeners = map.get(type) ?? new Set<T>();
  listeners.add(listener);
  map.set(type, listeners);
  return () => {
    const existing = map.get(type);
    if (!existing) return;
    existing.delete(listener);
    if (existing.size === 0) {
      map.delete(type);
    }
  };
}

function hasAnyListener(map: Map<string, Set<unknown>>): boolean {
  for (const listeners of map.values()) {
    if (listeners.size > 0) return true;
  }
  return false;
}

function isExpectedDisconnectError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: string }).name === 'AbortError'
  );
}

function toEventEnvelope<TEvent extends EventLike>(
  envelope: SerializedEventEnvelope<TEvent>,
): EventEnvelope<string, TEvent> {
  return {
    type: envelope.type,
    ts: typeof envelope.ts === 'number'
      ? envelope.ts
      : typeof envelope.timestamp === 'number'
        ? envelope.timestamp
        : Date.now(),
    traceId: typeof envelope.traceId === 'string' ? envelope.traceId : 'transport-trace',
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : 'transport',
    source: typeof envelope.source === 'string' ? envelope.source : 'transport',
    payload: envelope.payload,
  };
}

function createRemoteDomainEventFeed<
  TDomain extends string,
  TEvent extends EventLike,
>(
  domain: TDomain,
  connect: DomainEventConnector<TDomain, TEvent>,
): RuntimeEventFeed<TEvent> {
  const payloadListeners = new Map<string, Set<(payload: TEvent) => void>>();
  const envelopeListeners = new Map<string, Set<(envelope: EventEnvelope<string, TEvent>) => void>>();
  let disconnect: (() => void) | null = null;
  let connectPromise: Promise<void> | null = null;
  let disconnectPending = false;

  const hasListeners = (): boolean => (
    hasAnyListener(payloadListeners as Map<string, Set<unknown>>)
    || hasAnyListener(envelopeListeners as Map<string, Set<unknown>>)
  );

  const maybeConnect = (): void => {
    if (disconnect || connectPromise) return;
    connectPromise = Promise.resolve(connect(domain, (envelope) => {
      const eventType = typeof envelope.type === 'string' ? envelope.type : '';
      if (!eventType) return;
      const payload = envelope.payload;
      const typedEnvelope = toEventEnvelope(envelope);
      for (const listener of payloadListeners.get(eventType) ?? []) {
        listener(payload);
      }
      for (const listener of envelopeListeners.get(eventType) ?? []) {
        listener(typedEnvelope);
      }
    })).then((cleanup) => {
      if (typeof cleanup !== 'function') return;
      if (disconnectPending && !hasListeners()) {
        cleanup();
        return;
      }
      disconnect = cleanup;
    }).catch((error: unknown) => {
      if (!isExpectedDisconnectError(error)) {
        throw error;
      }
    }).finally(() => {
      connectPromise = null;
      disconnectPending = false;
    });
  };

  const maybeDisconnect = (): void => {
    if (hasListeners()) return;
    if (disconnect) {
      disconnect();
      disconnect = null;
      return;
    }
    if (connectPromise) {
      disconnectPending = true;
    }
  };

  return {
    on(type, listener) {
      const unsubscribe = addListener(payloadListeners, type, listener as (payload: TEvent) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
    onEnvelope(type, listener) {
      const unsubscribe = addListener(envelopeListeners, type, listener as (envelope: EventEnvelope<string, TEvent>) => void);
      maybeConnect();
      return () => {
        unsubscribe();
        maybeDisconnect();
      };
    },
  };
}

export function createRemoteDomainEvents<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
>(
  domains: readonly TDomain[],
  connect: DomainEventConnector<TDomain, TEvent>,
): DomainEvents<TDomain, TEvent> {
  return createRuntimeEventFeeds(
    domains,
    (domain) => createRemoteDomainEventFeed(domain, connect),
  );
}

/**
 * Wraps an existing {@link RuntimeEventFeed} and returns a filtered feed whose
 * callbacks only fire for envelopes whose `sessionId` matches the given value.
 *
 * Unsubscribe handles returned by `on` / `onEnvelope` on the filtered feed
 * correctly remove the underlying listener from the original feed.
 */
function createFilteredFeed<TEvent extends EventLike>(
  feed: RuntimeEventFeed<TEvent>,
  sessionId: string,
): RuntimeEventFeed<TEvent> {
  return {
    on<TType extends TEvent['type']>(
      type: TType,
      listener: (payload: Extract<TEvent, { type: TType }>) => void,
    ): () => void {
      return feed.onEnvelope(type, (envelope) => {
        if (envelope.sessionId !== sessionId) return;
        listener(envelope.payload as Extract<TEvent, { type: TType }>);
      });
    },
    onEnvelope<TType extends TEvent['type']>(
      type: TType,
      listener: (envelope: EventEnvelope<TType, Extract<TEvent, { type: TType }>>) => void,
    ): () => void {
      return feed.onEnvelope(type, (envelope) => {
        if (envelope.sessionId !== sessionId) return;
        listener(envelope as EventEnvelope<TType, Extract<TEvent, { type: TType }>>);
      });
    },
  };
}

/**
 * Returns a filtered view of the given domain events object where every
 * callback only fires for events whose envelope `sessionId` equals the
 * supplied value.
 *
 * All domain feeds and the `domain()` accessor are pre-filtered. The
 * `domains` list is preserved unchanged.
 *
 * Unsubscribe handles returned by the filtered feeds propagate correctly
 * to the underlying connection.
 *
 * @example
 * const events = sdk.realtime.viaSse();
 * // Without forSession — manual filter:
 * events.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   if (e.sessionId !== mySessionId) return;
 *   process.stdout.write(e.payload.content);
 * });
 *
 * // With forSession — no filter needed:
 * const sessionEvents = forSession(events, mySessionId);
 * sessionEvents.turn.onEnvelope('STREAM_DELTA', (e) => {
 *   process.stdout.write(e.payload.content);
 * });
 */
export function forSession<
  TDomain extends string,
  TEvent extends EventLike = EventLike,
>(
  events: DomainEvents<TDomain, TEvent>,
  sessionId: string,
): DomainEvents<TDomain, TEvent> {
  const filteredFeeds = {} as Record<TDomain, RuntimeEventFeed<TEvent>>;
  for (const domain of events.domains) {
    filteredFeeds[domain] = createFilteredFeed(events[domain], sessionId);
  }
  return Object.freeze({
    ...filteredFeeds,
    domains: events.domains,
    domain(d: TDomain): RuntimeEventFeed<TEvent> {
      return filteredFeeds[d];
    },
  }) as DomainEvents<TDomain, TEvent>;
}
