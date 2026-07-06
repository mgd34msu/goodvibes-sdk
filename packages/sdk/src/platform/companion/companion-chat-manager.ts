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
import { SDKErrorCodes } from '@pellux/goodvibes-errors';
import { ConversationManager } from '../core/conversation.js';
import type { ProviderMessage } from '../providers/interface.js';
import type {
  CompanionChatMessageAttachmentInput,
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
import {
  buildProviderUserContent,
  buildReplayUserContent,
  resolveAttachments,
  type CompanionChatArtifactStore,
} from './companion-chat-attachments.js';
import { planCompanionSweep } from './companion-chat-gc.js';
import type { CompanionSessionBrokerBridge } from './companion-chat-broker-bridge.js';
import { CompanionBrokerSync } from './companion-chat-broker-sync.js';
import { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
import type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { executeToolCalls as executeOrchestratorToolCalls } from '../core/orchestrator-tool-runtime.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Minimal provider types (subset of the real ProviderRegistry interface)
// ---------------------------------------------------------------------------

export type CompanionProviderMessage = ProviderMessage;

export interface CompanionProviderChunk {
  readonly type: 'text_delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  readonly delta?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolInput?: unknown | undefined;
  readonly result?: unknown | undefined;
  readonly isError?: boolean | undefined;
  readonly error?: string | undefined;
}

export interface CompanionLLMProvider {
  /** Stream a single-turn conversation. Yields chunks. */
  chatStream(
    messages: CompanionProviderMessage[],
    options: {
      readonly systemPrompt?: string | null | undefined;
      readonly model?: string | null | undefined;
      readonly provider?: string | null | undefined;
      readonly tools?: readonly ToolDefinition[] | undefined;
      readonly abortSignal?: AbortSignal | undefined;
    },
  ): AsyncIterable<CompanionProviderChunk>;
}

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

export type { CompanionChatArtifactStore } from './companion-chat-attachments.js';

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
const DEFAULT_CLOSED_MEMORY_GRACE_MS = 5 * 60 * 1_000; // evict closed bodies from RAM after 5 min
const GC_INTERVAL_MS = 60 * 1_000;               // sweep every minute
const MAX_TOOL_ROUNDS_PER_TURN = 8;
const TOOL_EXHAUSTION_FINALIZER_PROMPT = [
  `The tool-call budget for this turn is exhausted after ${MAX_TOOL_ROUNDS_PER_TURN} rounds.`,
  'Do not call any more tools. Use the conversation and tool results already available to give '
    + 'the user the best concise final answer you can.',
  'If the available tool results are insufficient, say what is missing and ask one short follow-up '
    + 'question.',
].join(' ');
function assertCompleteProviderModelRoute(
  input: { readonly model?: string | undefined; readonly provider?: string | undefined },
): void {
  if ((input.model !== undefined) === (input.provider !== undefined)) return;
  throw Object.assign(new Error('provider and model must be supplied together'), {
    code: 'INVALID_MODEL_ROUTE',
    status: 400,
  });
}

interface InternalSession {
  readonly meta: CompanionChatSession;
  conversation: ConversationManager;
  messages: CompanionChatMessage[];
  readonly abortController: AbortController;
  lastActivityAt: number;
  // The SSE client ID for this session (set when a subscriber connects)
  subscriberClientId: string | null;
  /**
   * True once the GC has evicted this closed session's heavy in-memory handles
   * (ConversationManager + message bodies). Meta stays listable; the on-disk
   * copy is untouched. Prevents repeated eviction work across sweeps.
   */
  messagesEvicted?: boolean;
}

type MutableSessionMeta = {
  -readonly [K in keyof CompanionChatSession]: CompanionChatSession[K];
};

export interface CompanionChatReplyResult {
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly error?: string | undefined;
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
  readonly toolRegistry?: ToolRegistry | undefined;
  /**
   * Permission boundary used when executing model-originated tool calls.
   * Tool calls are denied when a registry is present without this manager.
   */
  readonly permissionManager?: PermissionManager | null | undefined;
  /** Optional hook dispatcher for Pre/Post/Fail tool hooks. */
  readonly hookDispatcher?: HookDispatcherLike | null | undefined;
  /** Optional runtime event bus for typed tool telemetry. */
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /** Optional artifact store used to resolve and inline chat attachments. */
  readonly artifactStore?: CompanionChatArtifactStore | null | undefined;
  /**
   * Directory under which session JSON files are persisted.
   * Default: `<homeDirectory>/.goodvibes/companion-chat/sessions/` when
   * `homeDirectory` is provided, else the OS home. Prefer passing this (or
   * `homeDirectory`) explicitly so an isolated-home daemon never touches the
   * real `~/.goodvibes`.
   */
  readonly sessionsDir?: string | undefined;
  /** Injected home dir; when `sessionsDir` is omitted, the persistence root is
   * derived from THIS home (not the OS home) so an isolated-home daemon stays in. */
  readonly homeDirectory?: string | undefined;
  /**
   * Optional bridge to the shared session broker. When supplied, companion
   * sessions register INTO the broker at write time (create/close), so
   * `/api/sessions` reflects companion activity immediately (same-process, no
   * restart). The boot-time importer fold remains the reconciliation path.
   */
  readonly sessionBroker?: CompanionSessionBrokerBridge | null | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's heavy in-memory handles
   * are evicted while its meta stays listable (bounds resident memory). Default 5 min. */
  readonly closedSessionMemoryGraceMs?: number | undefined;
  /** Age (ms past closedAt) at which a CLOSED session's persisted file is PERMANENTLY
   * deleted. Closed sessions are HISTORY: default `undefined` = retain indefinitely. */
  readonly closedSessionRetentionMs?: number | undefined;
  /**
   * Pass `false` to disable disk persistence entirely (useful in tests).
   * Default: true
   */
  readonly persist?: boolean | undefined;
  /** Rate-limiting options. Defaults: 30 msgs/min per client, 10/min per session. */
  readonly rateLimiter?: CompanionChatRateLimiterOptions | false | undefined;
  /** Override for tests */
  readonly idleActiveMs?: number | undefined;
  /** Override for tests */
  readonly idleEmptyMs?: number | undefined;
  /** Override for tests */
  readonly gcIntervalMs?: number | undefined;
}

export class CompanionChatManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly provider: CompanionLLMProvider;
  private readonly eventPublisher: CompanionChatEventPublisher;
  private readonly toolRegistry: ToolRegistry | null;
  private readonly permissionManager: PermissionManager | null;
  private readonly hookDispatcher: HookDispatcherLike | null;
  private readonly runtimeBus: RuntimeEventBus | null;
  private readonly artifactStore: CompanionChatArtifactStore | null;
  private readonly persistence: CompanionChatPersistence | null;
  private readonly rateLimiter: CompanionChatRateLimiter | null;
  private readonly idleActiveMs: number;
  private readonly idleEmptyMs: number;
  private readonly closedMemoryGraceMs: number;
  private readonly closedRetentionMs: number | undefined;
  /** Live mirror of sessions into the shared broker store (S1 item D). */
  private readonly _brokerSync: CompanionBrokerSync;
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
    this.artifactStore = config.artifactStore ?? null;
    this.idleActiveMs = config.idleActiveMs ?? DEFAULT_IDLE_ACTIVE_MS;
    this.idleEmptyMs = config.idleEmptyMs ?? DEFAULT_IDLE_EMPTY_MS;
    this.closedMemoryGraceMs = config.closedSessionMemoryGraceMs ?? DEFAULT_CLOSED_MEMORY_GRACE_MS;
    this.closedRetentionMs = config.closedSessionRetentionMs;
    this._brokerSync = new CompanionBrokerSync(config.sessionBroker ?? null);

    // Persistence
    // Default is false — most callers (tests, downstream consumers) get the
    // safe no-write default. The daemon opts into persistence explicitly via
    // persist: true in facade-composition. When sessionsDir is omitted, derive
    // the root from the INJECTED home so an isolated-home daemon stays inside it.
    const persist = config.persist === true;
    this.persistence = persist
      ? new CompanionChatPersistence(config.sessionsDir ?? defaultSessionsDir(config.homeDirectory))
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
      const normalizedMessages = messages.map((message) => this.normalizeMessage(message));
      const conversation = new ConversationManager();
      // Closed-skip fix: closed sessions load in a lightweight terminal state
      // (meta + messages retained, listable/importable; no history replay). GC
      // (_gcSweep) remains the sole deletion authority.
      if (meta.status !== 'closed') {
        for (const msg of normalizedMessages) {
          if (msg.role === 'user') {
            conversation.addUserMessage(buildReplayUserContent(msg));
          } else {
            conversation.addAssistantMessage(msg.content);
          }
        }
      }

      this.sessions.set(meta.id, {
        meta,
        conversation,
        messages: normalizedMessages,
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
    assertCompleteProviderModelRoute(input);
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

    this._persist(id);
    // Live spine: mirror the new session into the shared broker at write time so
    // /api/sessions reflects it same-process (no restart). Best-effort.
    this._brokerSync.track(meta.id, () => this._brokerSync.registerSession(meta));

    return meta;
  }

  getSession(sessionId: string): CompanionChatSession | null {
    return this.sessions.get(sessionId)?.meta ?? null;
  }

  listSessions(input: { readonly includeClosed?: boolean | undefined; readonly limit?: number | undefined } = {}): {
    readonly sessions: readonly CompanionChatSession[];
    readonly totals: { readonly sessions: number; readonly active: number; readonly closed: number };
  } {
    const all = [...this.sessions.values()].map((session) => session.meta);
    const active = all.filter((session) => session.status === 'active').length;
    const closed = all.length - active;
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(0, Math.floor(input.limit))
      : 100;
    const sessions = all
      .filter((session) => input.includeClosed || session.status !== 'closed')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
    return {
      sessions,
      totals: {
        sessions: all.length,
        active,
        closed,
      },
    };
  }

  getMessages(sessionId: string): CompanionChatMessage[] {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  private normalizeMessage(message: CompanionChatMessage): CompanionChatMessage {
    return {
      ...message,
      attachments: message.attachments ?? [],
    };
  }

  updateSession(
    sessionId: string,
    input: UpdateCompanionChatSessionInput,
  ): CompanionChatSession {
    assertCompleteProviderModelRoute(input);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error('Session is closed'), { code: SDKErrorCodes.SESSION_CLOSED, status: 409 });
    }

    const patch: Partial<MutableSessionMeta> = { updatedAt: Date.now() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.model !== undefined) patch.model = input.model;
    if (input.provider !== undefined) patch.provider = input.provider;
    if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;

    const updated = this._updateMeta(session, patch);
    this._persist(sessionId);
    // Heartbeat the broker record (advances participant.lastSeenAt). Title is
    // never overwritten by this path (broker treats register as a heartbeat).
    this._brokerSync.track(updated.id, () => this._brokerSync.registerSession(updated));
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

    this._persist(sessionId);
    // Live spine: flip the shared broker record to closed at write time.
    this._brokerSync.track(sessionId, () => this._brokerSync.closeSession(sessionId));

    return updated;
  }

  /**
   * Permanently delete a session (W5-S1: `delete` is now a genuine removal,
   * distinct from `closeSession` above). Aborts any in-flight turn, removes
   * the on-disk record file, and drops the in-memory entry — reusing
   * {@link _hardRemove}, the SAME primitive the GC 'delete-persistent' sweep
   * action uses, so there is exactly one removal code path.
   *
   * Requires the session to already be closed: deleting a still-active
   * session throws `{ code: 'SESSION_ACTIVE', status: 409 }` (the caller must
   * close it first, mirroring the SESSION_CLOSED-throw convention elsewhere
   * in this file). An unknown OR already-deleted id throws
   * `{ code: 'SESSION_NOT_FOUND', status: 404 }` — delete is not a 200-noop.
   */
  async deleteSession(sessionId: string): Promise<{ readonly sessionId: string; readonly deleted: true }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status !== 'closed') {
      throw Object.assign(new Error('Session is active — close it, then delete.'), { code: 'SESSION_ACTIVE', status: 409 });
    }

    session.abortController.abort();
    await this._hardRemove(sessionId);
    // Live spine: drop the mirrored shared broker record entirely (not just closed).
    this._brokerSync.track(sessionId, () => this._brokerSync.deleteSession(sessionId));

    return { sessionId, deleted: true };
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
    options: {
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<string> {
    return await this._postMessageInternal(sessionId, content, clientId, {
      attachments: options.attachments,
      metadata: options.metadata,
    });
  }

  async postMessageAndWaitForReply(
    sessionId: string,
    content: string,
    clientId = '',
    options: {
      readonly timeoutMs?: number | undefined;
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
    } = {},
  ): Promise<CompanionChatReplyResult> {
    let messageId = '';
    const result = new Promise<CompanionChatReplyResult>((resolve) => {
      const timeout = setTimeout(() => {
        if (messageId) this.pendingReplies.delete(messageId);
        resolve({ messageId, error: 'Timed out waiting for companion chat reply' });
      }, options.timeoutMs ?? 120_000);
      timeout.unref?.();
      void this._postMessageInternal(sessionId, content, clientId, {
        pendingReply: { resolve, timeout },
        attachments: options.attachments,
      })
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
    options: {
      readonly pendingReply?: PendingReply | undefined;
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error('Session is closed'), { code: SDKErrorCodes.SESSION_CLOSED, status: 409 });
    }

    // Rate-limit check (throws GoodVibesSdkError on violation)
    this.rateLimiter?.check(sessionId, clientId);

    const attachments = resolveAttachments(options.attachments ?? [], this.artifactStore);
    if (!content.trim() && attachments.length === 0) {
      throw Object.assign(new Error('content or attachments are required'), { code: 'INVALID_INPUT', status: 400 });
    }

    const messageId = randomUUID();
    const now = Date.now();

    const userMsg: CompanionChatMessage = {
      id: messageId,
      sessionId,
      role: 'user',
      content,
      attachments,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      createdAt: now,
    };

    session.messages.push(userMsg);
    session.conversation.addUserMessage(await buildProviderUserContent(content, attachments, this.artifactStore));
    session.lastActivityAt = now;
    this._updateMeta(session, {
      messageCount: session.messages.length,
      updatedAt: now,
    });

    this._persist(sessionId);

    if (options.pendingReply) {
      this.pendingReplies.set(messageId, options.pendingReply);
    }

    void this._runTurn(session, messageId).catch((error: unknown) => {
      logger.warn('[companion-chat] turn execution failed', {
        sessionId,
        messageId,
        error: summarizeError(error),
      });
    });

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
      ...(userMsg?.attachments?.length ? { attachments: userMsg.attachments } : {}),
    };

    publish({ type: 'turn.started', sessionId, messageId: userMessageId, turnId, envelope: startEnvelope });

    let assistantContent = '';
    const assistantMessageId = randomUUID();

    try {
      const toolDefinitions = this.toolRegistry?.getToolDefinitions() ?? [];
      let completed = false;

      for (let round = 0; round < MAX_TOOL_ROUNDS_PER_TURN; round++) {
        const stream = this.provider.chatStream([...session.conversation.getMessagesForLLM()], {
          systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(session.meta.systemPrompt),
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
        const finalResponse = await this._finalizeAfterToolExhaustion(session, abortSignal, turnId, publish);
        if (finalResponse.trim()) {
          assistantContent += finalResponse;
          session.conversation.addAssistantMessage(finalResponse);
          completed = true;
        } else {
          const fallbackResponse = 'I could not finish a final answer after using the available tools. Please try again with a narrower request.';
          assistantContent += fallbackResponse;
          session.conversation.addAssistantMessage(fallbackResponse);
          completed = true;
        }
      }

      // A detected abort (session closed/disposed/GC'd) where the provider ended
      // its stream gracefully instead of throwing must be treated as a cancellation,
      // not recorded as a successful partial reply. Mirror the catch-block's aborted
      // handling and short-circuit before push/persist/turn.completed.
      if (abortSignal.aborted) {
        this.resolvePendingReply(userMessageId, { messageId: userMessageId, error: 'Turn cancelled' });
        return;
      }

      const now = Date.now();
      const assistantMsg: CompanionChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content: assistantContent,
        attachments: [],
        createdAt: now,
      };
      session.messages.push(assistantMsg);
      session.lastActivityAt = now;
      this._updateMeta(session, { messageCount: session.messages.length, updatedAt: now });

      // Persist assistant reply
      this._persist(sessionId);

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

  private async _finalizeAfterToolExhaustion(
    session: InternalSession,
    abortSignal: AbortSignal,
    turnId: string,
    publish: (event: CompanionChatTurnEvent) => void,
  ): Promise<string> {
    const sessionId = session.meta.id;
    let finalContent = '';
    const stream = this.provider.chatStream([...session.conversation.getMessagesForLLM()], {
      systemPrompt: appendGoodVibesRuntimeAwarenessPrompt(
        [session.meta.systemPrompt, TOOL_EXHAUSTION_FINALIZER_PROMPT].filter(Boolean).join('\n\n'),
      ),
      model: session.meta.model,
      provider: session.meta.provider,
      abortSignal,
    });

    for await (const chunk of stream) {
      if (abortSignal.aborted) break;

      switch (chunk.type) {
        case 'text_delta': {
          const delta = chunk.delta ?? '';
          finalContent += delta;
          publish({ type: 'turn.delta', sessionId, turnId, delta });
          break;
        }
        case 'error':
          throw new Error(chunk.error ?? 'Provider streaming error');
        case 'tool_call':
        case 'tool_result':
        case 'done':
          break;
      }
    }

    return finalContent;
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
      const call = toolCalls[index]!;
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

  /**
   * Periodic GC sweep. Deletion authority is SPLIT (charter: closed sessions are
   * HISTORY): close-idle closes an idle active session; evict-memory drops a
   * long-closed session's in-memory handles (meta + on-disk copy kept);
   * delete-persistent removes the file ONLY under an explicit finite retention
   * window (default retains indefinitely — see {@link planCompanionSweep}).
   */
  _gcSweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const action = planCompanionSweep(
        {
          status: session.meta.status,
          closedAt: session.meta.closedAt,
          lastActivityAt: session.lastActivityAt,
          hasMessagesInMemory: !session.messagesEvicted && session.messages.length > 0,
          isEmpty: session.messages.length === 0,
        },
        {
          now,
          idleActiveMs: this.idleActiveMs,
          idleEmptyMs: this.idleEmptyMs,
          closedMemoryGraceMs: this.closedMemoryGraceMs,
          closedRetentionMs: this.closedRetentionMs,
        },
      );

      switch (action.kind) {
        case 'close-idle':
          session.abortController.abort();
          this._updateMeta(session, { status: 'closed', closedAt: now, updatedAt: now });
          this._persist(id);
          this._brokerSync.track(id, () => this._brokerSync.closeSession(id));
          break;
        case 'evict-memory':
          // Free heavy handles; keep meta (listable) and the persisted file.
          session.messages = [];
          session.conversation = new ConversationManager();
          session.messagesEvicted = true;
          break;
        case 'delete-persistent':
          void this._hardRemove(id).catch((error: unknown) => {
            logger.warn('[companion-chat] session delete failed', {
              sessionId: id,
              error: summarizeError(error),
            });
          });
          break;
        case 'retain':
          break;
      }
    }
  }

  private _updateMeta(
    session: InternalSession,
    patch: Partial<MutableSessionMeta>,
  ): CompanionChatSession {
    const updated: CompanionChatSession = { ...session.meta, ...patch };
    (session as { meta: CompanionChatSession }).meta = updated;
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Live shared-broker registration (S1 item D) — see companion-chat-broker-sync.ts
  // ---------------------------------------------------------------------------

  /**
   * Await all in-flight best-effort broker-sync operations. The daemon's
   * companion HTTP routes call this before responding so `/api/sessions`
   * reflects the change synchronously; tests use it to make the mirror
   * deterministic. A no-op when no broker bridge is configured.
   */
  async flushBrokerSync(): Promise<void> {
    await this._brokerSync.flush();
  }

  /**
   * Hard-remove a session's persisted file and in-memory record. The ONE
   * removal code path — shared by {@link deleteSession} and the GC
   * 'delete-persistent' action. Never fork this. Order matters (Wave-5 F1):
   * drop the map entry, drain any in-flight {@link _persist} save for this
   * id, THEN unlink — else a save mid-write from {@link closeSession} can
   * resurrect the file post-unlink.
   */
  private async _hardRemove(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    const pendingSave = this._pendingSaves.get(sessionId);
    if (pendingSave) await pendingSave.catch(() => {});
    await this.persistence?.delete(sessionId);
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
    const next = prior
      .catch((error: unknown) => {
        logger.warn('[companion-chat] previous session persistence failed before a newer save', {
          sessionId,
          error: summarizeError(error),
        });
      })
      .then(() => this._doSave(sessionId))
      .catch((error: unknown) => {
        logger.warn('[companion-chat] session persistence failed', {
          sessionId,
          error: summarizeError(error),
        });
      });
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
