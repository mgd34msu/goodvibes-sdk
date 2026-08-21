import type { ControlPlaneClientRecord } from '../runtime/store/domains/control-plane.js';
import type { AnyRuntimeEvent, RuntimeEventDomain, RuntimeEventEnvelope } from '../runtime/events/index.js';
import { isRuntimeEventDomain } from '../runtime/events/index.js';
import type { ControlPlaneClientDescriptor } from './types.js';
import type { ControlPlaneServerConfig } from './types.js';
import { clientMayReceiveEventDomain } from './gateway-scope-enforcement.js';

export const DEFAULT_SERVER_CONFIG: ControlPlaneServerConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 3421,
  streamingMode: 'sse',
  sessionTtlMs: 12 * 60 * 60 * 1000,
};

export const DEFAULT_DOMAINS: readonly RuntimeEventDomain[] = [
  'session',
  'tasks',
  'agents',
  'automation',
  'routes',
  'control-plane',
  'deliveries',
  'surfaces',
  'watchers',
  'transport',
  'ops',
  'knowledge',
  'providers',
  'turn',
];

/**
 * What a client needs to RENDER a turn whose loop it is not running.
 *
 * `DEFAULT_DOMAINS` carries `turn`, the text deltas, the turn lifecycle, and
 * the token usage on `LLM_RESPONSE_RECEIVED`, but it does NOT carry `tools`,
 * which is where `TOOL_RECEIVED`, `TOOL_EXECUTING`, `TOOL_SUCCEEDED` and
 * `TOOL_FAILED` are emitted. A subscriber on the defaults therefore receives
 * everything the model SAID and nothing it DID: the turn renders with its tool
 * calls missing entirely, which reads as an assistant that paused for no
 * reason and then answered.
 *
 * This is `DEFAULT_DOMAINS` plus `tools`, deliberately ADDITIVE, a stream
 * moved onto it keeps every domain it already delivered and gains the tool
 * frames, so no existing consumer loses an event it was relying on.
 */
export const RENDER_GRADE_SESSION_DOMAINS: readonly RuntimeEventDomain[] = [...DEFAULT_DOMAINS, 'tools'];

/** How a control-plane stream writes one event to its client. */
type ScopedSend = (event: string, payload: unknown, id?: string) => void;

/** Live delivery and replay, filtered to one session by the same rule. */
export interface ScopedSessionDelivery {
  /** Whether a frame stamped with `envelopeSessionId` belongs on this stream. */
  mayDeliver(envelopeSessionId: string | undefined): boolean;
  /** The same decision applied to replayed traffic, which is already serialized. */
  wrapSend(send: ScopedSend): ScopedSend;
}

/**
 * Restrict a stream to ONE session's frames.
 *
 * A stream opened at a per-session path must not render another session's turn
 * into that session's transcript. The gateway's `sessionId` option alone has
 * never filtered delivery, it records which session a client is ABOUT, and
 * several streams set it while deliberately watching the whole daemon, so
 * scoping is opted into explicitly and resolved here, in one place, rather than
 * being written twice and drifting between live delivery and replay.
 *
 * Two rules:
 *
 *  - A frame carrying a DIFFERENT session's id is dropped.
 *  - A frame carrying NO session id is delivered. It makes no claim about
 *    another session, and dropping it would silently strip the daemon-wide
 *    lifecycle traffic these streams have always carried.
 *
 * `scopedSessionId` of `undefined` means no scoping: everything is delivered,
 * which is what a fleet-wide observer wants and what every stream did before.
 */
export function createScopedSessionDelivery(scopedSessionId: string | undefined): ScopedSessionDelivery {
  const mayDeliver = (envelopeSessionId: string | undefined): boolean =>
    scopedSessionId === undefined
    || envelopeSessionId === undefined
    || envelopeSessionId === scopedSessionId;
  return {
    mayDeliver,
    // Replay goes through the SAME rule as live delivery: a reconnect that
    // re-sent another session's frames would put back exactly what the live
    // filter exists to keep out.
    wrapSend: (send) => (scopedSessionId === undefined
      ? send
      : (event, payload, id): void => {
        const serialized = payload as { sessionId?: unknown } | null;
        const envelopeSessionId = serialized && typeof serialized.sessionId === 'string'
          ? serialized.sessionId
          : undefined;
        if (!mayDeliver(envelopeSessionId)) return;
        send(event, payload, id);
      }),
  };
}

export interface ControlPlaneEventReplayScope {
  readonly clientKind?: string | undefined;
  readonly clientId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
}

export interface ControlPlaneRecentEvent {
  readonly id: string;
  readonly event: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

export interface ScopedControlPlaneRecentEvent extends ControlPlaneRecentEvent {
  readonly replayScope?: ControlPlaneEventReplayScope | undefined;
}

export interface ControlPlaneReplayClientOptions {
  readonly clientId?: string | undefined;
  readonly clientKind?: string | undefined;
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceId?: string | undefined;
}

const DISCONNECTED_CLIENT_TTL_MS = 30 * 60 * 1000;
const MAX_DISCONNECTED_CLIENTS = 200;

export function serializeEnvelope(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    type: envelope.type,
    ts: envelope.ts,
    traceId: envelope.traceId,
    sessionId: envelope.sessionId,
    source: envelope.source,
    payload: envelope.payload,
  };
}

export function toClientDescriptor(record: ControlPlaneClientRecord): ControlPlaneClientDescriptor {
  return {
    id: record.id,
    surface: record.kind,
    label: record.label,
    connectedAt: record.authenticatedAt ?? record.lastSeenAt ?? Date.now(),
    lastSeenAt: record.lastSeenAt ?? Date.now(),
    ...(record.metadata.userId && typeof record.metadata.userId === 'string' ? { userId: record.metadata.userId } : {}),
  };
}

export function normalizeRuntimeDomains(domains: readonly RuntimeEventDomain[] | undefined): RuntimeEventDomain[] {
  const values = domains?.length ? domains : DEFAULT_DOMAINS;
  return [...new Set(values.filter((domain): domain is RuntimeEventDomain => isRuntimeEventDomain(domain)))];
}

export function hasReplayScope(scope: ControlPlaneEventReplayScope): boolean {
  return Boolean(
    scope.clientKind
    || scope.clientId
    || scope.routeId
    || scope.surfaceId
    || (scope.domains && scope.domains.length > 0),
  );
}

export function canReplayEventToClient(
  event: ScopedControlPlaneRecentEvent,
  options: ControlPlaneReplayClientOptions,
): boolean {
  const domains = normalizeRuntimeDomains(options.domains);
  if (isRuntimeEventDomain(event.event) && !domains.includes(event.event)) return false;

  const scope = event.replayScope;
  if (!scope) return true;

  const clientKind = options.clientKind ?? 'web';
  if (scope.clientKind && scope.clientKind !== clientKind) return false;
  if (scope.clientId && scope.clientId !== options.clientId) return false;
  if (scope.routeId && scope.routeId !== options.routeId) return false;
  if (scope.surfaceId && scope.surfaceId !== options.surfaceId) return false;
  if (scope.domains?.length && !scope.domains.some((domain) => domains.includes(domain))) return false;
  return true;
}

export function stripReplayScope(event: ScopedControlPlaneRecentEvent): ControlPlaneRecentEvent {
  return {
    id: event.id,
    event: event.event,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

export function pruneDisconnectedClientRecords(
  clients: Map<string, ControlPlaneClientRecord>,
  now = Date.now(),
): void {
  const disconnected = [...clients.values()]
    .filter((client) => !client.connected)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  for (let i = 0; i < disconnected.length; i++) {
    const client = disconnected[i]!;
    const ageMs = now - (client.lastSeenAt ?? now);
    if (ageMs <= DISCONNECTED_CLIENT_TTL_MS && i < MAX_DISCONNECTED_CLIENTS) continue;
    clients.delete(client.id);
  }
}

/**
 * Replay recent traffic to a freshly-connected client. Mirrors live delivery:
 * canReplayEventToClient applies the kind/route/surface/domain-name filters, and
 * the EVENT_DOMAIN broadcast-domain filter is applied on top so a domain-narrowed
 * client is not handed a replayed broadcast (e.g. session-update) for a domain it
 * did not subscribe to.
 *
 * `replayDomains` MUST be the same null-or-set value the caller registered on the
 * live client (`LiveControlPlaneClient.domains`), null when the client did NOT
 * opt into narrowing (deliver-all, matching live), a `Set` when it did. Do NOT
 * derive this from `options.domains` here: by the time options reaches this
 * function it has already been normalized (empty/undefined domains fall back to
 * DEFAULT_DOMAINS, which excludes e.g. 'permissions'), so re-deriving from it
 * would always look "explicit" and silently narrow every default consumer's
 * replay, the bug this parameter exists to prevent.
 */
export function replayRecentTraffic(
  recentEvents: readonly ScopedControlPlaneRecentEvent[],
  send: (event: string, payload: unknown, id?: string) => void,
  options: ControlPlaneReplayClientOptions,
  replayDomains: ReadonlySet<RuntimeEventDomain> | null,
  sinceId?: string,
): ControlPlaneReplayOutcome {
  const resolution = resolveReplayWindow(recentEvents, sinceId);
  for (const recentEvent of resolution.window) {
    if (!canReplayEventToClient(recentEvent, options)) continue;
    if (!clientMayReceiveEventDomain(replayDomains, recentEvent.event)) continue;
    send(recentEvent.event, recentEvent.payload, recentEvent.id);
  }
  return resolution.outcome;
}

/** What a client's stated stream position turned into. */
export type ControlPlaneReplayOutcome =
  /** No position was presented, the client is new, so it gets the catch-up window. */
  | { readonly resume: 'none' }
  /**
   * The position was found. `replayed` counts the records that sat after it,
   * the replay CANDIDATES. The kind/route/surface/domain filters still apply on
   * top, so a narrowed client may be sent fewer than this; the number says how
   * much history was there, not how much this particular client was owed.
   */
  | { readonly resume: 'resumed'; readonly sinceId: string; readonly replayed: number }
  /** The position was presented but is no longer in the ring; nothing was replayed. */
  | { readonly resume: 'unresolved'; readonly sinceId: string };

/**
 * Turn a presented `Last-Event-ID` into the slice of history to re-send.
 *
 * `recentEvents` is NEWEST-FIRST, so everything recorded after `sinceId` is
 * what sits in front of it, replayed oldest-first.
 *
 * The case worth being explicit about is an id we cannot find. Event ids are
 * random per record, not ordered, so an id that is not in the ring cannot be
 * compared against one that is, there is no "everything after" to compute.
 * Treating that as "the client has no position" and re-sending the whole
 * catch-up window is what poisons a live turn: the window still holds the
 * previous turn's `TURN_COMPLETED`, and a consumer that has never seen that
 * frame finishes the turn now running and drops the rest of it. A client that
 * states a position is claiming to have seen history; we either know what came
 * after it or we do not, and guessing costs a turn that was already paid for.
 * So an unresolvable position replays NOTHING, and the outcome is returned so
 * the caller can say so on the wire rather than leave the gap silent.
 */
export function resolveReplayResume(
  recentEvents: readonly ScopedControlPlaneRecentEvent[],
  sinceId: string | undefined,
): ControlPlaneReplayOutcome {
  if (!sinceId) return { resume: 'none' };
  const sinceIndex = recentEvents.findIndex((event) => event.id === sinceId);
  if (sinceIndex < 0) return { resume: 'unresolved', sinceId };
  return { resume: 'resumed', sinceId, replayed: sinceIndex };
}

function resolveReplayWindow(
  recentEvents: readonly ScopedControlPlaneRecentEvent[],
  sinceId: string | undefined,
): { readonly window: ScopedControlPlaneRecentEvent[]; readonly outcome: ControlPlaneReplayOutcome } {
  const outcome = resolveReplayResume(recentEvents, sinceId);
  if (outcome.resume === 'none') return { window: recentEvents.slice(0, 20).reverse(), outcome };
  if (outcome.resume === 'unresolved') return { window: [], outcome };
  return { window: recentEvents.slice(0, outcome.replayed).reverse(), outcome };
}
