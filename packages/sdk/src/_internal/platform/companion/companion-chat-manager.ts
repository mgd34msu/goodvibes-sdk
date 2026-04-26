/**
 * companion-chat-manager.ts
 *
 * Disk-backed manager for companion-app chat-mode sessions.
 *
 * Design:
 * - Each session owns a ConversationManager (isolated message history).
 * - Sessions survive daemon restart via CompanionChatPersistence (atomic JSON files).
 * - Inbound messages are rate-limited per session and per client via
 *   CompanionChatRateLimiter (token-bucket, 30 msgs/min per client,
 *   10 msgs/min per session by default, configurable).
 * - When a user message is posted, the manager appends it to the conversation
 *   and runs a lightweight LLM turn using the provider registry.
 * - Tool calls emitted by the LLM are executed via the injected ToolRegistry
 *   (if provided); results are fed back into the stream and published as
 *   turn.tool_result events.
 * - Streaming chunks are fanned out via ControlPlaneGateway.publishEvent
 *   with a per-session clientId filter, so they only reach the subscriber
 *   for that specific session — never the global TUI event feed.
 * - A GC sweep closes sessions that have been idle beyond the TTL.
 */

import { randomUUID } from 'node:crypto';
import { ConversationManager } from '../core/conversation.js';
import type { ProviderMessage } from '../providers/interface.js';
import type {
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  ConversationMessageEnvelope,
  CreateCompanionChatSessionInput,
  UpdateCompanionChatSessionInput,
} from './companion-chat-types.js';
import {
  CompanionChatPersistence,
  defaultSessionsDir,
} from './companion-chat-persistence.js';
import { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
import type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { executeToolCalls as executeOrchestratorToolCalls } from '../core/orchestrator-tool-runtime.js';

// ---------------------------------------------------------------------------
// Minimal provider types (subset of the real ProviderRegistry interface)
// ---------------------------------------------------------------------------

export type CompanionProviderMessage = ProviderMessage;

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
      readonly tools?: readonly ToolDefinition[];
      readonly abortSignal?: AbortSignal;
    },
  ): AsyncIterable<CompanionProviderChunk>;
}

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

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
const DEFAULT_IDLE_EMPTY_MS = 5 * 60 * 1_000;   // 5 minutes empty session
const GC_INTERVAL_MS = 60 * 1_000;               // sweep every minute
const MAX_TOOL_ROUNDS_PER_TURN = 8;

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

export interface CompanionChatReplyResult {
  readonly messageId: string;
  readonly assistantMessageId?: string;
  readonly response?: string;
  readonly error?: string;
}

interface PendingReply {
  readonly resolve: (result: CompanionChatReplyResult) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// CompanionChatManager
// ---------------------------------------------------------------------------

export interface CompanionChatManagerConfig {
  readonly provider: CompanionLLMProvider;
  readonly eventPublisher: CompanionChatEventPublisher;
  /**
   * ToolRegistry to use for executing tool calls emitted by the LLM.
   * When omitted, tool_call chunks are published as events but not executed;
   * the LLM receives no tool result and must degrade gracefully.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * Permission boundary used when executing model-originated tool calls.
   * Tool calls are denied when a registry is present without this manager.
   */
  readonly permissionManager?: PermissionManager | null;
  /** Optional hook dispatcher for Pre/Post/Fail tool hooks. */
  readonly hookDispatcher?: HookDispatcherLike | null;
  /** Optional runtime event bus for typed tool telemetry. */
  readonly runtimeBus?: RuntimeEventBus | null;
  /**
   * Directory under which session JSON files are persisted.
   * Default: ~/.goodvibes/companion-chat/sessions/
   */
  readonly sessionsDir?: string;
  /**
   * Pass `false` to disable disk persistence entirely (useful in tests).
   * Default: true
   */
  readonly persist?: boolean;
  /** Rate-limiting options. Defaults: 30 msgs/min per client, 10/min per session. */
  readonly rateLimiter?: CompanionChatRateLimiterOptions | false;
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
  private readonly toolRegistry: ToolRegistry | null;
  private readonly permissionManager: PermissionManager | null;
  private readonly hookDispatcher: HookDispatcherLike | null;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly persistence: CompanionChatPersistence | null;
  private readonly rateLimiter: CompanionChatRateLimiter | null;
  private readonly idleActiveMs: number;
  private readonly idleEmptyMs: number;
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether the async init() has completed. */
  private initCompleted = false;
  private readonly pendingReplies = new Map<string, PendingReply>();
  /**
   * Serializes persistence writes per session to prevent write-after-write
   * races where two concurrent saves could result in an older snapshot
   * overwriting a newer one.
   */
  private readonly _pendingSaves = new Map<string, Promise<void>>();

  constructor(config: CompanionChatManagerConfig) {
    this.provider = config.provider;
    this.eventPublisher = config.eventPublisher;
    this.toolRegistry = config.toolRegistry ?? null;
    this.permissionManager = config.permissionManager ?? null;
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.runtimeBus = config.runtimeBus ?? null;
    this.idleActiveMs = config.idleActiveMs ?? DEFAULT_IDLE_ACTIVE_MS;
    this.idleEmptyMs = config.idleEmptyMs ?? DEFAULT_IDLE_EMPTY_MS;

    // Persistence
    // Default is false — most callers (tests, downstream consumers) get the
    // safe no-write default. The daemon opts into persistence explicitly via
    // persist: true in facade-composition.
    const persist = config.persist === true;
    this.persistence = persist
      ? new CompanionChatPersistence(config.sessionsDir ?? defaultSessionsDir())
      : null;

    // Rate limiter
    this.rateLimiter =
      config.rateLimiter === false
        ? null
        : new CompanionChatRateLimiter(config.rateLimiter ?? {});

    const gcIntervalMs = config.gcIntervalMs ?? GC_INTERVAL_MS;
    this.gcTimer = setInterval(() => {
      this._gcSweep();
      this.rateLimiter?.cleanup();
    }, gcIntervalMs);
    // Don't block node process on this timer
    this.gcTimer.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Async initialisation — load persisted sessions from disk
  // ---------------------------------------------------------------------------

  /**
   * Load sessions persisted from a previous daemon run.
   * Should be called once after construction before accepting requests.
   * Safe to call multiple times (idempotent after first call).
   */
  async init(): Promise<void> {
    if (this.initCompleted || !this.persistence) {
      this.initCompleted = true;
      return;
    }

    const stored = await this.persistence.loadAll();
    for (const { meta, messages } of stored) {
      // Skip sessions that were already closed before the restart — they are
      // in a terminal state and don't need to be in memory.
      if (meta.status === 'closed') continue;

      const conversation = new ConversationManager();
      // Replay messages into the conversation to restore LLM context
      for (const msg of messages) {
        if (msg.role === 'user') {
          conversation.addUserMessage(msg.content);
        } else {
          conversation.addAssistantMessage(msg.content);
        }
      }

      this.sessions.set(meta.id, {
        meta,
        conversation,
        messages: [...messages],
        abortController: new AbortController(),
        lastActivityAt: meta.updatedAt,
        subscriberClientId: null,
      });
    }

    this.initCompleted = true;
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

    // Persist async (non-blocking)
    void this._persist(id);

    return meta;
  }

  getSession(sessionId: string): CompanionChatSession | null {
    return this.sessions.get(sessionId)?.meta ?? null;
  }

  getMessages(sessionId: string): CompanionChatMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  updateSession(
    sessionId: string,
    input: UpdateCompanionChatSessionInput,
  ): CompanionChatSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error(`Session is closed: ${sessionId}`), { code: 'SESSION_CLOSED', status: 409 });
    }

    const patch: Partial<MutableSessionMeta> = { updatedAt: Date.now() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.model !== undefined) patch.model = input.model;
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;

    const updated = this._updateMeta(session, patch);
    void this._persist(sessionId);
    return updated;
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

    // Persist the closed state async (non-blocking)
    void this._persist(sessionId);

    return updated;
  }

  /**
   * Post a user message and start an async LLM turn. Returns the messageId.
   *
   * Rate-limited per session and per client (throws GoodVibesSdkError{kind:'rate-limit'}
   * if limits are exceeded).
   *
   * Throws if the session is closed or not found.
   *
   * @param sessionId - The session to post to.
   * @param content   - The message text.
   * @param clientId  - The SSE/HTTP client identity for per-client rate limiting.
   *                    Pass '' to skip client-level rate limiting.
   */
  async postMessage(
    sessionId: string,
    content: string,
    clientId = '',
  ): Promise<string> {
    return await this._postMessageInternal(sessionId, content, clientId);
  }

  async postMessageAndWaitForReply(
    sessionId: string,
    content: string,
    clientId = '',
    options: { readonly timeoutMs?: number } = {},
  ): Promise<CompanionChatReplyResult> {
    let messageId = '';
    const result = new Promise<CompanionChatReplyResult>((resolve) => {
      const timeout = setTimeout(() => {
        if (messageId) this.pendingReplies.delete(messageId);
        resolve({ messageId, error: 'Timed out waiting for companion chat reply' });
      }, options.timeoutMs ?? 120_000);
      timeout.unref?.();
      void this._postMessageInternal(sessionId, content, clientId, { resolve, timeout })
        .then((id) => { messageId = id; })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          resolve({
            messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
    return result;
  }

  private async _postMessageInternal(
    sessionId: string,
    content: string,
    clientId: string,
    pendingReply?: PendingReply,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error(`Session is closed: ${sessionId}`), { code: 'SESSION_CLOSED', status: 409 });
    }

    // Rate-limit check (throws GoodVibesSdkError on violation)
    this.rateLimiter?.check(sessionId, clientId);

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

    // Persist async (non-blocking)
    void this._persist(sessionId);

    if (pendingReply) {
      this.pendingReplies.set(messageId, pendingReply);
    }

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
      const toolDefinitions = this.toolRegistry?.getToolDefinitions() ?? [];
      let completed = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS_PER_TURN; round++) {
        const stream = this.provider.chatStream([...session.conversation.getMessagesForLLM()], {
          systemPrompt: session.meta.systemPrompt,
          model: session.meta.model,
          provider: session.meta.provider,
          tools: toolDefinitions,
          abortSignal,
        });

        let roundAssistantContent = '';
        const toolCalls: ToolCall[] = [];

        for await (const chunk of stream) {
          if (abortSignal.aborted) break;

          switch (chunk.type) {
            case 'text_delta': {
              const delta = chunk.delta ?? '';
              roundAssistantContent += delta;
              assistantContent += delta;
              publish({ type: 'turn.delta', sessionId, turnId, delta });
              break;
            }
            case 'tool_call': {
              const toolCallId = chunk.toolCallId ?? '';
              const toolName = chunk.toolName ?? '';
              const toolInput = (chunk.toolInput ?? {}) as Record<string, unknown>;
              publish({
                type: 'turn.tool_call',
                sessionId,
                turnId,
                toolCallId,
                toolName,
                toolInput,
              });
              if (toolCallId && toolName) {
                toolCalls.push({ id: toolCallId, name: toolName, arguments: toolInput });
              }
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

        if (abortSignal.aborted) break;

        if (toolCalls.length === 0) {
          session.conversation.addAssistantMessage(roundAssistantContent);
          completed = true;
          break;
        }

        session.conversation.addAssistantMessage(roundAssistantContent, { toolCalls });

        if (!this.toolRegistry) {
          completed = true;
          break;
        }

        const toolResults = await this._executeToolCalls(toolCalls, publish, sessionId, turnId);
        session.conversation.addToolResults(toolResults);
      }

      if (!completed && !abortSignal.aborted) {
        throw new Error(`Companion chat exceeded ${MAX_TOOL_ROUNDS_PER_TURN} tool rounds without a final response`);
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

      // Persist assistant reply
      void this._persist(sessionId);

      const completedEnvelope: ConversationMessageEnvelope = {
        sessionId,
        messageId: assistantMessageId,
        body: assistantContent,
        source: 'companion-chat-assistant',
        timestamp: now,
      };

      publish({ type: 'turn.completed', sessionId, turnId, assistantMessageId, envelope: completedEnvelope });
      this.resolvePendingReply(userMessageId, { messageId: userMessageId, assistantMessageId, response: assistantContent });
    } catch (err: unknown) {
      if (!abortSignal.aborted) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        publish({ type: 'turn.error', sessionId, turnId, error: errorMessage });
        this.resolvePendingReply(userMessageId, { messageId: userMessageId, error: errorMessage });
      } else {
        this.resolvePendingReply(userMessageId, { messageId: userMessageId, error: 'Turn cancelled' });
      }
    }
  }

  private async _executeToolCalls(
    toolCalls: ToolCall[],
    publish: (event: CompanionChatTurnEvent) => void,
    sessionId: string,
    turnId: string,
  ): Promise<ToolResult[]> {
    const toolRegistry = this.toolRegistry;
    if (!toolRegistry) return [];

    if (!this.permissionManager) {
      return toolCalls.map((call) => {
        const toolResult: ToolResult = {
          callId: call.id,
          success: false,
          error: 'Tool execution denied: permission manager unavailable for companion chat',
        };
        publish({
          type: 'turn.tool_result',
          sessionId,
          turnId,
          toolCallId: call.id,
          toolName: call.name,
          result: toolResult.error,
          isError: true,
        });
        return toolResult;
      });
    }

    const results = await executeOrchestratorToolCalls({
      toolRegistry,
      permissionManager: this.permissionManager,
      hookDispatcher: this.hookDispatcher,
      runtimeBus: this.runtimeBus,
      sessionId,
      emitterContext: (id) => ({
        sessionId,
        traceId: `${sessionId}:${id}`,
        source: 'companion-chat',
      }),
    }, turnId, toolCalls);

    for (const [index, toolResult] of results.entries()) {
      const call = toolCalls[index];
      if (!call) continue;
      publish({
        type: 'turn.tool_result',
        sessionId,
        turnId,
        toolCallId: call.id,
        toolName: call.name,
        result: toolResult.output ?? toolResult.error ?? null,
        isError: !toolResult.success,
      });
    }

    return results;
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
          void this.persistence?.delete(id);
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
        void this._persist(id);
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

  /**
   * Schedule a persistence save for the given session.
   * Saves are serialized per-session: each new save waits for the prior one to
   * complete before writing. The save always reads the CURRENT session state,
   * so rapid create→update→close sequences correctly persist the final state.
   */
  private _persist(sessionId: string): void {
    if (!this.persistence) return;
    const prior = this._pendingSaves.get(sessionId) ?? Promise.resolve();
    const next = prior.then(() => this._doSave(sessionId));
    this._pendingSaves.set(
      sessionId,
      next.finally(() => {
        // Clean up the slot once this save is the settled head.
        if (this._pendingSaves.get(sessionId) === next) {
          this._pendingSaves.delete(sessionId);
        }
      }),
    );
  }

  private async _doSave(sessionId: string): Promise<void> {
    if (!this.persistence) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.persistence.save({ meta: session.meta, messages: session.messages });
  }

  private resolvePendingReply(messageId: string, result: CompanionChatReplyResult): void {
    const pending = this.pendingReplies.get(messageId);
    if (!pending) return;
    this.pendingReplies.delete(messageId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }
}
