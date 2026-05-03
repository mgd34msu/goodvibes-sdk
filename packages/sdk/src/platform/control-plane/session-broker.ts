import { logger } from '../utils/logger.js';
import { sessionsActive } from '../runtime/metrics.js';
import { PersistentStore } from '../state/persistent-store.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type {
  SharedSessionCompletion,
  SharedSessionContinuationRunner,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
} from './session-intents.js';
import type {
  FindSharedSessionOptions,
  SharedSessionMessage,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionSubmission,
  SteerSharedSessionMessageInput,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import {
  type SharedSessionAgentStatusProvider,
  type SharedSessionEventPublisher,
  type SharedSessionMessageSender,
  type SharedSessionStoreSnapshot,
} from './session-broker-helpers.js';
import {
  createSessionBrokerSnapshot,
  loadSessionBrokerState,
  sortSessions,
} from './session-broker-state.js';
import {
  claimNextQueuedSessionInput,
  finalizeAgentSessionInputs,
  recordSharedSessionInput,
  refreshPendingInputCount,
  touchSharedSession,
  updateSharedSessionInput,
} from './session-broker-inputs.js';
import {
  appendSharedSessionMessage,
  buildSharedSessionContinuationTask,
  listSharedSessionMessages,
  type AppendSharedSessionMessageInput,
} from './session-broker-messages.js';
import {
  attachSharedSessionParticipantAndRoute,
  bindSharedSessionAgent,
  closeSharedSessionRecord,
  createSharedSessionRecord,
  reopenSharedSessionRecord,
} from './session-broker-sessions.js';
import { sweepSharedSessions } from './session-broker-gc.js';
import { SharedSessionRuntimeBusBridge } from './session-broker-runtime-bus.js';

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

export class SharedSessionBroker {
  private readonly store: PersistentStore<SharedSessionStoreSnapshot>;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly messages = new Map<string, SharedSessionMessage[]>();
  private readonly inputs = new Map<string, SharedSessionInputRecord[]>();
  private readonly runtimeBusBridge = new SharedSessionRuntimeBusBridge();
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private continuationRunner: SharedSessionContinuationRunner | null = null;
  private loaded = false;
  private _gcInterval: ReturnType<typeof setInterval> | null = null;

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
    this.runtimeBusBridge.stopAll();
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
    return this.runtimeBusBridge.attach(
      bus,
      sessionResolver,
      (sessionId, agentId, body, metadata) => this.completeAgent(sessionId, agentId, body, metadata),
    );
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
      const iv = setInterval(() => { this.gcSweep(); }, 60_000);
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
    return listSharedSessionMessages(this.messageStore(), sessionId, limit);
  }

  getInputs(sessionId: string, limit = 100): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  async createSession(input: {
    readonly id?: string;
    readonly title?: string;
    readonly metadata?: Record<string, unknown>;
    readonly routeBinding?: AutomationRouteBinding;
    readonly participant?: SharedSessionParticipant;
    readonly kind?: SharedSessionRecord['kind'];
  } = {}): Promise<SharedSessionRecord> {
    await this.start();
    const session = createSharedSessionRecord(input);
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
    this.touch(sessionId);
    const touched = this.sessions.get(sessionId)!; // re-fetch after touch
    const updated = closeSharedSessionRecord(touched);
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
    const updated = reopenSharedSessionRecord(session);
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-reopened', updated);
    return updated;
  }

  async bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated = bindSharedSessionAgent(session, agentId);
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
    input: Omit<AppendSharedSessionMessageInput, 'sessionId'>,
  ): Promise<SharedSessionMessage> {
    await this.start();
    const message = appendSharedSessionMessage(this.messageStore(), {
      sessionId,
      ...input,
    }, MAX_PERSISTED_MESSAGES);
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
    this.touch(session.id);
    const existing = this.sessions.get(session.id) ?? session;
    const updated = attachSharedSessionParticipantAndRoute({ session: existing, message: input, binding });
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
    return buildSharedSessionContinuationTask({
      session: this.sessions.get(sessionId) ?? null,
      messages: this.getMessages(sessionId, MAX_CONTINUATION_MESSAGES),
      fallbackSessionId: sessionId,
    });
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
    return recordSharedSessionInput(this.sessionInputStore(), {
      sessionId,
      intent,
      message: input,
      routeId,
      causationId,
      maxPersistedInputs: MAX_PERSISTED_INPUTS,
    });
  }

  private updateInput(
    sessionId: string,
    inputId: string,
    transform: (input: SharedSessionInputRecord) => SharedSessionInputRecord,
  ): SharedSessionInputRecord | null {
    return updateSharedSessionInput(this.sessionInputStore(), sessionId, inputId, transform);
  }

  private claimNextQueuedInput(sessionId: string, agentId: string): SharedSessionInputRecord | null {
    return claimNextQueuedSessionInput(this.sessionInputStore(), sessionId, agentId);
  }

  private finalizeAgentInputs(
    sessionId: string,
    agentId: string,
    nextState: Extract<SharedSessionInputRecord['state'], 'completed' | 'failed' | 'cancelled'>,
    error?: string,
  ): SharedSessionInputRecord[] {
    return finalizeAgentSessionInputs(this.sessionInputStore(), sessionId, agentId, nextState, error);
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

  private sessionInputStore(): {
    sessions: Map<string, SharedSessionRecord>;
    inputs: Map<string, SharedSessionInputRecord[]>;
  } {
    return { sessions: this.sessions, inputs: this.inputs };
  }

  private messageStore(): {
    sessions: Map<string, SharedSessionRecord>;
    messages: Map<string, SharedSessionMessage[]>;
  } {
    return { sessions: this.sessions, messages: this.messages };
  }

  private touch(sessionId: string): void {
    touchSharedSession(this.sessionInputStore(), sessionId);
  }

  private refreshPendingInputCount(sessionId: string): void {
    refreshPendingInputCount(this.sessionInputStore(), sessionId);
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
  private gcSweep(): void {
    const anyChanged = sweepSharedSessions(
      { sessions: this.sessions, messages: this.messages, inputs: this.inputs },
      {
        idleEmptyMs: this._idleEmptyMs,
        idleLongMs: this._idleLongMs,
        deletionRetentionMs: SESSION_DELETION_RETENTION_MS,
        publishUpdate: (event, payload) => this.publishUpdate(event, payload),
      },
    );
    if (anyChanged) {
      void this.persist().catch((error: unknown) => {
        logger.warn('[session-broker] GC persistence failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}
