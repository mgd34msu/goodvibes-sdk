/**
 * companion-chat-types.ts
 *
 * Types for companion-app chat-mode sessions. These are distinct from the
 * TUI operator session and from task-submit (SharedSessionBroker) sessions.
 * Chat sessions are managed by the CompanionChatManager and persisted to disk
 * via CompanionChatPersistence so they survive daemon restarts.
 */

import type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';

/**
 * Re-export the shared envelope so chat-mode code can import from one place.
 * The envelope shape is the canonical message unit flowing through
 * the control-plane gateway across both chat-mode and Problem-2 routing.
 */
export type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';

export type CompanionChatSessionKind = 'companion-chat';

export type CompanionChatSessionStatus = 'active' | 'closed';

export type CompanionChatMessageRole = 'user' | 'assistant';

export interface CompanionChatMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: CompanionChatMessageRole;
  readonly content: string;
  readonly createdAt: number;
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

export interface UpdateCompanionChatSessionInput {
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly systemPrompt?: string | null | undefined;
}

export interface CreateCompanionChatSessionOutput {
  readonly sessionId: string;
  readonly createdAt: number;
}

export interface UpdateCompanionChatSessionOutput {
  readonly session: CompanionChatSession;
}

export interface PostCompanionChatMessageInput {
  readonly content: string;
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

export type CompanionChatTurnEvent =
  | CompanionChatTurnStartedEvent
  | CompanionChatTurnDeltaEvent
  | CompanionChatTurnToolCallEvent
  | CompanionChatTurnToolResultEvent
  | CompanionChatTurnCompletedEvent
  | CompanionChatTurnErrorEvent;
