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
  readonly mode: 'spawn' | 'continued-live' | 'queued-follow-up' | 'rejected';
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
}
