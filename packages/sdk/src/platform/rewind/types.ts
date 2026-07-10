/**
 * types.ts — shapes for the unified message-anchored rewind service.
 *
 * Rewind JOINS the platform's three existing history systems — it never adds a
 * fourth. Given a session turn anchor it can restore the filesystem (the
 * nearest workspace checkpoint), the conversation (truncate session state to
 * the anchor), or both, by reusing those stores through the ports below.
 */
import type { WorkspaceEvent } from '../../events/workspace.js';

/** What a rewind restores. */
export type RewindScope = 'files' | 'conversation' | 'both';

/**
 * The point to rewind to. `sessionId` is the shared join key stamped on
 * workspace checkpoints; `turnId` names the turn boundary. With no turnId the
 * rewind targets the session's most recent checkpoint.
 */
export interface RewindAnchor {
  readonly sessionId: string;
  readonly turnId?: string | undefined;
}

// ── Ports over the existing stores ──────────────────────────────────────────

/** A workspace checkpoint as the rewind coordinator needs to see it. */
export interface RewindCheckpointView {
  readonly id: string;
  readonly turnId?: string | undefined;
  readonly createdAt: number;
  readonly label: string;
}

/** The outcome of a workspace checkpoint restore, as rewind needs it. */
export interface RewindRestoreResult {
  readonly checkpointId: string;
  /** The pre-restore safety checkpoint — the undo point that makes the rewind reversible. */
  readonly safetyCheckpointId: string | null;
  readonly restoredFiles: readonly string[];
  readonly removedFiles: readonly string[];
}

/** A checkpoint diff, as rewind's dry-run preview needs it. */
export interface RewindCheckpointDiff {
  readonly files: readonly string[];
}

/**
 * The workspace-checkpoint store port. The real WorkspaceCheckpointManager
 * satisfies this (list / diff / restore) — rewind reuses it, never a new store.
 */
export interface RewindWorkspacePort {
  list(filter?: { readonly sessionId?: string | undefined }): Promise<readonly RewindCheckpointView[]>;
  diff(id: string): Promise<RewindCheckpointDiff>;
  restore(
    id: string,
    opts?: { readonly safetyCheckpoint?: boolean | undefined },
  ): Promise<RewindRestoreResult>;
}

/** Conversation dry-run preview: how much of the session would be truncated. */
export interface RewindConversationPreview {
  readonly messagesToDrop: number;
  readonly messagesRemaining: number;
}

/** Conversation rewind outcome, carrying the undo handle for redo. */
export interface RewindConversationOutcome {
  readonly droppedMessages: number;
  /** Opaque handle to the captured pre-rewind conversation, for restore-the-restore. */
  readonly undoSnapshotId: string;
}

/**
 * The conversation store port. Wired by an in-process consumer that hosts a
 * mutable conversation (e.g. a ConversationManager). Absent → conversation
 * rewind is honestly reported unavailable rather than faked.
 */
export interface RewindConversationPort {
  preview(anchor: RewindAnchor): Promise<RewindConversationPreview>;
  rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome>;
}

/** Sink for rewind receipt events (adapted onto the RuntimeEventBus by the registrar). */
export type RewindEventSink = (event: WorkspaceEvent, sessionId: string) => void;

// ── Plan / receipt payloads (the operator IO) ───────────────────────────────

export interface RewindPlanFiles {
  readonly available: boolean;
  readonly checkpointId: string | null;
  readonly checkpointLabel: string | null;
  readonly affectedFileCount: number;
}

export interface RewindPlanConversation {
  readonly available: boolean;
  readonly messagesToDrop: number;
  readonly messagesRemaining: number;
}

/** The dry-run preview of exactly what a rewind would change, plus a confirm token. */
export interface RewindPlan {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly scope: RewindScope;
  readonly token: string;
  readonly expiresAt: number;
  readonly files: RewindPlanFiles | null;
  readonly conversation: RewindPlanConversation | null;
  readonly warnings: readonly string[];
}

export interface RewindReceiptFiles {
  readonly restored: boolean;
  readonly checkpointId: string | null;
  /** The undo point recorded before restoring; restore this to reverse the rewind. */
  readonly safetyCheckpointId: string | null;
  readonly restoredFileCount: number;
  readonly removedFileCount: number;
}

export interface RewindReceiptConversation {
  readonly rewound: boolean;
  readonly droppedMessages: number;
  readonly undoSnapshotId: string | null;
}

/** How to reverse a rewind (the symmetric-redo handles the apply recorded). */
export interface RewindUndo {
  readonly files: { readonly restoreCheckpointId: string } | null;
  readonly conversation: { readonly undoSnapshotId: string } | null;
}

/** The receipt of an applied rewind — visible, and reversible via `undo`. */
export interface RewindReceipt {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly scope: RewindScope;
  readonly appliedAt: number;
  readonly files: RewindReceiptFiles | null;
  readonly conversation: RewindReceiptConversation | null;
  readonly undo: RewindUndo;
  readonly warnings: readonly string[];
}

/** A refusal returned (not thrown) when apply is called without confirmation. */
export interface RewindRefusal {
  readonly reason: string;
  readonly confirmField: string;
  readonly planMethod: string;
  readonly options: readonly string[];
}

/** rewind.apply result: exactly one of `receipt` / `refusal` is non-null. */
export interface RewindApplyResult {
  readonly receipt: RewindReceipt | null;
  readonly refused: boolean;
  readonly refusal: RewindRefusal | null;
}
