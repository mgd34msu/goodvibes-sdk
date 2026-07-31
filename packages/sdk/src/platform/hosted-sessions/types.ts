/**
 * types.ts — the vocabulary of a daemon-hosted session.
 *
 * A hosted session is a conversation whose loop runs INSIDE the daemon process
 * rather than inside the client that started it. That is the whole difference:
 * the same orchestrator, the same tool registry, the same permission manager a
 * terminal runs — composed on the other side of the wire, so the conversation
 * does not end when the client that opened it goes away.
 *
 * Whether it actually survives that departure is a POLICY, not a property of
 * the engine, and the policy's default is that it does not: users already
 * expect closing a client to end its work, and the capability landing must not
 * silently change what a familiar action does. See {@link HostedDetachPolicy}.
 */

/**
 * What happens to a hosted session when the last attached client detaches.
 *
 * - `kill` — the session is terminated with the reason `detached`. This is the
 *   DEFAULT, and it is the behavior every surface has always had.
 * - `survive` — the session stays alive, idle, and reattachable; a later
 *   `sessions.hosted.attach` resumes it with its history.
 *
 * The effective policy for a session is its own override when it was created
 * with one, and the `hostedSessions.detachPolicy` setting otherwise.
 */
export type HostedDetachPolicy = 'kill' | 'survive';

/** Where a hosted session is in its life. */
export type HostedSessionStatus =
  /** Composed and reattachable; no turn is running. */
  | 'idle'
  /** A turn is in flight. */
  | 'running'
  /** Over. `terminatedReason` says why, and it is never empty. */
  | 'terminated';

/**
 * Why a hosted session ended.
 *
 * Every terminal transition carries one of these. A session that vanished for a
 * reason nobody recorded is the failure mode the durability treatment exists to
 * remove — a restart that cannot resume a session reports `restart-unresumable`
 * rather than quietly dropping the record.
 */
export type HostedSessionTerminationReason =
  /** The last client detached and the effective policy was `kill`. */
  | 'detached'
  /** An explicit `sessions.hosted.kill`. */
  | 'killed'
  /** The daemon shut down while hosting it. */
  | 'daemon-shutdown'
  /** Restored from disk after a restart, but its composition could not be rebuilt. */
  | 'restart-unresumable'
  /** Swept: terminated long enough ago that its record was retired. */
  | 'retired'
  /** The engine refused to keep it: a bound was exceeded or its workspace went away. */
  | 'evicted';

/**
 * The record a client sees. Everything here is the daemon's own observation of
 * the session; nothing is a claim the client made about it.
 */
export interface HostedSessionRecord {
  readonly id: string;
  /** The absolute workspace root this session's tools operate in. */
  readonly workspaceRoot: string;
  /** A short human label, from the first user message when none was given. */
  readonly title: string;
  readonly status: HostedSessionStatus;
  /**
   * The per-session detach override, or `null` when the session follows the
   * `hostedSessions.detachPolicy` setting. Null is the normal case.
   */
  readonly detachPolicy: HostedDetachPolicy | null;
  /** The policy that WOULD apply right now — the override, else the setting. */
  readonly effectiveDetachPolicy: HostedDetachPolicy;
  /** Client ids currently attached. A session with none is not necessarily dead. */
  readonly attachedClients: readonly string[];
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Turns completed, errored or cancelled — every turn that ran. */
  readonly turnCount: number;
  /** Messages in the conversation, including the ones restored from disk. */
  readonly messageCount: number;
  readonly lastTurnAt?: number | undefined;
  readonly terminatedAt?: number | undefined;
  readonly terminatedReason?: HostedSessionTerminationReason | undefined;
  /**
   * True when this record came back from disk after a daemon restart and its
   * loop has not been rebuilt yet. It is reattachable; the rebuild happens on
   * the first attach or turn.
   */
  readonly restoredFromDisk: boolean;
}

/** One message of a hosted session's history, as a client renders it. */
export interface HostedSessionHistoryMessage {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly at?: number | undefined;
}

/** The lifecycle transitions published on the hosted-session event channel. */
export type HostedSessionLifecycleEvent =
  | 'hosted-session-created'
  | 'hosted-session-attached'
  | 'hosted-session-detached'
  | 'hosted-session-turn-started'
  | 'hosted-session-turn-ended'
  | 'hosted-session-terminated'
  | 'hosted-session-restored';

/** The payload of every hosted-session lifecycle notice. */
export interface HostedSessionUpdatePayload {
  readonly event: HostedSessionLifecycleEvent;
  readonly session: HostedSessionRecord;
  readonly createdAt: number;
  /**
   * Which client the transition is about, for attach/detach. Absent for
   * transitions that are not about one client.
   */
  readonly clientId?: string | undefined;
  /** Free-text detail: the termination reason, the turn outcome, the restore verdict. */
  readonly detail?: string | undefined;
}

/** What `sessions.hosted.create` was asked for. */
export interface CreateHostedSessionInput {
  /** Absolute path. A relative one is refused rather than resolved against the daemon's cwd. */
  readonly workspaceRoot: string;
  readonly title?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  /** Sent as the first user message once the session is composed. */
  readonly initialPrompt?: string | undefined;
  /** Per-session override of the detach policy. Omitted ⇒ follow the setting. */
  readonly detachPolicy?: HostedDetachPolicy | undefined;
  /** The client creating it, attached immediately when given. */
  readonly clientId?: string | undefined;
}
