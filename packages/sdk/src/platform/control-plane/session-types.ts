import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { SurfaceKind } from '../../events/surfaces.js';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionRoutingIntent,
} from './session-intents.js';

export type SharedSessionStatus = 'active' | 'closed';
export type SharedSessionMessageRole = 'user' | 'assistant' | 'system';

/**
 * A session participant — the identity triple {surfaceKind, surfaceId, userId?}
 * standardized on the canonical (wide) {@link SurfaceKind}, so product surfaces
 * (agent/webui/companion) are first-class participants alongside transport
 * surfaces. `userId` is the documented identity key. This is a DIFFERENT axis
 * from {@link SharedSessionRecord.kind} (the session origin).
 */
export interface SharedSessionParticipant {
  readonly surfaceKind: SurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly routeId?: string | undefined;
  readonly lastSeenAt: number;
}

export interface SharedSessionMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: SharedSessionMessageRole;
  readonly body: string;
  readonly createdAt: number;
  readonly surfaceKind?: SurfaceKind | undefined;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/**
 * Discriminates the session ORIGIN — which product created the session. This is
 * a separate axis from {@link SharedSessionParticipant.surfaceKind} (the surface
 * a participant speaks through). Do not conflate them: a session's origin `kind`
 * is stamped once at creation; a session can have many participants across many
 * surfaces.
 * - 'tui': created by the operator TUI (default for existing/legacy sessions)
 * - 'agent': created by an agent runtime
 * - 'webui': created by the rich web client
 * - 'companion-task': created via task-submit flow (agent spawn)
 * - 'companion-chat': created via companion chat-mode API (no agent spawn; uses per-session orchestrator)
 * - 'automation': created by an automation job/run
 */
export type SharedSessionKind =
  | 'tui'
  | 'agent'
  | 'webui'
  | 'companion-task'
  | 'companion-chat'
  | 'automation';

/**
 * Why a session was closed. Drives the honest reopen-on-heartbeat rule:
 * - 'idle-reaped': the GC sweep closed an idle session. It AUTO-REOPENS on the
 *   next register heartbeat from a participant (a surface coming back to a
 *   session the SYSTEM closed underneath it is not a conflict).
 * - 'user' / 'surface': a deliberate close. It does NOT auto-reopen — register
 *   records the heartbeat and returns the still-closed record with a conflict
 *   marker unless `reopen: true` is passed (the session-spine honest-register semantics, see CHANGELOG 1.0.0).
 *
 * Carried on the record under `metadata[SESSION_CLOSE_REASON_METADATA_KEY]` so it
 * rides the wire without a schema change and old readers ignore it (metadata is
 * an open record). Absent means the session is open, or was closed by a build
 * that predates this field.
 */
export type SharedSessionCloseReason = 'idle-reaped' | 'user' | 'surface';

export interface SharedSessionRecord {
  readonly id: string;
  readonly kind: SharedSessionKind;
  /**
   * The workspace/project this session belongs to, carried as DATA on the
   * record (not encoded in the store path). Typically the absolute working
   * directory of the creating surface, or a stable project id. Legacy records
   * lacking this field are backfilled to 'unknown' on load. Home-scoped,
   * projectless surfaces (e.g. companion chat) use 'unknown'. This is what lets
   * ONE home-scoped store serve every project and every surface filter honestly.
   */
  readonly project: string;
  readonly title: string;
  readonly status: SharedSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastMessageAt?: number | undefined;
  readonly closedAt?: number | undefined;
  /**
   * Epoch ms of the most recent activity on this session.
   * Updated on every session-level mutation (createSession, bindAgent,
   * appendMessage, recordInput, updateInput, claimNextQueuedInput,
   * attachParticipantAndRoute, closeSession, completeAgent).
   * Used by the idle-session GC sweep to decide when to close ghost sessions.
   */
  readonly lastActivityAt: number;
  readonly messageCount: number;
  /**
   * How many of this session's message BODIES are actually retained in the
   * durable store, when that is fewer than {@link messageCount}. Persistence
   * caps retained bodies per session (see MAX_PERSISTED_MESSAGES_PER_SESSION);
   * when the cap prunes the oldest bodies, `messageCount` stays the honest
   * logical total and this field records how many bodies survived. Omitted when
   * nothing was pruned (retained === messageCount), so the common case carries
   * no marker. Readers must treat an absent value as "fully retained".
   */
  readonly retainedMessageCount?: number | undefined;
  readonly pendingInputCount: number;
  readonly routeIds: readonly string[];
  readonly surfaceKinds: readonly SurfaceKind[];
  readonly participants: readonly SharedSessionParticipant[];
  readonly activeAgentId?: string | undefined;
  readonly lastAgentId?: string | undefined;
  readonly lastError?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface SharedSessionSubmission {
  readonly session: SharedSessionRecord;
  readonly userMessage: SharedSessionMessage;
  readonly routeBinding?: AutomationRouteBinding | undefined;
  readonly input: SharedSessionInputRecord;
  readonly intent: SharedSessionInputIntent;
  readonly mode: 'spawn' | 'continued-live' | 'queued-follow-up' | 'queued-for-surface' | 'rejected';
  readonly state: SharedSessionInputRecord['state'];
  readonly task?: string | undefined;
  readonly activeAgentId?: string | undefined;
  readonly created: boolean;
}

export interface SubmitSharedSessionMessageInput {
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title?: string | undefined;
  readonly body: string;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routing?: SharedSessionRoutingIntent | undefined;
}

export interface SteerSharedSessionMessageInput extends SubmitSharedSessionMessageInput {
  readonly allowSpawnFallback?: boolean | undefined;
}

/**
 * The participant/route attach input consumed by the broker's participant merge.
 * Identical to a submit message minus `metadata`, but `surfaceKind` is the WIDE
 * canonical {@link SurfaceKind} so product-surface participants (agent/webui/
 * companion) — which arrive via sessions.register, not the transport submit
 * path — can be merged. Transport submit inputs (narrow surfaceKind) remain
 * assignable to this type.
 */
export type ParticipantRouteAttachInput =
  Omit<SubmitSharedSessionMessageInput, 'metadata' | 'surfaceKind'> & { readonly surfaceKind: SurfaceKind };

export interface FindSharedSessionOptions {
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly routeId?: string | undefined;
  readonly includeClosed?: boolean | undefined;
  /** Scope the search to a single project; omit for the cross-project union. */
  readonly project?: string | undefined;
}

/** Options for {@link SharedSessionBroker.listSessions}. */
export interface ListSharedSessionsOptions {
  /** Scope to a single project; omit for the cross-project union (default). */
  readonly project?: string | undefined;
  /** Filter by origin kind. */
  readonly kind?: SharedSessionKind | undefined;
  /** Include closed sessions (default: closed sessions are included). */
  readonly includeClosed?: boolean | undefined;
}

/** Input to {@link SharedSessionBroker.createSession}. */
export interface CreateSharedSessionInput {
  readonly id?: string | undefined;
  readonly kind?: SharedSessionKind | undefined;
  readonly project?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routeBinding?: AutomationRouteBinding | undefined;
  readonly participant?: SharedSessionParticipant | undefined;
}

/** Input to {@link SharedSessionBroker.ensureSession} (idempotent create-or-adopt). */
export interface EnsureSharedSessionInput {
  readonly sessionId?: string | undefined;
  readonly kind?: SharedSessionKind | undefined;
  readonly project?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routeBinding?: AutomationRouteBinding | undefined;
  readonly participant?: SharedSessionParticipant | undefined;
}

/**
 * Input to {@link SharedSessionBroker.register} — the idempotent upsert keyed on
 * a caller-supplied session id. Re-calling register with the same id is the
 * heartbeat: it advances `participant.lastSeenAt`. Carries the identity spine
 * (kind + project + participant triple) that {@link EnsureSharedSessionInput}
 * threads into the record.
 */
export interface RegisterSharedSessionInput {
  readonly sessionId: string;
  readonly kind?: SharedSessionKind | undefined;
  readonly project?: string | undefined;
  readonly title?: string | undefined;
  readonly participant: SharedSessionParticipant;
  /**
   * Explicit intent to reopen a CLOSED session. Default `false`: registering
   * against a closed id does NOT silently reopen it — it records the heartbeat
   * (participant.lastSeenAt) and returns the still-closed record with an honest
   * conflict marker. Pass `true` to reopen as part of the register.
   */
  readonly reopen?: boolean | undefined;
}

/**
 * Result of {@link SharedSessionBroker.register}. Carries the record plus honest
 * lifecycle disposition so a caller (and the wire) never has to guess whether a
 * closed session was resurrected.
 *
 * SPOOFING / TRUST NOTE: the control plane uses a single-admin-token model, so
 * cross-surface writes under the same token (e.g. two surfaces heartbeating the
 * same session id) are LEGITIMATE co-participation, not impersonation. `register`
 * merges participants freely; what it will NOT do silently is change lifecycle
 * status or rename a titled session.
 */
export interface SharedSessionRegisterResult {
  readonly record: SharedSessionRecord;
  /** True only when this call reopened a previously-closed session. */
  readonly reopened: boolean;
  /**
   * Present when register targeted a CLOSED session without `reopen: true`. The
   * record is returned as-is (still closed) with the heartbeat recorded.
   */
  readonly conflict?: { readonly status: 'closed' } | undefined;
}
