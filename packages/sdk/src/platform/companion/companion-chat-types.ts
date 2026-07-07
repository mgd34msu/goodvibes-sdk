/**
 * companion-chat-types.ts
 *
 * Types for companion-app chat-mode sessions. These are distinct from the
 * TUI operator session and from task-submit (SharedSessionBroker) sessions.
 * Chat sessions are managed by the CompanionChatManager and persisted to disk
 * via CompanionChatPersistence so they survive daemon restarts.
 */

import type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';
import type { ArtifactDescriptor } from '../artifacts/index.js';

/**
 * Re-export the shared envelope so chat-mode code can import from one place.
 * The envelope shape is the canonical message unit flowing through
 * the control-plane gateway across both chat-mode and Problem-2 routing.
 */
export type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';

export type CompanionChatSessionKind = 'companion-chat';

export type CompanionChatSessionStatus = 'active' | 'closed';

export type CompanionChatMessageRole = 'user' | 'assistant';

export interface CompanionChatMessageAttachmentInput {
  readonly artifactId: string;
  readonly label?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface CompanionChatMessageAttachment extends ArtifactDescriptor {
  readonly artifactId: string;
  readonly label?: string | undefined;
}

/**
 * Why a message was superseded. A superseded message is NEVER deleted — it is
 * retained in the message list and on disk, flagged so a client can tell the
 * active conversation chain from the retained history behind a regenerate or an
 * edit. This is the honest-lineage contract: regenerating a response or editing
 * a message forks the conversation and keeps the old branch retrievable, it does
 * not silently drop it.
 *
 * - `regenerate` — the assistant response was re-run; this is the previous
 *   response (and any turns that followed it), kept as history.
 * - `edit` — the user edited an earlier message and the conversation branched
 *   from there; this is the original message (or a turn after the edit point),
 *   kept as history.
 */
export type CompanionChatSupersededReason = 'regenerate' | 'edit';

export interface CompanionChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: CompanionChatMessageRole;
  readonly content: string;
  readonly attachments: readonly CompanionChatMessageAttachment[];
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdAt: number;
  /**
   * Timestamp at which this message was superseded by a regenerate or an edit.
   * Absent = the message is part of the active conversation chain. Present = the
   * message is retained history behind a fork (still returned by list/get, never
   * removed), so nothing is silently lost.
   */
  readonly supersededAt?: number | undefined;
  /** Why this message was superseded (only set together with `supersededAt`). */
  readonly supersededReason?: CompanionChatSupersededReason | undefined;
  /**
   * On a replacement message, the id of the message it replaces: the new user
   * message points back at the original it was edited from, giving an explicit
   * forward lineage link in addition to the `supersededAt` marker on the old one.
   */
  readonly revisionOf?: string | undefined;
  /**
   * Delivery honesty marker; absent = a normally delivered message.
   * - `'cancelled'` (assistant): the turn was stopped mid-generation
   *   (companion.chat.turns.cancel, a session close, or daemon shutdown) —
   *   the content is the honest partial that existed when the stop landed.
   *   Clients must badge this so a partial never masquerades as a finished
   *   answer.
   * - `'queued'` (user): the message is in the transcript but its LLM turn
   *   has not started yet (posted while another turn was running). Cleared
   *   when its turn starts; a session closed first leaves the marker as the
   *   honest record that the message was never answered.
   */
  readonly deliveryState?: 'cancelled' | 'queued' | undefined;
  /**
   * On an assistant message: the id of the user message this reply answers.
   * The transcript is append-ordered, so with queued sends a reply can land
   * AFTER a later user message — this link lets clients pair prompt and
   * reply honestly regardless of position.
   */
  readonly inReplyTo?: string | undefined;
}

export interface CompanionChatSession {
  readonly id: string;
  readonly kind: CompanionChatSessionKind;
  readonly title: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly systemPrompt: string | null;
  readonly status: CompanionChatSessionStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly messageCount: number;
}

// ---------------------------------------------------------------------------
// HTTP I/O shapes
// ---------------------------------------------------------------------------

export interface CreateCompanionChatSessionInput {
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly systemPrompt?: string | undefined;
}

export interface ListCompanionChatSessionsInput {
  readonly includeClosed?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface UpdateCompanionChatSessionInput {
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly systemPrompt?: string | null | undefined;
}

export interface CreateCompanionChatSessionOutput {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly session: CompanionChatSession;
}

export interface ListCompanionChatSessionsOutput {
  readonly sessions: readonly CompanionChatSession[];
  readonly totals: {
    readonly sessions: number;
    readonly active: number;
    readonly closed: number;
  };
}

export interface UpdateCompanionChatSessionOutput {
  readonly session: CompanionChatSession;
}

export interface PostCompanionChatMessageInput {
  readonly content: string;
  readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface PostCompanionChatMessageOutput {
  readonly messageId: string;
}

export interface GetCompanionChatSessionOutput {
  readonly session: CompanionChatSession;
  readonly messages: CompanionChatMessage[];
}

// ---------------------------------------------------------------------------
// Regenerate / edit-and-branch I/O shapes (honest lineage)
// ---------------------------------------------------------------------------

export interface RegenerateCompanionChatMessageInput {
  /**
   * The assistant message to regenerate. Omit to regenerate the latest assistant
   * response. The referenced message and any messages after it are superseded
   * (retained as history), then a fresh turn re-runs from the preceding user
   * message.
   */
  readonly messageId?: string | undefined;
}

export interface RegenerateCompanionChatMessageOutput {
  readonly sessionId: string;
  /** The assistant message id whose turn was re-run (now superseded, still retrievable). */
  readonly regeneratedFrom: string;
  /** Every message id superseded by this regenerate — retained history, never deleted. */
  readonly supersededMessageIds: readonly string[];
  /** True when a new turn was started to produce the replacement response. */
  readonly turnStarted: boolean;
}

export interface EditCompanionChatMessageInput {
  /** The user message to edit and branch from. Required. */
  readonly messageId: string;
  /** The edited message text. Required (unless attachments carry the content). */
  readonly content: string;
  readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface EditCompanionChatMessageOutput {
  readonly sessionId: string;
  /** The original user message id that was edited (now superseded, still retrievable). */
  readonly editedFrom: string;
  /** The id of the new user message carrying the edited content. */
  readonly messageId: string;
  /** Every message id superseded by this edit — retained history, never deleted. */
  readonly supersededMessageIds: readonly string[];
  /** True when a new turn was started to answer the edited message. */
  readonly turnStarted: boolean;
}

export interface CancelCompanionChatTurnInput {
  /**
   * Optional guard: when provided and it is NOT the currently active turn,
   * the cancel is refused (409 TURN_MISMATCH) instead of cancelling a newer
   * turn a stale stop click raced against. Omitted, THE active turn for the
   * session is cancelled — required for stops issued before the client has
   * received `turn.started` (which is what delivers the turn id).
   */
  readonly turnId?: string | undefined;
}

export interface SteerCompanionChatMessageOutput {
  readonly sessionId: string;
  readonly messageId: string;
  readonly steered: true;
  /** The turn that was cancelled to make way, when one was running. */
  readonly cancelledTurnId?: string | undefined;
  readonly turnStarted: boolean;
}

export interface CancelCompanionChatTurnOutput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cancelled: true;
  /** True when this turn had already been cancelled — repeat cancels are idempotent. */
  readonly alreadyCancelled?: boolean | undefined;
  /**
   * True when the non-empty partial reply was persisted by the time this
   * response was written. When the provider is slow to release the aborted
   * stream this can be false here while the terminal `turn.cancelled` event
   * (the authoritative signal) still reports the persisted partial.
   */
  readonly partialPersisted: boolean;
}

// ---------------------------------------------------------------------------
// SSE event payloads emitted on the companion-chat event stream
// ---------------------------------------------------------------------------

export interface CompanionChatTurnStartedEvent {
  readonly type: 'turn.started';
  readonly sessionId: string;
  readonly messageId: string;
  readonly turnId: string;
  /** Shared envelope for the user message that started this turn. */
  readonly envelope: ConversationMessageEnvelope;
}

export interface CompanionChatTurnDeltaEvent {
  readonly type: 'turn.delta';
  readonly sessionId: string;
  readonly turnId: string;
  readonly delta: string;
}

export interface CompanionChatTurnToolCallEvent {
  readonly type: 'turn.tool_call';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

export interface CompanionChatTurnToolResultEvent {
  readonly type: 'turn.tool_result';
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: unknown;
  readonly isError: boolean;
}

export interface CompanionChatTurnCompletedEvent {
  readonly type: 'turn.completed';
  readonly sessionId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  /** Shared envelope for the assistant message produced by this turn. */
  readonly envelope: ConversationMessageEnvelope;
}

export interface CompanionChatTurnErrorEvent {
  readonly type: 'turn.error';
  readonly sessionId: string;
  readonly turnId: string;
  readonly error: string;
}

/** Who stopped a cancelled turn. */
export type CompanionChatTurnStoppedBy = 'user' | 'session-closed' | 'shutdown';

/**
 * Terminal event for a cancelled turn. Emitted to EVERY subscriber of the
 * session's event stream — this is what makes a stop issued from one client
 * converge on all others (a phone that stops a turn ends the spinner on the
 * desktop too). Exactly one terminal event ends a turn: `turn.completed`,
 * `turn.error`, or this. Any `turn.tool_call` without a matching
 * `turn.tool_result` is closed with a synthetic error result BEFORE this event
 * is published, so no client is left rendering a wedged tool block.
 */
export interface CompanionChatTurnCancelledEvent {
  readonly type: 'turn.cancelled';
  readonly sessionId: string;
  readonly turnId: string;
  readonly stoppedBy: CompanionChatTurnStoppedBy;
  /** True when a non-empty partial reply was persisted to the transcript. */
  readonly partialPersisted: boolean;
  /** Present only when a partial was persisted. */
  readonly assistantMessageId?: string | undefined;
  /**
   * Present only when a partial was persisted — same envelope shape and keys
   * as `turn.completed`, so clients render the partial through the exact code
   * path that renders a completed reply.
   */
  readonly envelope?: ConversationMessageEnvelope | undefined;
}

export type CompanionChatTurnEvent =
  | CompanionChatTurnStartedEvent
  | CompanionChatTurnDeltaEvent
  | CompanionChatTurnToolCallEvent
  | CompanionChatTurnToolResultEvent
  | CompanionChatTurnCompletedEvent
  | CompanionChatTurnErrorEvent
  | CompanionChatTurnCancelledEvent;
