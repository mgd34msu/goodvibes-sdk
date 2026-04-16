/**
 * conversation-message.ts
 *
 * Shared envelope types for conversation messages flowing through the
 * control-plane gateway. All consumers — SSE companion-chat streams,
 * TUI-surface follow-up listeners, and web-UI clients — depend on this
 * stable shape.
 */

/**
 * Provenance of a message/event flowing through a conversation.
 * Used both for chat-mode (where the SDK owns the ConversationManager)
 * and for companion follow-ups (where the TUI client owns it cross-process).
 */
export type MessageSource =
  | 'operator'              // human typed in the TUI prompt
  | 'companion-chat-user'   // companion sent a message in its own chat session
  | 'companion-chat-assistant'  // orchestrator replied in a companion chat session
  | 'companion-followup'    // companion injected into operator's live conversation
  | 'system'                // system-generated (tool output, hook, etc.)
  | 'tool';                 // tool-call result

/**
 * Stable envelope shape for any conversation-message-related event published
 * through the control-plane gateway. All consumers (SSE companion chat stream,
 * TUI surface follow-up listener, web-UI clients) can depend on this shape.
 */
export interface ConversationMessageEnvelope {
  readonly sessionId: string;
  readonly messageId: string;
  readonly body: string;
  readonly source: MessageSource;
  readonly timestamp: number;
  /** Optional metadata for tool info, model id, etc. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}
