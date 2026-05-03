import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { sessionsActive } from '../runtime/metrics.js';
import { PersistentStore } from '../state/persistent-store.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentEvent } from '../../events/agents.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type {
  SharedSessionCompletion,
  SharedSessionContinuationRunner,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
} from './session-intents.js';
import type {
  FindSharedSessionOptions,
  SharedSessionMessage,
  SharedSessionMessageRole,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import {
  dedupeSessionSurfaceKinds,
  type SharedSessionAgentStatusProvider,
  type SharedSessionEventPublisher,
  type SharedSessionMessageSender,
  type SharedSessionStoreSnapshot,
} from './session-broker-helpers.js';
import {
  countPendingSessionInputs,
  createSessionBrokerSnapshot,
  loadSessionBrokerState,
  sortInputs,
  sortMessages,
  sortSessions,
  upsertSessionParticipant,
} from './session-broker-state.js';

const MAX_PERSISTED_MESSAGES = 2_000;
const MAX_CONTINUATION_MESSAGES = 16;
/** Max inputs retained per session bucket. */
const MAX_PERSISTED_INPUTS = 500;
/**
 * How long a closed session is retained in Maps before hard deletion.
 * Allows trailing reads (e.g. status checks shortly after close) to still
 * see the final record. Default: 5 minutes.
 */
const SESSION_DELETION_RETENTION_MS = 5 * 60_000;

/** Scoped input-widening for createSession — avoids `any`, points at the exact expected shape. */
interface CreateSessionInputWithKind {
  readonly kind?: SharedSessionRecord['kind'];
}

export class SharedSessionBroker {
  private readonly store: PersistentStore<SharedSessionStoreSnapshot>;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly messages = new Map<string, SharedSessionMessage[]>();
  private readonly inputs = new Map<string, SharedSessionInputRecord[]>();
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private continuationRunner: SharedSessionContinuationRunner | null = null;
  private loaded = false;
  private _gcInterval: ReturnType<typeof setInterval> | null = null;
  private _busUnsubs: Array<() => void> = [];
  private _busAttached = false;

  /** Default idle threshold for zero-message sessions (ms). */
  private readonly _idleEmptyMs: number;
  /** Default idle threshold for sessions with content (ms). */
  private readonly _idleLongMs: number;

  /**
   * @param config.idleEmptyMs - Idle timeout for empty (0-message) sessions (default: 10 minutes).
   * @param config.idleLongMs  - Idle timeout for sessions with content (default: 24 hours).
   */
  constructor(config: {
    readonly store?: PersistentStore<SharedSessionStoreSnapshot>;
    readonly storePath?: string;
    readonly routeBindings: RouteBindingManager;
    readonly agentStatusProvider: SharedSessionAgentStatusProvider;
    readonly messageSender: SharedSessionMessageSender;
    readonly idleEmptyMs?: number;
    readonly idleLongMs?: number;
  }) {
    if (!config.store && !config.storePath) {
      throw new Error('SharedSessionBroker requires an explicit store or storePath.');
    }
    const storePath = config.storePath;
    this.store = config.store ?? new PersistentStore<SharedSessionStoreSnapshot>(storePath as string);
    this.routeBindings = config.routeBindings;
    this.agentStatusProvider = config.agentStatusProvider;
    this.messageSender = config.messageSender;
    this._idleEmptyMs = config.idleEmptyMs ?? 10 * 60 * 1000;  // 10 min
    this._idleLongMs  = config.idleLongMs  ?? 24 * 60 * 60 * 1000; // 24 h
  }

  setEventPublisher(publisher: SharedSessionEventPublisher | null): void {
    this.eventPublisher = publisher;
  }

  /**
   * Returns the number of sessions that currently have a pending input
   * (i.e. pendingInputCount > 0). Used by WorkspaceSwapManager to determine
   * whether the daemon is busy before allowing a workspace swap.
   */
  countBusySessions(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.pendingInputCount > 0) count++;
    }
    return count;
  }

  /**
   * M3: Gracefully stop the broker — clears GC interval, tears down bus subscriptions,
   * and persists state. Call from DaemonServer.stop().
   */
  async stop(): Promise<void> {
    if (this._gcInterval) {
      clearInterval(this._gcInterval);
      this._gcInterval = null;
    }
    for (const u of this._busUnsubs) {
      try {
        u();
      } catch (error) {
        logger.warn('SharedSessionBroker bus unsubscribe failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this._busUnsubs = [];
    this._busAttached = false;
    await this.persist();
  }

  /**
   * Wire the broker to a RuntimeEventBus so agent terminal events automatically
   * reconcile session inputs and task state.
   *
   * Call once after both the broker and the bus are constructed. Returns an
   * unsubscribe function that tears down the subscriptions.
   *
   * @param bus - The active RuntimeEventBus.
   * @param sessionResolver - Maps agentId → sessionId for the active session.
   *   Return `null` when the agent is not associated with a shared session.
   */
  attachRuntimeBus(
    bus: RuntimeEventBus,
    sessionResolver: (agentId: string) => string | null,
  ): () => void {
    // m3: idempotent — second call is a no-op with a warning
    if (this._busAttached) {
      // Emit via console.warn so call-sites that spy on console.warn can observe it.
      console.warn('SharedSessionBroker.attachRuntimeBus: already attached, ignoring', { busAttached: true });
      logger.warn('[SharedSessionBroker] attachRuntimeBus called more than once — ignoring duplicate call', {});
      return () => {};
    }
    this._busAttached = true;
    const onCompleted = bus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>(
      'AGENT_COMPLETED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        // m1: catch to prevent unhandled rejections
        this.completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.output ?? '',
          { status: 'completed', durationMs: envelope.payload.durationMs },
        ).catch((err) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_COMPLETED', { error: String(err) });
        });
      },
    );
    const onFailed = bus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>(
      'AGENT_FAILED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        // m1: catch to prevent unhandled rejections
        this.completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.error,
          { status: 'failed', durationMs: envelope.payload.durationMs },
        ).catch((err) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_FAILED', { error: String(err) });
        });
      },
    );
    const onCancelled = bus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>(
      'AGENT_CANCELLED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const sessionId = sessionResolver(envelope.payload.agentId);
        if (!sessionId) return;
        // m1: catch to prevent unhandled rejections
        this.completeAgent(
          sessionId,
          envelope.payload.agentId,
          envelope.payload.reason ?? 'cancelled',
          { status: 'cancelled' },
        ).catch((err) => {
          logger.error('[SharedSessionBroker] completeAgent error on AGENT_CANCELLED', { error: String(err) });
        });
      },
    );
    this._busUnsubs.push(onCompleted, onFailed, onCancelled);
    return () => {
      onCompleted();
      onFailed();
      onCancelled();
      this._busAttached = false;
      this._busUnsubs = this._busUnsubs.filter(
        (fn) => fn !== onCompleted && fn !== onFailed && fn !== onCancelled,
      );
    };
  }

  setContinuationRunner(runner: SharedSessionContinuationRunner | null): void {
    this.continuationRunner = runner;
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    await this.routeBindings.start();
    const { sessions, messages, inputs } = loadSessionBrokerState(await this.store.load());
    this.sessions.clear();
    this.messages.clear();
    this.inputs.clear();
    for (const session of sessions.values()) {
      this.sessions.set(session.id, session);
    }
    for (const [sessionId, bucket] of messages.entries()) {
      this.messages.set(sessionId, bucket);
    }
    for (const [sessionId, bucket] of inputs.entries()) {
      this.inputs.set(sessionId, bucket);
    }
    this.loaded = true;
    // M2: startup reconciliation — cancel inputs stuck in spawned/delivered from a prior run
    const restartReason = 'daemon restart — agent state unknown';
    for (const [sessionId, bucket] of this.inputs.entries()) {
      let changed = false;
      for (let i = 0; i < bucket.length; i++) {
        const entry = bucket[i];
        if (entry.state === 'spawned' || entry.state === 'delivered') {
          bucket[i] = { ...entry, state: 'cancelled', updatedAt: Date.now(), error: restartReason };
          changed = true;
        }
      }
      if (changed) this.refreshPendingInputCount(sessionId);
    }
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.activeAgentId) {
        this.sessions.set(sessionId, { ...session, activeAgentId: undefined, updatedAt: Date.now() });
      }
    }
    await this.persist();
    if (!this._gcInterval) {
      // M3: .unref() so the GC interval does not keep the process alive past shutdown
      const iv = setInterval(() => { this._gcSweep(); }, 60_000);
      (iv as unknown as { unref?: () => void }).unref?.();
      this._gcInterval = iv;
    }
  }

  listSessions(limit = 100): SharedSessionRecord[] {
    return sortSessions(this.sessions.values()).slice(0, Math.max(1, limit));
  }

  getSession(sessionId: string): SharedSessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async findPreferredSession(options: FindSharedSessionOptions = {}): Promise<SharedSessionRecord | null> {
    await this.start();
    const candidates = this.listSessions(500).filter((session) => {
      if (!options.includeClosed && session.status === 'closed') return false;
      if (options.routeId && !session.routeIds.includes(options.routeId)) return false;
      if (options.surfaceKind && !session.surfaceKinds.includes(options.surfaceKind)) return false;
      return true;
    });
    return candidates[0] ?? null;
  }

  async ensureSession(input: {
    readonly sessionId?: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
    readonly routeBinding?: AutomationRouteBinding;
    readonly participant?: SharedSessionParticipant;
  } = {}): Promise<SharedSessionRecord> {
    await this.start();
    if (input.sessionId) {
      const existing = this.sessions.get(input.sessionId);
      if (existing) {
        if (existing.status === 'closed') {
          return (await this.reopenSession(existing.id)) ?? existing;
        }
        return existing;
      }
    }
    return this.createSession({
      id: input.sessionId,
      title: input.title,
      metadata: input.metadata,
      routeBinding: input.routeBinding,
      participant: input.participant,
    });
  }

  getMessages(sessionId: string, limit = 100): SharedSessionMessage[] {
    const bucket = this.messages.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  getInputs(sessionId: string, limit = 100): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  /**
   * Reserved session IDs that must never be assigned to real sessions.
   * Empty string is reserved to distinguish system-emitted events from user
   * sessions. 'system' is reserved for runtime-authored records.
   */
  private static readonly RESERVED_SESSION_IDS = new Set(['', 'system']);

  async createSession(input: {
    readonly id?: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
    readonly routeBinding?: AutomationRouteBinding;
    readonly participant?: SharedSessionParticipant;
  } = {}): Promise<SharedSessionRecord> {
    if (input.id !== undefined && SharedSessionBroker.RESERVED_SESSION_IDS.has(input.id)) {
      throw Object.assign(
        new Error(`INVALID_SESSION_ID: '${input.id}' is a reserved session ID and cannot be assigned to a real session.`),
        { code: 'INVALID_SESSION_ID' },
      );
    }
    await this.start();
    const now = Date.now();
    const sessionId = input.id ?? `sess-${randomUUID().slice(0, 8)}`;
    const participant = input.participant;
    const participants = participant ? [participant] : [];
    const routeIds = input.routeBinding?.id ? [input.routeBinding.id] : [];
    const session: SharedSessionRecord = {
      id: sessionId,
      kind: (input as unknown as CreateSessionInputWithKind).kind ?? 'tui',
      title: input.title?.trim() || input.routeBinding?.title || `Session ${sessionId}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: undefined,
      closedAt: undefined,
      lastActivityAt: now,
      messageCount: 0,
      pendingInputCount: 0,
      routeIds,
      surfaceKinds: participant ? [participant.surfaceKind] : input.routeBinding ? [input.routeBinding.surfaceKind] : [],
      participants,
      activeAgentId: undefined,
      lastAgentId: undefined,
      lastError: undefined,
      metadata: {
        ...(input.metadata ?? {}),
      },
    };
    this.sessions.set(session.id, session);
    if (input.routeBinding?.id) {
      await this.routeBindings.patchBinding(input.routeBinding.id, { sessionId: session.id });
    }
    await this.persist();
    // C-1: update active session gauge
    sessionsActive.set(this.sessions.size);
    this.publishUpdate('session-created', session);
    return session;
  }

  async closeSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this._touch(sessionId); // M4: uniform touch before mutation
    const touched = this.sessions.get(sessionId)!; // re-fetch after touch
    const now = Date.now();
    const updated: SharedSessionRecord = {
      ...touched,
      status: 'closed',
      activeAgentId: undefined,
      updatedAt: now,
      closedAt: now,
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    // C-1: update active session gauge
    sessionsActive.set(this.sessions.size);
    this.publishUpdate('session-closed', updated);
    return updated;
  }

  async reopenSession(sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated: SharedSessionRecord = {
      ...session,
      status: 'active',
      updatedAt: Date.now(),
      closedAt: undefined,
    };
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-reopened', updated);
    return updated;
  }

  async bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated: SharedSessionRecord = {
      ...session,
      activeAgentId: agentId,
      lastAgentId: agentId,
      updatedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.sessions.set(sessionId, updated);
    const claimed = this.claimNextQueuedInput(sessionId, agentId);
    await this.persist();
    this.publishUpdate('session-agent-bound', updated);
    if (claimed) {
      this.publishInputLifecycleEvent('session-input-spawned', claimed, {
        agentId,
      });
    }
    return updated;
  }

  async submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('submit', input, true);
  }

  async steerMessage(input: SteerSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('steer', input, input.allowSpawnFallback === true);
  }

  async followUpMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission> {
    return await this.handleIntent('follow-up', input, true);
  }

  async appendSystemMessage(sessionId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionMessage | null> {
    if (!body.trim()) return null;
    return this.appendMessage(sessionId, {
      role: 'system',
      body,
      metadata,
    });
  }

  /**
   * Persist a companion follow-up message to the shared session message log
   * without spawning an agent. Called by the companion main-chat send path
   * (kind='message') so that GET /api/sessions/:id/messages surfaces the message
   * and TUI subscribers can render it.
   */
  async appendCompanionMessage(
    sessionId: string,
    input: {
      readonly messageId: string;
      readonly body: string;
      readonly timestamp: number;
      readonly source: string;
    },
  ): Promise<SharedSessionMessage | null> {
    if (!input.body.trim()) return null;
    return this.appendMessage(sessionId, {
      role: 'user',
      body: input.body,
      metadata: {
        source: input.source,
        messageId: input.messageId,
        timestamp: input.timestamp,
      },
    });
  }

  async completeAgent(sessionId: string, agentId: string, body: string, metadata: Record<string, unknown> = {}): Promise<SharedSessionCompletion | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    await this.appendMessage(sessionId, {
      role: metadata.status === 'failed' || metadata.status === 'cancelled' ? 'system' : 'assistant',
      body,
      agentId,
      metadata,
    });
    const now = Date.now();
    const updated: SharedSessionRecord = {
      ...(this.sessions.get(sessionId) ?? session),
      activeAgentId: (this.sessions.get(sessionId)?.activeAgentId === agentId) ? undefined : this.sessions.get(sessionId)?.activeAgentId,
      lastAgentId: agentId,
      updatedAt: now,
      lastActivityAt: now, // M4: completeAgent explicitly updates lastActivityAt
      ...(metadata.status === 'failed' ? { lastError: body } : {}),
    };
    this._touch(sessionId); // M4: touch after mutation
    this.sessions.set(sessionId, updated);
    const finalizedInputs = this.finalizeAgentInputs(
      sessionId,
      agentId,
      metadata.status === 'failed' ? 'failed' : metadata.status === 'cancelled' ? 'cancelled' : 'completed',
      metadata.status === 'failed' ? body : undefined,
    );
    await this.persist();
    this.publishUpdate('session-agent-completed', {
      sessionId,
      agentId,
      status: metadata.status ?? 'completed',
    });
    for (const finalized of finalizedInputs) {
      this.publishInputLifecycleEvent(`session-input-${finalized.state}`, finalized, { agentId });
    }
    const continuation = await this.runQueuedFollowUp(sessionId);
    return {
      session: this.sessions.get(sessionId)!,
      ...(continuation?.input ? { continuedInput: continuation.input } : {}),
      ...(continuation?.agentId ? { continuedAgentId: continuation.agentId } : {}),
    };
  }

  async cancelInput(sessionId: string, inputId: string): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const updated = this.updateInput(sessionId, inputId, (entry) => {
      if (entry.state !== 'queued') return entry;
      return {
        ...entry,
        state: 'cancelled',
        updatedAt: Date.now(),
      };
    });
    if (!updated) return null;
    this.refreshPendingInputCount(sessionId);
    await this.persist();
    this.publishInputLifecycleEvent('session-input-cancelled', updated);
    return updated;
  }

  async rebindRoute(bindingId: string, sessionId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const binding = await this.routeBindings.patchBinding(bindingId, { sessionId });
    if (!binding) return null;
    return this.attachParticipantAndRoute(session, {
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      externalId: binding.externalId,
      threadId: binding.threadId,
      userId: typeof binding.metadata.userId === 'string' ? binding.metadata.userId : undefined,
      displayName: typeof binding.metadata.userName === 'string' ? binding.metadata.userName : undefined,
      body: '',
    }, binding);
  }

  private async appendMessage(
    sessionId: string,
    input: {
      readonly role: SharedSessionMessageRole;
      readonly body: string;
      readonly surfaceKind?: AutomationSurfaceKind;
      readonly surfaceId?: string;
      readonly routeId?: string;
      readonly agentId?: string;
      readonly userId?: string;
      readonly displayName?: string;
      readonly metadata?: Record<string, unknown>;
    },
  ): Promise<SharedSessionMessage> {
    await this.start();
    const message: SharedSessionMessage = {
      id: `smsg-${randomUUID().slice(0, 8)}`,
      sessionId,
      role: input.role,
      body: input.body,
      createdAt: Date.now(),
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      routeId: input.routeId,
      agentId: input.agentId,
      userId: input.userId,
      displayName: input.displayName,
      metadata: input.metadata ?? {},
    };
    const bucket = this.messages.get(sessionId) ?? [];
    bucket.push(message);
    while (bucket.length > MAX_PERSISTED_MESSAGES) {
      bucket.shift();
    }
    this.messages.set(sessionId, bucket);
    const session = this.sessions.get(sessionId);
    if (session) {
      const updated: SharedSessionRecord = {
        ...session,
        messageCount: bucket.length,
        lastMessageAt: message.createdAt,
        updatedAt: message.createdAt,
        lastActivityAt: message.createdAt,
      };
      this.sessions.set(sessionId, updated);
    }
    await this.persist();
    this.publishUpdate('session-message-appended', {
      sessionId,
      message,
    });
    return message;
  }

  private async attachParticipantAndRoute(
    session: SharedSessionRecord,
    input: Omit<SubmitSharedSessionMessageInput, 'metadata'>,
    binding?: AutomationRouteBinding,
  ): Promise<SharedSessionRecord> {
    this._touch(session.id); // M4
    const existing = this.sessions.get(session.id) ?? session;
    const nextRouteIds = binding?.id
      ? [...new Set([...existing.routeIds, binding.id])]
      : [...existing.routeIds];
    const participants = upsertSessionParticipant(existing.participants, {
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      userId: input.userId,
      displayName: input.displayName,
      routeId: binding?.id,
      lastSeenAt: Date.now(),
    });
    const updated: SharedSessionRecord = {
      ...existing,
      title: input.title?.trim() || existing.title,
      status: existing.status === 'closed' ? 'active' : existing.status,
      updatedAt: Date.now(),
      closedAt: existing.status === 'closed' ? undefined : existing.closedAt,
      routeIds: nextRouteIds,
      participants,
      surfaceKinds: dedupeSessionSurfaceKinds(participants),
      metadata: {
        ...existing.metadata,
      },
    };
    this.sessions.set(updated.id, updated);
    if (binding?.id) {
      await this.routeBindings.patchBinding(binding.id, { sessionId: updated.id });
    }
    await this.persist();
    this.publishUpdate('session-route-attached', {
      sessionId: updated.id,
      routeId: binding?.id,
    });
    return updated;
  }

  private resolveActiveAgentId(session: SharedSessionRecord): string | undefined {
    if (!session.activeAgentId) return undefined;
    const agent = this.agentStatusProvider.getStatus(session.activeAgentId);
    if (!agent) return undefined;
    return agent.status === 'pending' || agent.status === 'running' ? agent.id : undefined;
  }

  private async resolveBinding(input: SubmitSharedSessionMessageInput): Promise<AutomationRouteBinding | null> {
    if (input.routeId) {
      return this.routeBindings.getBinding(input.routeId) ?? null;
    }
    if (!input.externalId) return null;
    return this.routeBindings.resolve(input.surfaceKind, input.externalId, input.threadId) ?? null;
  }

  private buildContinuationTask(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    const history = this.getMessages(sessionId, MAX_CONTINUATION_MESSAGES);
    const transcript = history
      .map((message) => {
        const speaker = message.role === 'assistant'
          ? 'Assistant'
          : message.role === 'system'
            ? 'System'
            : `${message.displayName ?? message.userId ?? 'User'}`;
        return `${speaker}: ${message.body}`;
      })
      .join('\n\n');
    return [
      `Continue the shared control-plane session "${session?.title ?? sessionId}".`,
      'Preserve continuity with the recent transcript and answer the newest user message directly.',
      transcript ? `Recent transcript:\n${transcript}` : '',
    ].filter(Boolean).join('\n\n');
  }

  private async persist(): Promise<void> {
    await this.store.persist(createSessionBrokerSnapshot({
      sessions: this.sessions,
      messages: this.messages,
      inputs: this.inputs,
    }, MAX_PERSISTED_MESSAGES));
  }

  private publishUpdate(event: string, payload: unknown): void {
    this.eventPublisher?.('session-update', {
      event,
      payload,
      createdAt: Date.now(),
    });
  }

  private publishInputLifecycleEvent(
    event: string,
    input: SharedSessionInputRecord,
    extra: Record<string, unknown> = {},
  ): void {
    this.publishUpdate(event, {
      sessionId: input.sessionId,
      inputId: input.id,
      intent: input.intent,
      state: input.state,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      ...(input.activeAgentId ? { activeAgentId: input.activeAgentId } : {}),
      ...extra,
    });
  }

  private async handleIntent(
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    allowSpawnFallback: boolean,
  ): Promise<SharedSessionSubmission> {
    await this.start();

    const binding = await this.resolveBinding(input);
    let session = input.sessionId ? this.sessions.get(input.sessionId) ?? undefined : undefined;
    let created = false;
    if (!session && binding?.sessionId) {
      session = this.sessions.get(binding.sessionId) ?? undefined;
    }
    if (!session) {
      const participant: SharedSessionParticipant = {
        surfaceKind: input.surfaceKind,
        surfaceId: input.surfaceId,
        externalId: input.externalId,
        userId: input.userId,
        displayName: input.displayName,
        routeId: binding?.id,
        lastSeenAt: Date.now(),
      };
      session = await this.createSession({
        title: input.title,
        metadata: input.metadata,
        routeBinding: binding ?? undefined,
        participant,
      });
      created = true;
    }

    const updatedSession = await this.attachParticipantAndRoute(session, input, binding ?? undefined);
    const userMessage = await this.appendMessage(updatedSession.id, {
      role: 'user',
      body: input.body,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      routeId: binding?.id,
      userId: input.userId,
      displayName: input.displayName,
      metadata: {
        ...(input.metadata ?? {}),
        sessionIntent: intent,
      },
    });
    const queuedInput = this.recordInput(updatedSession.id, intent, input, binding?.id, userMessage.id);
    this.publishInputLifecycleEvent('session-input-queued', queuedInput, {
      messageId: userMessage.id,
    });

    const activeAgentId = this.resolveActiveAgentId(updatedSession);
    if (intent !== 'follow-up' && activeAgentId) {
      const sent = this.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
      if (sent) {
        const delivered = this.updateInput(updatedSession.id, queuedInput.id, (entry) => ({
          ...entry,
          state: 'delivered',
          activeAgentId,
          updatedAt: Date.now(),
        })) ?? queuedInput;
        await this.persist();
        this.publishInputLifecycleEvent('session-input-delivered', delivered, {
          agentId: activeAgentId,
          messageId: userMessage.id,
        });
        this.publishUpdate('session-message-forwarded', {
          sessionId: updatedSession.id,
          agentId: activeAgentId,
          messageId: userMessage.id,
          inputId: delivered.id,
          intent,
        });
        return {
          session: this.sessions.get(updatedSession.id)!,
          userMessage,
          routeBinding: binding ?? undefined,
          input: delivered,
          intent,
          mode: 'continued-live',
          state: delivered.state,
          activeAgentId,
          created,
        };
      }
      if (intent === 'steer' && !allowSpawnFallback) {
        const rejected = this.updateInput(updatedSession.id, queuedInput.id, (entry) => ({
          ...entry,
          state: 'rejected',
          updatedAt: Date.now(),
          error: 'No active agent accepted the steer request.',
        })) ?? queuedInput;
        await this.persist();
        this.publishInputLifecycleEvent('session-input-rejected', rejected, {
          messageId: userMessage.id,
        });
        return {
          session: this.sessions.get(updatedSession.id)!,
          userMessage,
          routeBinding: binding ?? undefined,
          input: rejected,
          intent,
          mode: 'rejected',
          state: rejected.state,
          created,
        };
      }
    }

    if (intent === 'follow-up' && activeAgentId) {
      await this.persist();
      this.publishInputLifecycleEvent('session-follow-up-queued', queuedInput, {
        agentId: activeAgentId,
        messageId: userMessage.id,
      });
      return {
        session: this.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: queuedInput,
        intent,
        mode: 'queued-follow-up',
        state: queuedInput.state,
        activeAgentId,
        created,
      };
    }

    await this.persist();
    return {
      session: this.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'spawn',
      state: queuedInput.state,
      task: this.buildContinuationTask(updatedSession.id),
      created,
    };
  }

  private recordInput(
    sessionId: string,
    intent: SharedSessionInputIntent,
    input: SubmitSharedSessionMessageInput,
    routeId?: string,
    causationId?: string,
  ): SharedSessionInputRecord {
    this._touch(sessionId); // M4
    const id = `sin-${randomUUID().slice(0, 8)}`;
    const entry: SharedSessionInputRecord = {
      id,
      sessionId,
      intent,
      state: 'queued',
      correlationId: typeof input.metadata?.correlationId === 'string' ? input.metadata.correlationId : `session-input:${id}`,
      ...(causationId ? { causationId } : {}),
      body: input.body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      routeId,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      threadId: input.threadId,
      userId: input.userId,
      displayName: input.displayName,
      metadata: input.metadata ?? {},
      routing: input.routing,
    };
    const bucket = this.inputs.get(sessionId) ?? [];
    bucket.push(entry);
    // Cap input bucket to prevent unbounded growth (PERF-01 / MAX_PERSISTED_INPUTS).
    const sorted = sortInputs(bucket);
    if (sorted.length > MAX_PERSISTED_INPUTS) {
      sorted.splice(0, sorted.length - MAX_PERSISTED_INPUTS);
    }
    this.inputs.set(sessionId, sorted);
    this.refreshPendingInputCount(sessionId);
    return entry;
  }

  private updateInput(
    sessionId: string,
    inputId: string,
    transform: (input: SharedSessionInputRecord) => SharedSessionInputRecord,
  ): SharedSessionInputRecord | null {
    const bucket = this.inputs.get(sessionId);
    if (!bucket) return null;
    const index = bucket.findIndex((entry) => entry.id === inputId);
    if (index < 0) return null;
    const updated = transform(bucket[index]);
    bucket[index] = updated;
    this.inputs.set(sessionId, bucket);
    this.refreshPendingInputCount(sessionId);
    this._touch(sessionId); // M4
    return updated;
  }

  private claimNextQueuedInput(sessionId: string, agentId: string): SharedSessionInputRecord | null {
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.state === 'queued');
    if (!next) return null;
    const result = this.updateInput(sessionId, next.id, (entry) => ({
      ...entry,
      state: 'spawned',
      activeAgentId: agentId,
      updatedAt: Date.now(),
    }));
    this._touch(sessionId); // M4
    return result;
  }

  private finalizeAgentInputs(
    sessionId: string,
    agentId: string,
    nextState: Extract<SharedSessionInputRecord['state'], 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId);
    if (!bucket) return [];
    this._touch(sessionId); // M4: ensure direct callers also bump session timestamps
    let changed = false;
    const updatedInputs: SharedSessionInputRecord[] = [];
    for (let index = 0; index < bucket.length; index += 1) {
      const entry = bucket[index];
      if (entry.activeAgentId !== agentId) continue;
      if (entry.state !== 'delivered' && entry.state !== 'spawned') continue;
      bucket[index] = {
        ...entry,
        state: nextState,
        updatedAt: Date.now(),
        ...(error ? { error } : {}),
      };
      updatedInputs.push(bucket[index]!);
      changed = true;
    }
    if (changed) {
      this.inputs.set(sessionId, bucket);
      this.refreshPendingInputCount(sessionId);
    }
    return updatedInputs;
  }

  private async runQueuedFollowUp(sessionId: string): Promise<{ input: SharedSessionInputRecord; agentId: string } | null> {
    if (!this.continuationRunner) return null;
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.intent === 'follow-up' && entry.state === 'queued');
    if (!next) return null;
    const routeBinding = next.routeId ? this.routeBindings.getBinding(next.routeId) : undefined;
    const task = this.buildContinuationTask(sessionId);
    const spawned = await this.continuationRunner({
      sessionId,
      input: next,
      task,
      routeBinding,
    });
    if (!spawned?.agentId) return null;
    await this.bindAgent(sessionId, spawned.agentId);
    const claimed = this.inputs.get(sessionId)?.find((entry) => entry.activeAgentId === spawned.agentId && entry.state === 'spawned') ?? null;
    if (claimed) {
      this.publishInputLifecycleEvent('session-follow-up-spawned', claimed, {
        agentId: spawned.agentId,
      });
    }
    await this.persist();
    return claimed ? { input: claimed, agentId: spawned.agentId } : null;
  }

  // M4: touch helper — bumps lastActivityAt + updatedAt on a session
  private _touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const now = Date.now();
    this.sessions.set(sessionId, { ...s, lastActivityAt: now, updatedAt: now });
  }

  private refreshPendingInputCount(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const pendingInputCount = countPendingSessionInputs(this.inputs.get(sessionId) ?? []);
    this.sessions.set(sessionId, {
      ...session,
      pendingInputCount,
      updatedAt: Date.now(),
    });
  }

  /**
   * Periodic idle-session GC sweep.
   *
   * Policy:
   * - Sessions with messageCount === 0 AND no active agent AND idle longer than
   *   `_idleEmptyMs` (default 10min) are closed with reason `idle-empty`.
   * - Sessions with messageCount > 0 AND no active agent AND idle longer than
   *   `_idleLongMs` (default 24h) are closed with reason `idle-long`.
   *
   * "Idle" is measured from `lastActivityAt` (updated on createInput/bindAgent/
   * appendMessage). Sessions with an active agent are never GC'd.
   */
  private _gcSweep(): void {
    const now = Date.now();
    let anyChanged = false; // m4: track changed inline, not a second O(n) scan
    for (const [sessionId, session] of this.sessions.entries()) {
      // Hard-delete sessions that have been closed past the retention window.
      // This prevents unbounded growth of sessions/messages/inputs Maps (PERF-01).
      if (session.status === 'closed') {
        const closedAt = session.closedAt ?? session.updatedAt;
        if (now - closedAt >= SESSION_DELETION_RETENTION_MS) {
          this.sessions.delete(sessionId);
          this.messages.delete(sessionId);
          this.inputs.delete(sessionId);
          anyChanged = true;
        }
        continue;
      }

      if (session.status !== 'active') continue;
      if (session.activeAgentId) continue; // live agent — leave it
      if (session.pendingInputCount > 0) continue; // M4: never close sessions with pending inputs
      const idle = now - session.lastActivityAt;
      let reason: string | null = null;
      if (session.messageCount === 0 && idle >= this._idleEmptyMs) {
        reason = 'idle-empty';
      } else if (session.messageCount > 0 && idle >= this._idleLongMs) {
        reason = 'idle-long';
      }
      if (!reason) continue;
      const closed: SharedSessionRecord = {
        ...session,
        status: 'closed',
        activeAgentId: undefined,
        updatedAt: now,
        closedAt: now,
      };
      this.sessions.set(sessionId, closed);
      this.publishUpdate('session-closed', { ...closed, reason });
      anyChanged = true; // m4: set during loop, not a second scan
    }
    if (anyChanged) {
      void this.persist().catch((error: unknown) => {
        logger.warn('[session-broker] GC persistence failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}
