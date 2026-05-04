import type { EventEnvelope } from '@pellux/goodvibes-transport-core';
import {
  createRuntimeEventFeeds,
  isAbortError,
  transportErrorFromUnknown,
  type RuntimeEventFeed,
  type RuntimeEventFeeds,
} from '@pellux/goodvibes-transport-core';

type EventLike = { readonly type: string };

export interface SerializedEventEnvelope<TEvent extends EventLike = EventLike> {
  readonly type: string;
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

export interface RemoteDomainEventsOptions<TDomain extends string = string> {
  readonly onConnectionError?: (error: Error, domain: TDomain) => void;
}

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

const isExpectedDisconnectError = isAbortError;

function normalizeConnectionError(error: unknown, domain: string): Error {
  return error instanceof Error
    ? error
    : transportErrorFromUnknown(error, `Remote domain event connection for "${domain}" failed`);
}

function reportUnexpectedConnectionError<TDomain extends string>(
  error: unknown,
  domain: TDomain,
  options: RemoteDomainEventsOptions<TDomain>,
): void {
  options.onConnectionError?.(normalizeConnectionError(error, domain), domain);
}

function toEventEnvelope<TEvent extends EventLike>(
  envelope: SerializedEventEnvelope<TEvent>,
): EventEnvelope<string, TEvent> {
  return {
    type: envelope.type,
    ts: typeof envelope.ts === 'number' ? envelope.ts : Date.now(),
    traceId: typeof envelope.traceId === 'string' ? envelope.traceId : undefined,
    sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : undefined,
    source: typeof envelope.source === 'string' ? envelope.source : undefined,
    payload: envelope.payload,
  };
}

function createRemoteDomainEventFeed<
  TDomain extends string,
  TEvent extends EventLike,
>(
  domain: TDomain,
  connect: DomainEventConnector<TDomain, TEvent>,
  options: RemoteDomainEventsOptions<TDomain>,
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
        reportUnexpectedConnectionError(error, domain, options);
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
  options: RemoteDomainEventsOptions<TDomain> = {},
): DomainEvents<TDomain, TEvent> {
  return createRuntimeEventFeeds(
    domains,
    (domain) => createRemoteDomainEventFeed(domain, connect, options),
  );
}

/**
 * Wraps an existing {@link RuntimeEventFeed} and returns a filtered feed whose
 * callbacks only fire for envelopes whose `sessionId` matches the given value.
 *
 * Unsubscribe handles returned by `on` / `onEnvelope` on the filtered feed
 * correctly remove the underlying listener from the original feed.
 *
 * MIN-16: Uses a single shared envelope listener per event type so that N
 * subscribers for the same (feed, sessionId, type) triple consume only one
 * envelope-listener slot on the underlying feed instead of N.
 */
function createFilteredFeed<TEvent extends EventLike>(
  feed: RuntimeEventFeed<TEvent>,
  sessionId: string,
): RuntimeEventFeed<TEvent> {
  // Shared listeners: one envelope-level subscription per event type.
  const sharedByType = new Map<string, {
    readonly unsub: () => void;
    readonly payloadListeners: Set<(payload: TEvent) => void>;
    readonly envelopeListeners: Set<(envelope: EventEnvelope<string, TEvent>) => void>;
  }>();

  function getOrCreateShared(type: string) {
    const existing = sharedByType.get(type);
    if (existing) return existing;
    const payloadListeners = new Set<(payload: TEvent) => void>();
    const envelopeListeners = new Set<(envelope: EventEnvelope<string, TEvent>) => void>();
    const unsub = feed.onEnvelope(type as TEvent['type'], (envelope) => {
      if (envelope.sessionId !== sessionId) return;
      for (const pl of payloadListeners) pl(envelope.payload as TEvent);
      for (const el of envelopeListeners) el(envelope as EventEnvelope<string, TEvent>);
    });
    const shared = { unsub, payloadListeners, envelopeListeners };
    sharedByType.set(type, shared);
    return shared;
  }

  function removeSharedIfEmpty(type: string) {
    const shared = sharedByType.get(type);
    if (!shared) return;
    if (shared.payloadListeners.size === 0 && shared.envelopeListeners.size === 0) {
      shared.unsub();
      sharedByType.delete(type);
    }
  }

  return {
    on<TType extends TEvent['type']>(
      type: TType,
      listener: (payload: Extract<TEvent, { type: TType }>) => void,
    ): () => void {
      const shared = getOrCreateShared(type);
      const typedListener = listener as (payload: TEvent) => void;
      shared.payloadListeners.add(typedListener);
      return () => {
        shared.payloadListeners.delete(typedListener);
        removeSharedIfEmpty(type);
      };
    },
    onEnvelope<TType extends TEvent['type']>(
      type: TType,
      listener: (envelope: EventEnvelope<TType, Extract<TEvent, { type: TType }>>) => void,
    ): () => void {
      const shared = getOrCreateShared(type);
      const typedListener = listener as (envelope: EventEnvelope<string, TEvent>) => void;
      shared.envelopeListeners.add(typedListener);
      return () => {
        shared.envelopeListeners.delete(typedListener);
        removeSharedIfEmpty(type);
      };
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
