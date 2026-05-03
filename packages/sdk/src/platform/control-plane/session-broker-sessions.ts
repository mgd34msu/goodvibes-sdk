import { randomUUID } from 'node:crypto';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type {
  SharedSessionParticipant,
  SharedSessionRecord,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import { dedupeSessionSurfaceKinds } from './session-broker-helpers.js';
import { upsertSessionParticipant } from './session-broker-state.js';

export const RESERVED_SHARED_SESSION_IDS = new Set(['', 'system']);

export interface CreateSharedSessionRecordInput {
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly routeBinding?: AutomationRouteBinding;
  readonly participant?: SharedSessionParticipant;
  readonly kind?: SharedSessionRecord['kind'];
}

export function assertSharedSessionIdAllowed(id: string | undefined): void {
  if (id === undefined || !RESERVED_SHARED_SESSION_IDS.has(id)) return;
  throw Object.assign(
    new Error(`INVALID_SESSION_ID: '${id}' is a reserved session ID and cannot be assigned to a real session.`),
    { code: 'INVALID_SESSION_ID' },
  );
}

export function createSharedSessionRecord(input: CreateSharedSessionRecordInput): SharedSessionRecord {
  assertSharedSessionIdAllowed(input.id);
  const now = Date.now();
  const sessionId = input.id ?? `sess-${randomUUID().slice(0, 8)}`;
  const participant = input.participant;
  const participants = participant ? [participant] : [];
  const routeIds = input.routeBinding?.id ? [input.routeBinding.id] : [];
  return {
    id: sessionId,
    kind: input.kind ?? 'tui',
    title: input.title?.trim() || input.routeBinding?.title || `Session ${sessionId}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: undefined,
    closedAt: undefined,
    lastActivityAt: now,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds,
    surfaceKinds: participant ? [participant.surfaceKind] : input.routeBinding ? [input.routeBinding.surfaceKind] : [],
    participants,
    activeAgentId: undefined,
    lastAgentId: undefined,
    lastError: undefined,
    metadata: {
      ...(input.metadata ?? {}),
    },
  };
}

export function closeSharedSessionRecord(session: SharedSessionRecord): SharedSessionRecord {
  const now = Date.now();
  return {
    ...session,
    status: 'closed',
    activeAgentId: undefined,
    updatedAt: now,
    closedAt: now,
  };
}

export function reopenSharedSessionRecord(session: SharedSessionRecord): SharedSessionRecord {
  return {
    ...session,
    status: 'active',
    updatedAt: Date.now(),
    closedAt: undefined,
  };
}

export function bindSharedSessionAgent(session: SharedSessionRecord, agentId: string): SharedSessionRecord {
  const now = Date.now();
  return {
    ...session,
    activeAgentId: agentId,
    lastAgentId: agentId,
    updatedAt: now,
    lastActivityAt: now,
  };
}

export function attachSharedSessionParticipantAndRoute(input: {
  readonly session: SharedSessionRecord;
  readonly message: Omit<SubmitSharedSessionMessageInput, 'metadata'>;
  readonly binding?: AutomationRouteBinding;
}): SharedSessionRecord {
  const nextRouteIds = input.binding?.id
    ? [...new Set([...input.session.routeIds, input.binding.id])]
    : [...input.session.routeIds];
  const participants = upsertSessionParticipant(input.session.participants, {
    surfaceKind: input.message.surfaceKind,
    surfaceId: input.message.surfaceId,
    externalId: input.message.externalId,
    userId: input.message.userId,
    displayName: input.message.displayName,
    routeId: input.binding?.id,
    lastSeenAt: Date.now(),
  });
  return {
    ...input.session,
    title: input.message.title?.trim() || input.session.title,
    status: input.session.status === 'closed' ? 'active' : input.session.status,
    updatedAt: Date.now(),
    closedAt: input.session.status === 'closed' ? undefined : input.session.closedAt,
    routeIds: nextRouteIds,
    participants,
    surfaceKinds: dedupeSessionSurfaceKinds(participants),
    metadata: {
      ...input.session.metadata,
    },
  };
}
