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
 * live client (`LiveControlPlaneClient.domains`) — null when the client did NOT
 * opt into narrowing (deliver-all, matching live), a `Set` when it did. Do NOT
 * derive this from `options.domains` here: by the time options reaches this
 * function it has already been normalized (empty/undefined domains fall back to
 * DEFAULT_DOMAINS, which excludes e.g. 'permissions'), so re-deriving from it
 * would always look "explicit" and silently narrow every default consumer's
 * replay — the bug this parameter exists to prevent.
 */
export function replayRecentTraffic(
  recentEvents: readonly ScopedControlPlaneRecentEvent[],
  send: (event: string, payload: unknown, id?: string) => void,
  options: ControlPlaneReplayClientOptions,
  replayDomains: ReadonlySet<RuntimeEventDomain> | null,
  sinceId?: string,
): void {
  const sinceIndex = sinceId ? recentEvents.findIndex((event) => event.id === sinceId) : -1;
  const window = sinceIndex >= 0
    ? recentEvents.slice(0, sinceIndex).reverse()
    : recentEvents.slice(0, 20).reverse();
  for (const recentEvent of window) {
    if (!canReplayEventToClient(recentEvent, options)) continue;
    if (!clientMayReceiveEventDomain(replayDomains, recentEvent.event)) continue;
    send(recentEvent.event, recentEvent.payload, recentEvent.id);
  }
}
