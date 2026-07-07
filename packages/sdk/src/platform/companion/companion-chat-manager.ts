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
  CancelCompanionChatTurnInput,
  CancelCompanionChatTurnOutput,
  SteerCompanionChatMessageOutput,
  CompanionChatMessageAttachmentInput,
  CompanionChatMessage,
  CompanionChatSession,
  CompanionChatTurnEvent,
  CompanionChatTurnStoppedBy,
  ConversationMessageEnvelope,
  CreateCompanionChatSessionInput,
  EditCompanionChatMessageInput,
  EditCompanionChatMessageOutput,
  RegenerateCompanionChatMessageInput,
  RegenerateCompanionChatMessageOutput,
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
import {
  activeMessages,
  applyEditBranch,
  planRegenerate,
} from './companion-chat-branching.js';
import {
  executeCompanionToolCalls,
  runToolExhaustionFinalizer,
} from './companion-chat-turn-execution.js';
import { planCompanionSweep } from './companion-chat-gc.js';
import type { CompanionSessionBrokerBridge } from './companion-chat-broker-bridge.js';
import { CompanionBrokerSync } from './companion-chat-broker-sync.js';
import { CompanionChatRateLimiter } from './companion-chat-rate-limiter.js';
import type { CompanionChatRateLimiterOptions } from './companion-chat-rate-limiter.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolCall, ToolDefinition } from '../types/tools.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { HookEvent, HookResult } from '../hooks/types.js';
import { appendGoodVibesRuntimeAwarenessPrompt } from '../tools/goodvibes-runtime/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Turn control (per-turn abort scope, cancel finalization, pending queue) —
// see companion-chat-turn-control.ts; provider stream types moved with it.
// ---------------------------------------------------------------------------

export type {
  CompanionLLMProvider,
  CompanionProviderChunk,
  CompanionProviderMessage,
} from './companion-chat-turn-control.js';
import {
  awaitCompanionReply,
  cancelActiveTurn,
  createTurnAbortScope,
  finalizeCancelledTurn,
} from './companion-chat-turn-control.js';
import type {
  ActiveCompanionTurn,
  CompanionLLMProvider,
  QueuedCompanionTurn,
} from './companion-chat-turn-control.js';

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
  /** The in-flight turn, when one is running (see ActiveCompanionTurn). */
  activeTurn?: ActiveCompanionTurn | null;
  /** User messages whose turns have not started yet (queue-when-busy + steer-to-front). */
  pendingTurns?: QueuedCompanionTurn[];
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
  /** Directory for session JSON files. Default `<homeDirectory>/.goodvibes/companion-chat/sessions/`
   * (else OS home). Prefer passing this (or `homeDirectory`) so an isolated-home daemon stays in. */
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
  /** Pass `false` to disable disk persistence entirely (useful in tests). Default: true */
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
  /** True once dispose() ran — lets a cancelled turn report stoppedBy 'shutdown' honestly. */
  private disposed = false;
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
   * Cancel the in-flight turn (`companion.chat.turns.cancel`) — a per-turn
   * stop that never touches the session controller. Refusal semantics and the
   * bounded finalization wait live in companion-chat-turn-control.ts.
   */
  async cancelTurn(sessionId: string, input: CancelCompanionChatTurnInput = {}): Promise<CancelCompanionChatTurnOutput> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    return cancelActiveTurn(sessionId, session.activeTurn ?? null, input);
  }

  /**
   * Permanently delete a session (see CHANGELOG 1.0.0: `delete` is now a genuine removal,
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
      /** In-process tap for this turn's incremental events; independent of the gateway SSE fan-out. */
      readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
    } = {},
  ): Promise<CompanionChatReplyResult> {
    return awaitCompanionReply(
      options.timeoutMs ?? 120_000,
      (pendingReply) => this._postMessageInternal(sessionId, content, clientId, {
        pendingReply,
        attachments: options.attachments,
        ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}),
      }),
      (messageId) => this.pendingReplies.delete(messageId),
    );
  }

  private async _postMessageInternal(
    sessionId: string,
    content: string,
    clientId: string,
    options: {
      readonly pendingReply?: PendingReply | undefined;
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined;
      /** Steer: jump the pending queue (the caller cancels the active turn). */
      readonly steer?: boolean | undefined;
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

    // A send that lands while another turn is running QUEUES (visible in the
    // transcript immediately, marked 'queued', answered after the current
    // turn) — it must never start a concurrent turn against the same
    // conversation. A steer jumps the queue instead (see steerMessage).
    const queuedBehindActiveTurn = session.activeTurn != null && options.steer !== true;
    const userMsg: CompanionChatMessage = {
      id: messageId,
      sessionId,
      role: 'user',
      content,
      attachments,
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      createdAt: now,
      ...(queuedBehindActiveTurn ? { deliveryState: 'queued' as const } : {}),
    };

    // Provider-ready content is built at post time but committed to the
    // conversation only when the turn STARTS — committing now would leak a
    // queued message into the active turn's later tool rounds, which re-read
    // the conversation every round.
    const providerContent = await buildProviderUserContent(content, attachments, this.artifactStore);

    session.messages.push(userMsg);
    session.lastActivityAt = now;
    this._updateMeta(session, {
      messageCount: session.messages.length,
      updatedAt: now,
    });

    this._persist(sessionId);

    if (options.pendingReply) {
      this.pendingReplies.set(messageId, options.pendingReply);
    }

    const entry: QueuedCompanionTurn = {
      userMessageId: messageId,
      providerContent,
      ...(options.onTurnEvent ? { onTurnEvent: options.onTurnEvent } : {}),
    };
    const queue = (session.pendingTurns ??= []);
    if (options.steer === true) queue.unshift(entry);
    else queue.push(entry);
    this._startNextTurn(session);

    return messageId;
  }

  dispose(): void {
    this.disposed = true;
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

  /**
   * Steer: send a message that runs IMMEDIATELY, cancelling the in-flight
   * turn if one is running (`companion.chat.messages.steer`). The message
   * jumps to the FRONT of the pending queue, then the active turn is
   * cancelled through the same finalization path as an explicit stop (honest
   * partial persisted, terminal `turn.cancelled` to every subscriber), and
   * the drain starts the steer's turn. With no turn running this is an
   * ordinary send. Queued messages keep their places behind the steer.
   */
  async steerMessage(
    sessionId: string,
    content: string,
    clientId = '',
    options: {
      readonly attachments?: readonly CompanionChatMessageAttachmentInput[] | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    } = {},
  ): Promise<SteerCompanionChatMessageOutput> {
    const activeBefore = this.sessions.get(sessionId)?.activeTurn ?? null;
    const messageId = await this._postMessageInternal(sessionId, content, clientId, {
      attachments: options.attachments,
      metadata: options.metadata,
      steer: true,
    });
    let cancelledTurnId: string | undefined;
    if (activeBefore) {
      try {
        const result = await this.cancelTurn(sessionId, { turnId: activeBefore.turnId });
        cancelledTurnId = result.turnId;
      } catch (err: unknown) {
        // Benign races: the turn finished naturally (NO_ACTIVE_TURN), or the
        // slot already belongs to a newer turn — possibly this very steer
        // (TURN_MISMATCH). The turnId guard is what makes this safe: a steer
        // must never cancel its own turn or an unrelated newer one.
        const code = (err as { code?: string }).code;
        if (code !== 'NO_ACTIVE_TURN' && code !== 'TURN_MISMATCH') throw err;
      }
    }
    const session = this.sessions.get(sessionId);
    if (session) this._startNextTurn(session);
    return {
      sessionId,
      messageId,
      steered: true,
      ...(cancelledTurnId !== undefined ? { cancelledTurnId } : {}),
      turnStarted: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Turn execution
  // ---------------------------------------------------------------------------

  /**
   * The single turn-start funnel: runs the next pending turn iff no turn is
   * active and the session is open. Every turn exit drains through here, so
   * queued sends and steers can never race into concurrent turns.
   */
  private _startNextTurn(session: InternalSession): void {
    if (session.activeTurn || session.meta.status === 'closed') return;
    const next = session.pendingTurns?.shift();
    if (!next) return;
    const idx = session.messages.findIndex((m) => m.id === next.userMessageId);
    const queuedMsg = idx >= 0 ? session.messages[idx] : undefined;
    if (queuedMsg?.deliveryState === 'queued') {
      const { deliveryState: _cleared, ...delivered } = queuedMsg;
      session.messages[idx] = delivered;
      this._persist(session.meta.id);
    }
    // Deferred from post time (see _postMessageInternal).
    session.conversation.addUserMessage(next.providerContent);
    void this._runTurn(session, next.userMessageId, next.onTurnEvent).catch((error: unknown) => {
      logger.warn('[companion-chat] turn execution failed', {
        sessionId: session.meta.id,
        messageId: next.userMessageId,
        error: summarizeError(error),
      });
    });
  }

  private async _runTurn(session: InternalSession, userMessageId: string, onTurnEvent?: (event: CompanionChatTurnEvent) => void): Promise<void> {
    const turnId = randomUUID();
    const sessionId = session.meta.id;

    // Per-turn abort scope chained under the session controller — see
    // companion-chat-turn-control.ts for why the session controller must
    // never be aborted for a single-turn stop.
    const scope = createTurnAbortScope(turnId, session.abortController.signal);
    const abortSignal = scope.abortSignal;
    session.activeTurn = scope.activeTurn;

    // Track announced-but-unresolved tool calls so a cancelled turn can close
    // them (every turn.tool_call gets a turn.tool_result before the terminal
    // event — no client is ever left rendering a wedged tool block).
    const openToolCalls = new Map<string, string>();

    const publish = (event: CompanionChatTurnEvent): void => {
      if (event.type === 'turn.tool_call' && event.toolCallId) {
        openToolCalls.set(event.toolCallId, event.toolName);
      } else if (event.type === 'turn.tool_result' && event.toolCallId) {
        openToolCalls.delete(event.toolCallId);
      }
      this.eventPublisher.publishEvent(
        `companion-chat.${event.type}`,
        event,
        session.subscriberClientId ? { clientId: session.subscriberClientId } : undefined,
      );
      // In-process tap (e.g. the HA SSE route); a throwing listener must not break the turn.
      try { onTurnEvent?.(event); } catch { /* isolate listener */ }
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

    const finalizeCancelled = (): void => finalizeCancelledTurn({
      sessionId,
      turnId,
      assistantMessageId,
      userMessageId,
      getAssistantContent: () => assistantContent,
      openToolCalls,
      wasCancelRequested: () => scope.activeTurn.cancelRequested,
      isShutdown: () => this.disposed,
      publish,
      persistPartial: (message) => {
        session.messages.push(message);
        session.lastActivityAt = message.createdAt;
        this._updateMeta(session, { messageCount: session.messages.length, updatedAt: message.createdAt });
        this._persist(sessionId);
      },
      resolveReply: (extra) => this.resolvePendingReply(userMessageId, { messageId: userMessageId, ...extra, error: 'Turn cancelled' }),
      settle: scope.settle,
    });

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

        const toolResults = await executeCompanionToolCalls(
          { toolRegistry: this.toolRegistry, permissionManager: this.permissionManager, hookDispatcher: this.hookDispatcher, runtimeBus: this.runtimeBus },
          toolCalls, publish, sessionId, turnId,
        );
        session.conversation.addToolResults(toolResults);
      }

      if (!completed && !abortSignal.aborted) {
        const finalResponse = await runToolExhaustionFinalizer(
          { provider: this.provider, finalizerPrompt: TOOL_EXHAUSTION_FINALIZER_PROMPT },
          session, abortSignal, turnId, publish,
        );
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

      // A detected abort (user cancel, session close, or shutdown) where the
      // provider ended its stream gracefully instead of throwing: finalize as
      // a cancellation — persist the honest partial and emit the terminal
      // turn.cancelled — never record it as a successful complete reply.
      if (abortSignal.aborted) {
        finalizeCancelled();
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
        inReplyTo: userMessageId,
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
        finalizeCancelled();
      }
    } finally {
      // Release the active-turn slot only if this turn still owns it (a newer
      // concurrent turn may have taken it), detach the session-abort chain,
      // and settle for any exit path that did not run finalizeCancelled
      // (resolve is idempotent — a second call is a no-op).
      if (session.activeTurn === scope.activeTurn) session.activeTurn = null;
      scope.detach();
      scope.settle({ partialPersisted: false });
      // Drain: a queued send (or a steer that jumped the queue) starts now.
      this._startNextTurn(session);
    }
  }

  // ---------------------------------------------------------------------------
  // Regenerate + edit-and-branch (honest lineage — see companion-chat-branching.ts)
  // ---------------------------------------------------------------------------

  /**
   * Regenerate an assistant response: supersede the target assistant message (an
   * explicit id, or the latest response) and everything after it — retained as
   * history, never deleted — then re-run a fresh turn from the preceding user
   * message. Refuses a closed (409 SESSION_CLOSED) or unknown (404
   * SESSION_NOT_FOUND) session; honest code when there is nothing to regenerate.
   */
  regenerateMessage(
    sessionId: string,
    input: RegenerateCompanionChatMessageInput = {},
  ): RegenerateCompanionChatMessageOutput {
    const session = this._requireOpenSession(sessionId);
    this.rateLimiter?.check(sessionId, '');
    const now = Date.now();
    const plan = planRegenerate(session, input.messageId, now);
    this._commitBranchAndRun(session, sessionId, plan.anchorUserMessageId, now);
    const { regeneratedFrom, supersededMessageIds } = plan;
    return { sessionId, regeneratedFrom, supersededMessageIds, turnStarted: true };
  }

  /**
   * Edit a user message and branch from it: supersede the target user message and
   * everything after it (retained history), append a new user message carrying
   * `revisionOf` back to the original, and run a fresh turn. Same closed/unknown
   * refusals as {@link regenerateMessage}.
   */
  editMessage(
    sessionId: string,
    input: EditCompanionChatMessageInput,
  ): EditCompanionChatMessageOutput {
    const session = this._requireOpenSession(sessionId);
    this.rateLimiter?.check(sessionId, '');
    const now = Date.now();
    const plan = applyEditBranch(session, sessionId, input, this.artifactStore, now);
    this._commitBranchAndRun(session, sessionId, plan.newMessageId, now);
    const { editedFrom, newMessageId, supersededMessageIds } = plan;
    return { sessionId, editedFrom, messageId: newMessageId, supersededMessageIds, turnStarted: true };
  }

  /** Look up an active (open) session or throw the closed/not-found machine codes. */
  private _requireOpenSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: 'SESSION_NOT_FOUND', status: 404 });
    }
    if (session.meta.status === 'closed') {
      throw Object.assign(new Error('Session is closed'), { code: SDKErrorCodes.SESSION_CLOSED, status: 409 });
    }
    return session;
  }

  /**
   * Shared tail of regenerate/edit: rebuild the LLM-facing conversation from the
   * ACTIVE (non-superseded) chain (mirroring init()'s replay so the next turn
   * sees only the live branch), persist, and fire the new turn.
   */
  private _commitBranchAndRun(
    session: InternalSession,
    sessionId: string,
    anchorUserMessageId: string,
    now: number,
  ): void {
    const conversation = new ConversationManager();
    for (const msg of activeMessages(session.messages)) {
      if (msg.role === 'user') conversation.addUserMessage(buildReplayUserContent(msg));
      else conversation.addAssistantMessage(msg.content);
    }
    session.conversation = conversation;
    this._updateMeta(session, { messageCount: session.messages.length, updatedAt: now });
    this._persist(sessionId);
    void this._runTurn(session, anchorUserMessageId).catch((error: unknown) => {
      logger.warn('[companion-chat] branch turn execution failed', { sessionId, error: summarizeError(error) });
    });
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
   * 'delete-persistent' action. Never fork this. Order matters:
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
