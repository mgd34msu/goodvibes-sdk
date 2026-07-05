import { randomUUID } from 'node:crypto';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type {
  CreateSharedSessionInput,
  ParticipantRouteAttachInput,
  RegisterSharedSessionInput,
  SharedSessionCloseReason,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionRegisterResult,
} from './session-types.js';
import { dedupeSessionSurfaceKinds } from './session-broker-helpers.js';
import { upsertSessionParticipant } from './session-broker-state.js';

export const RESERVED_SHARED_SESSION_IDS = new Set(['', 'system']);

/**
 * Metadata key under which a closed session records WHY it was closed. Kept in
 * `metadata` (not a first-class field) so it rides the wire without a schema
 * change and 0.38 readers ignore it. See {@link SharedSessionCloseReason}.
 */
export const SESSION_CLOSE_REASON_METADATA_KEY = 'closeReason';

/** Read the close reason off a record's metadata, or undefined when unset/unknown. */
export function readSessionCloseReason(session: SharedSessionRecord): SharedSessionCloseReason | undefined {
  const raw = session.metadata?.[SESSION_CLOSE_REASON_METADATA_KEY];
  return raw === 'idle-reaped' || raw === 'user' || raw === 'surface' ? raw : undefined;
}

/** Stamp a close reason onto a metadata bag (returns a new object). */
export function withSessionCloseReason(
  metadata: Record<string, unknown>,
  reason: SharedSessionCloseReason,
): Record<string, unknown> {
  return { ...metadata, [SESSION_CLOSE_REASON_METADATA_KEY]: reason };
}

/** Strip any close reason from a metadata bag (returns a new object only if needed). */
export function withoutSessionCloseReason(metadata: Record<string, unknown>): Record<string, unknown> {
  if (!(SESSION_CLOSE_REASON_METADATA_KEY in metadata)) return metadata;
  const next = { ...metadata };
  delete next[SESSION_CLOSE_REASON_METADATA_KEY];
  return next;
}

/**
 * Metadata flag marking a session as SURFACE-MANAGED: a spine-registered surface
 * (via `sessions.register`) owns turn execution and input collection for it. Set
 * on every register/heartbeat. Steer/follow-up inputs to such a session (when no
 * daemon agent is live) route to the surface as a queued input the surface
 * collects — NOT a daemon executor spawn. Kept in metadata (open record) so it
 * needs no schema change. Daemon-run origins (companion-task/automation, or a
 * plain /task session) never call register and stay executor-routed.
 */
export const SESSION_SURFACE_MANAGED_METADATA_KEY = 'surfaceManaged';

/** How recently a participant must have been seen to count as a LIVE surface for
 * steer/follow-up routing. A surface heartbeats via `sessions.register`; if the
 * newest heartbeat is older than this, the surface is treated as gone and inputs
 * fall back to the daemon executor path. */
export const SURFACE_ROUTE_FRESHNESS_MS = 2 * 60 * 1000;

export function isSurfaceManagedSession(session: SharedSessionRecord): boolean {
  return session.metadata?.[SESSION_SURFACE_MANAGED_METADATA_KEY] === true;
}

/**
 * True when a participant OTHER than `exclude` (the current input's own surface)
 * was seen within `freshnessMs`. Excluding the sender prevents a steer's own
 * just-attached participant from making a surfaceless session look live.
 */
export function hasFreshSurfaceParticipant(
  session: SharedSessionRecord,
  now: number,
  freshnessMs: number,
  exclude?: { readonly surfaceId?: string | undefined },
): boolean {
  return session.participants.some((participant) => {
    if (exclude?.surfaceId && participant.surfaceId === exclude.surfaceId) return false;
    return now - participant.lastSeenAt < freshnessMs;
  });
}

/** Steer/follow-up to this session should route to a live surface (queue-for-surface)
 * rather than spawn a daemon executor. */
export function shouldRouteInputToSurface(
  session: SharedSessionRecord,
  now: number,
  freshnessMs: number,
  exclude?: { readonly surfaceId?: string | undefined },
): boolean {
  return isSurfaceManagedSession(session) && hasFreshSurfaceParticipant(session, now, freshnessMs, exclude);
}

export interface CreateSharedSessionRecordInput {
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routeBinding?: AutomationRouteBinding | undefined;
  readonly participant?: SharedSessionParticipant | undefined;
  readonly kind?: SharedSessionRecord['kind'] | undefined;
  readonly project?: string | undefined;
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
    project: input.project?.trim() || 'unknown',
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

/**
 * Shape a participant triple into the attach-input the broker's
 * participant/route merge expects. Used by `register` so a heartbeat re-attaches
 * the participant (advancing `lastSeenAt`) without carrying a message body.
 */
/** The broker operations {@link registerSharedSession} needs, injected so the
 * register control-flow lives here instead of bloating the broker class. */
export interface RegisterBrokerOps {
  getSession(id: string): SharedSessionRecord | null;
  createSession(input: CreateSharedSessionInput): Promise<SharedSessionRecord>;
  reopenSession(id: string): Promise<SharedSessionRecord | null>;
  attachParticipant(session: SharedSessionRecord, attach: ParticipantRouteAttachInput): Promise<SharedSessionRecord>;
}

/**
 * The idempotent register/heartbeat control-flow with HONEST closed semantics:
 * a brand-new id is created; an existing OPEN id adopts the participant; an
 * existing CLOSED id records the heartbeat but stays closed (returning a conflict
 * marker) UNLESS `reopen: true` is passed. A titled session is never renamed by
 * the heartbeat (that rule lives in {@link attachSharedSessionParticipantAndRoute}).
 */
export async function registerSharedSession(
  ops: RegisterBrokerOps,
  input: RegisterSharedSessionInput,
): Promise<SharedSessionRegisterResult> {
  const existing = ops.getSession(input.sessionId);
  if (!existing) {
    const created = await ops.createSession({
      id: input.sessionId,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.project !== undefined ? { project: input.project } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      participant: input.participant,
    });
    return { record: created, reopened: false };
  }
  const attach = participantToAttachInput(input.participant, input.title);
  if (existing.status === 'closed') {
    // Reopen honesty: a session the SYSTEM reaper closed ('idle-reaped') reopens
    // automatically on the next participant heartbeat — the surface never
    // deliberately closed it, so re-registering is not a conflict. An explicit
    // 'user'/'surface' close stays closed (honest conflict) unless reopen:true.
    const systemReaped = readSessionCloseReason(existing) === 'idle-reaped';
    if (input.reopen === true || systemReaped) {
      const reopened = (await ops.reopenSession(existing.id)) ?? existing;
      return { record: await ops.attachParticipant(reopened, attach), reopened: true };
    }
    return { record: await ops.attachParticipant(existing, attach), reopened: false, conflict: { status: 'closed' } };
  }
  return { record: await ops.attachParticipant(existing, attach), reopened: false };
}

export function participantToAttachInput(
  participant: SharedSessionParticipant,
  title?: string,
): ParticipantRouteAttachInput {
  return {
    surfaceKind: participant.surfaceKind,
    surfaceId: participant.surfaceId,
    externalId: participant.externalId,
    userId: participant.userId,
    displayName: participant.displayName,
    routeId: participant.routeId,
    ...(title ? { title } : {}),
    body: '',
  };
}

/** Close a session, recording WHY. Defaults to 'user' — the explicit close verb
 * (daemon `sessions.close`) is a deliberate user/surface action, which does NOT
 * auto-reopen on heartbeat. The reaper passes 'idle-reaped'. */
export function closeSharedSessionRecord(
  session: SharedSessionRecord,
  reason: SharedSessionCloseReason = 'user',
): SharedSessionRecord {
  const now = Date.now();
  return {
    ...session,
    status: 'closed',
    activeAgentId: undefined,
    updatedAt: now,
    closedAt: now,
    metadata: withSessionCloseReason(session.metadata, reason),
  };
}

export function reopenSharedSessionRecord(session: SharedSessionRecord): SharedSessionRecord {
  return {
    ...session,
    status: 'active',
    updatedAt: Date.now(),
    closedAt: undefined,
    // A reopened session is no longer closed-for-any-reason; clear the marker so
    // it never carries a stale close reason on the wire.
    metadata: withoutSessionCloseReason(session.metadata),
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

/**
 * True when a session title is still the auto-generated placeholder (empty or
 * `Session <id>`) and can be named by an incoming register/attach. A real,
 * user-supplied title is never overwritten by this path.
 */
export function isPlaceholderSessionTitle(title: string, id: string): boolean {
  const trimmed = title.trim();
  return trimmed.length === 0 || trimmed === `Session ${id}`;
}

/**
 * Merge a participant + optional route onto a session. This is the HEARTBEAT
 * path — it records the participant and advances lastSeenAt, but it must NOT by
 * itself change lifecycle status (a closed session stays closed; reopening is an
 * explicit verb) and must NOT overwrite a real title (only names a placeholder).
 */
export function attachSharedSessionParticipantAndRoute(input: {
  readonly session: SharedSessionRecord;
  readonly message: ParticipantRouteAttachInput;
  readonly binding?: AutomationRouteBinding | undefined;
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
  const incomingTitle = input.message.title?.trim();
  const title = incomingTitle && isPlaceholderSessionTitle(input.session.title, input.session.id)
    ? incomingTitle
    : input.session.title;
  const now = Date.now();
  return {
    ...input.session,
    title,
    // Status is intentionally preserved: the participant merge is a heartbeat and
    // cannot flip a closed session back to active. Reopening is an explicit verb.
    status: input.session.status,
    updatedAt: now,
    // A register heartbeat IS session activity: advance lastActivityAt (not only
    // the participant's lastSeenAt) so the idle-empty reaper does not close a
    // live, message-less surface session out from under a heartbeating participant.
    lastActivityAt: now,
    closedAt: input.session.closedAt,
    routeIds: nextRouteIds,
    participants,
    surfaceKinds: dedupeSessionSurfaceKinds(participants),
    metadata: {
      ...input.session.metadata,
    },
  };
}
