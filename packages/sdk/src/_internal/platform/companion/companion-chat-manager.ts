/**
 * companion-chat-manager.ts
 *
 * In-memory manager for companion-app chat-mode sessions.
 *
 * Design:
 * - Each session owns a ConversationManager (isolated message history).
 * - When a user message is posted, the manager appends it to the conversation
 *   and runs a lightweight LLM turn using the provider registry.
 * - Streaming chunks are fanned out via ControlPlaneGateway.publishEvent
 *   with a per-session clientId filter, so they only reach the subscriber
 *   for that specific session — never the global TUI event feed.
 * - A GC sweep closes sessions that have been idle beyond the TTL.
 *
 * TODO (follow-up): persist sessions across daemon restart.
 * TODO (follow-up): rate-limiting per session / per client.
 * TODO (follow-up): tool-call execution requires ToolRegistry injection;
 *   currently tools are passed through the Orchestrator which needs the
 *   full TUI context. For v1, we provide a no-op tool registry so tool
 *   calls degrade gracefully. Proper tool support requires the daemon to
 *   inject its ToolRegistry into CompanionChatManager.
 */

import { randomUUID } from 'node:crypto';
import { ConversationManager } from '../core/conversation.js';
import type {
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatSessionStatus,
  CompanionChatTurnEvent,
  ConversationMessageEnvelope,
  CreateCompanionChatSessionInput,
} from './companion-chat-types.js';

// ---------------------------------------------------------------------------
// Minimal provider types (subset of the real ProviderRegistry interface)
// ---------------------------------------------------------------------------

export interface CompanionProviderMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface CompanionProviderChunk {
  readonly type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  readonly delta?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly error?: string;
}

export interface CompanionLLMProvider {
  /** Stream a single-turn conversation. Yields chunks. */
  chatStream(
    messages: CompanionProviderMessage[],
    options: {
      readonly systemPrompt?: string | null;
      readonly model?: string | null;
      readonly provider?: string | null;
      readonly abortSignal?: AbortSignal;
    },
  ): AsyncIterable<CompanionProviderChunk>;
}

// ---------------------------------------------------------------------------
// Event publisher interface (subset of ControlPlaneGateway)
// ---------------------------------------------------------------------------

export interface CompanionChatEventPublisher {
  publishEvent(
    event: string,
    payload: unknown,
    filter?: { clientId?: string },
  ): void;
}

// ---------------------------------------------------------------------------
// Idle GC constants (customisable for tests)
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_ACTIVE_MS = 30 * 60 * 1_000; // 30 minutes with messages
const DEFAULT_IDLE_EMPTY_MS = 5 * 60 * 1_000; // 5 minutes empty session
const GC_INTERVAL_MS = 60 * 1_000; // sweep every minute

// ---------------------------------------------------------------------------
// Internal session state (includes mutable conversation + turn queue)
// ---------------------------------------------------------------------------

interface InternalSession {
  readonly meta: CompanionChatSession;
  readonly conversation: ConversationManager;
  readonly messages: CompanionChatMessage[];
  readonly abortController: AbortController;
  lastActivityAt: number;
  // The SSE client ID for this session (set when a subscriber connects)
  subscriberClientId: string | null;
}

type MutableSessionMeta = {
  -readonly [K in keyof CompanionChatSession]: CompanionChatSession[K];
};

// ---------------------------------------------------------------------------
// CompanionChatManager
// ---------------------------------------------------------------------------

export interface CompanionChatManagerConfig {
  readonly provider: CompanionLLMProvider;
  readonly eventPublisher: CompanionChatEventPublisher;
  /** Override for tests */
  readonly idleActiveMs?: number;
  /** Override for tests */
  readonly idleEmptyMs?: number;
  /** Override for tests */
  readonly gcIntervalMs?: number;
}

export class CompanionChatManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly provider: CompanionLLMProvider;
  private readonly eventPublisher: CompanionChatEventPublisher;
  private readonly idleActiveMs: number;
  private readonly idleEmptyMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CompanionChatManagerConfig) {
    this.provider = config.provider;
    this.eventPublisher = config.eventPublisher;
    this.idleActiveMs = config.idleActiveMs ?? DEFAULT_IDLE_ACTIVE_MS;
    this.idleEmptyMs = config.idleEmptyMs ?? DEFAULT_IDLE_EMPTY_MS;

    const gcIntervalMs = config.gcIntervalMs ?? GC_INTERVAL_MS;
    this.gcTimer = setInterval(() => this._gcSweep(), gcIntervalMs);
    // Don't block node process on this timer
    this.gcTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  createSession(input: CreateCompanionChatSessionInput = {}): CompanionChatSession {
    const id = randomUUID();
    const now = Date.now();
    const meta: CompanionChatSession = {
      id,
      kind: 'companion-chat',
      title: input.title ?? 'Chat',
      model: input.model ?? null,
      provider: input.provider ?? null,
      systemPrompt: input.systemPrompt ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      messageCount: 0,
    };

    const conversation = new ConversationManager();

    this.sessions.set(id, {
      meta,
      conversation,
      messages: [],
      abortController: new AbortController(),
      lastActivityAt: now,
      subscriberClientId: null,
    });

    return meta;
  }

  getSession(sessionId: string): CompanionChatSession | null {
    return this.sessions.get(sessionId)?.meta ?? null;
  }

  getMessages(sessionId: string): CompanionChatMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  /**
   * Register the SSE clientId for this session so events are routed only to
   * the correct subscriber. Replaces any previous registration (single subscriber
   * per session in v1 — the last SSE connection wins).
   */
  registerSubscriber(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subscriberClientId = clientId;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Close a session cleanly. Aborts any in-flight turn. Returns the session
   * snapshot, or null if not found.
   */
  closeSession(sessionId: string): CompanionChatSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.meta.status === 'closed') return session.meta;

    session.abortController.abort();
    const now = Date.now();
    const updated = this._updateMeta(session, { status: 'closed', closedAt: now, updatedAt: now });
    return updated;
  }

  /**
   * Post a user message and start an async LLM turn. Returns the messageId.
   * Throws if the session is closed.
   */
  async postMessage(
    sessionId: string,
    content: string,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error(`Session is closed: ${sessionId}`), { code: 'SESSION_CLOSED', status: 409 });
    }

    const messageId = randomUUID();
    const now = Date.now();

    const userMsg: CompanionChatMessage = {
      id: messageId,
      sessionId,
      role: 'user',
      content,
      createdAt: now,
    };

    session.messages.push(userMsg);
    session.conversation.addUserMessage(content);
    session.lastActivityAt = now;
    this._updateMeta(session, {
      messageCount: session.messages.length,
      updatedAt: now,
    });

    // Fire-and-forget: run the turn without blocking the HTTP response
    void this._runTurn(session, messageId);

    return messageId;
  }

  dispose(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    // Abort all in-flight turns
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // Turn execution
  // ---------------------------------------------------------------------------

  private async _runTurn(session: InternalSession, userMessageId: string): Promise<void> {
    const turnId = randomUUID();
    const sessionId = session.meta.id;
    const abortSignal = session.abortController.signal;

    const publish = (event: CompanionChatTurnEvent): void => {
      this.eventPublisher.publishEvent(
        `companion-chat.${event.type}`,
        event,
        session.subscriberClientId ? { clientId: session.subscriberClientId } : undefined,
      );
    };

    // Build user-message envelope for turn.started
    const userMsg = session.messages.find((m) => m.id === userMessageId);
    const startEnvelope: ConversationMessageEnvelope = {
      sessionId,
      messageId: userMessageId,
      body: userMsg?.content ?? '',
      source: 'companion-chat-user',
      timestamp: userMsg?.createdAt ?? Date.now(),
    };

    publish({ type: 'turn.started', sessionId, messageId: userMessageId, turnId, envelope: startEnvelope });

    let assistantContent = '';
    const assistantMessageId = randomUUID();

    try {
      const messages = session.conversation.getMessagesForLLM();
      // Convert ProviderMessage[] to our minimal interface
      const chatMessages: CompanionProviderMessage[] = messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));

      const stream = this.provider.chatStream(chatMessages, {
        systemPrompt: session.meta.systemPrompt,
        model: session.meta.model,
        provider: session.meta.provider,
        abortSignal,
      });

      for await (const chunk of stream) {
        if (abortSignal.aborted) break;

        switch (chunk.type) {
          case 'text_delta': {
            const delta = chunk.delta ?? '';
            assistantContent += delta;
            publish({ type: 'turn.delta', sessionId, turnId, delta });
            break;
          }
          case 'tool_call': {
            publish({
              type: 'turn.tool_call',
              sessionId,
              turnId,
              toolCallId: chunk.toolCallId ?? '',
              toolName: chunk.toolName ?? '',
              toolInput: chunk.toolInput ?? null,
            });
            break;
          }
          case 'tool_result': {
            publish({
              type: 'turn.tool_result',
              sessionId,
              turnId,
              toolCallId: chunk.toolCallId ?? '',
              toolName: chunk.toolName ?? '',
              result: chunk.result ?? null,
              isError: chunk.isError ?? false,
            });
            break;
          }
          case 'error': {
            throw new Error(chunk.error ?? 'Provider streaming error');
          }
          case 'done':
            break;
        }
      }

      // Append assistant reply to conversation
      if (assistantContent) {
        session.conversation.addAssistantMessage(assistantContent);
      }

      const now = Date.now();
      const assistantMsg: CompanionChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: assistantContent,
        createdAt: now,
      };
      session.messages.push(assistantMsg);
      session.lastActivityAt = now;
      this._updateMeta(session, { messageCount: session.messages.length, updatedAt: now });

      const completedEnvelope: ConversationMessageEnvelope = {
        sessionId,
        messageId: assistantMessageId,
        body: assistantContent,
        source: 'companion-chat-assistant',
        timestamp: now,
      };

      publish({ type: 'turn.completed', sessionId, turnId, assistantMessageId, envelope: completedEnvelope });
    } catch (err: unknown) {
      if (!abortSignal.aborted) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        publish({ type: 'turn.error', sessionId, turnId, error: errorMessage });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GC sweep
  // ---------------------------------------------------------------------------

  _gcSweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.meta.status === 'closed') {
        // Remove already-closed sessions after a short grace period (5 min)
        if (now - (session.meta.closedAt ?? now) > 5 * 60_000) {
          this.sessions.delete(id);
        }
        continue;
      }

      const idleMs = now - session.lastActivityAt;
      const isEmpty = session.messages.length === 0;
      const ttl = isEmpty ? this.idleEmptyMs : this.idleActiveMs;

      if (idleMs >= ttl) {
        // Close via GC
        session.abortController.abort();
        this._updateMeta(session, { status: 'closed', closedAt: now, updatedAt: now });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _updateMeta(
    session: InternalSession,
    patch: Partial<MutableSessionMeta>,
  ): CompanionChatSession {
    const updated: CompanionChatSession = { ...session.meta, ...patch };
    (session as { meta: CompanionChatSession }).meta = updated;
    return updated;
  }
}
