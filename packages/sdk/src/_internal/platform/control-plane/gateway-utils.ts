import type { ControlPlaneClientRecord } from '../runtime/store/domains/control-plane.js';
import type { AnyRuntimeEvent, RuntimeEventDomain, RuntimeEventEnvelope } from '../runtime/events/index.js';
import { isRuntimeEventDomain } from '../runtime/events/index.js';
import type { ControlPlaneClientDescriptor } from './types.js';
import type { ControlPlaneServerConfig } from './types.js';

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
  readonly clientKind?: string;
  readonly clientId?: string;
  readonly routeId?: string;
  readonly surfaceId?: string;
  readonly domains?: readonly RuntimeEventDomain[];
}

export interface ControlPlaneRecentEvent {
  readonly id: string;
  readonly event: string;
  readonly createdAt: number;
  readonly payload: unknown;
}

export interface ScopedControlPlaneRecentEvent extends ControlPlaneRecentEvent {
  readonly replayScope?: ControlPlaneEventReplayScope;
}

export interface ControlPlaneReplayClientOptions {
  readonly clientId?: string;
  readonly clientKind?: string;
  readonly domains?: readonly RuntimeEventDomain[];
  readonly routeId?: string;
  readonly surfaceId?: string;
}

const DISCONNECTED_CLIENT_TTL_MS = 30 * 60 * 1000;
const MAX_DISCONNECTED_CLIENTS = 200;

export function serializeEnvelope(envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): Record<string, unknown> {
  return {
    type: envelope.type,
    timestamp: envelope.ts,
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
