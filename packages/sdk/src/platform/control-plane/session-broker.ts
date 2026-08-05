import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { sessionsActive } from '../runtime/metrics.js';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { ConversationGateConfigReader } from '../agents/conversation-gate.js';
import type {
  SharedSessionCompletion,
  SharedSessionContinuationRunner,
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionSurfaceReplyBinder,
  SharedSessionSurfaceReplyBinding,
} from './session-intents.js';
import type {
  CreateSharedSessionInput,
  EnsureSharedSessionInput,
  FindSharedSessionOptions,
  ListSharedSessionsOptions,
  ParticipantRouteAttachInput,
  RegisterSharedSessionInput,
  SharedSessionMessage,
  SharedSessionRecord,
  SharedSessionRegisterResult,
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
  reconcileSessionBrokerBoot,
  sortSessions,
} from './session-broker-state.js';
import {
  applySurfaceInputDelivery,
  claimNextQueuedSessionInput,
  filterSessionInputsSince,
  finalizeAgentSessionInputs,
  refreshPendingInputCount,
  touchSharedSession,
  updateSharedSessionInput,
} from './session-broker-inputs.js';
import {
  appendSharedSessionMessage,
  buildSharedSessionContinuationTask,
  listSharedSessionMessages,
  shouldStoreAgentCompletion,
  type AppendSharedSessionMessageInput,
} from './session-broker-messages.js';
import {
  SESSION_SURFACE_MANAGED_METADATA_KEY,
  attachSharedSessionParticipantAndRoute,
  bindSharedSessionAgent,
  closeSharedSessionRecord,
  createSharedSessionRecord,
  detachSharedSessionParticipant,
  participantToAttachInput,
  registerSharedSession,
  reopenSharedSessionRecord,
} from './session-broker-sessions.js';
import { sweepSharedSessions } from './session-broker-gc.js';
import { SharedSessionRuntimeBusBridge } from './session-broker-runtime-bus.js';
import { handleSharedSessionIntent } from './session-broker-intent.js';

const MAX_PERSISTED_MESSAGES = 2_000;
const MAX_CONTINUATION_MESSAGES = 16;
/**
 * Default retention for CLOSED sessions (HISTORY): `POSITIVE_INFINITY` = retain
 * indefinitely, so the GC sweep NEVER deletes a closed session. A finite value
 * (constructor `deletionRetentionMs`) is the opt-in deletion authority. The store
 * is a full snapshot of memory, so there is no separate memory/disk eviction here
 * (unlike the companion manager); memory is bounded by the per-session cap below.
 */
const SESSION_DELETION_RETENTION_MS = Number.POSITIVE_INFINITY;

export class SharedSessionBroker {
  private readonly store: PersistentStore<SharedSessionStoreSnapshot>;
  /** The file this broker serves from, or null for an injected store. Boot folds/sweeps must NAME it, never re-derive it — see daemon/daemon-session-store-boot.ts. */
  readonly storePath: string | null;
  private readonly routeBindings: RouteBindingManager;
  private readonly agentStatusProvider: SharedSessionAgentStatusProvider;
  private readonly messageSender: SharedSessionMessageSender;
  private readonly conversationGateConfig: ConversationGateConfigReader | undefined;
  private readonly sessions = new Map<string, SharedSessionRecord>();
  private readonly messages = new Map<string, SharedSessionMessage[]>();
  private readonly inputs = new Map<string, SharedSessionInputRecord[]>();
  private readonly runtimeBusBridge = new SharedSessionRuntimeBusBridge();
  private readonly writes = new StoreWriteQueue();
  private eventPublisher: SharedSessionEventPublisher | null = null;
  private continuationRunner: SharedSessionContinuationRunner | null = null;
  private surfaceReplyBinder: SharedSessionSurfaceReplyBinder | null = null;
  private surfaceNoticeSender: ((routeId: string, text: string) => void) | null = null;
  private loaded = false;
  private _gcInterval: ReturnType<typeof setInterval> | null = null;

  /** Default idle threshold for zero-message sessions (ms). */
  private readonly _idleEmptyMs: number;
  /** Default idle threshold for sessions with content (ms). */
  private readonly _idleLongMs: number;
  /** Retention window (ms since closedAt) for CLOSED sessions; Infinity = retain forever. */
  private readonly _deletionRetentionMs: number;

  /** @param config idleEmptyMs (empty-session idle, default 10m), idleLongMs (default
   * 24h), deletionRetentionMs (closed-session delete age, default Infinity = retain). */
  constructor(config: {
    readonly store?: PersistentStore<SharedSessionStoreSnapshot> | undefined;
    readonly storePath?: string | undefined;
    readonly routeBindings: RouteBindingManager;
    readonly agentStatusProvider: SharedSessionAgentStatusProvider;
    readonly messageSender: SharedSessionMessageSender;
    readonly idleEmptyMs?: number | undefined;
    readonly idleLongMs?: number | undefined;
    readonly deletionRetentionMs?: number | undefined;
    /** Reads `conversationGate.*` so an inbound channel message is not handed to a running agent behind the gate's back; absent falls back to the gate's defaults, which gate every channel surface. */
    readonly conversationGateConfig?: ConversationGateConfigReader | undefined;
  }) {
    if (!config.store && !config.storePath) throw new Error('SharedSessionBroker requires an explicit store or storePath.');
    this.store = config.store ?? new PersistentStore<SharedSessionStoreSnapshot>(config.storePath as string);
    this.storePath = config.store ? null : (config.storePath ?? null); // null for an injected store: it has no file, and nothing may guess one for it
    this.routeBindings = config.routeBindings;
    this.agentStatusProvider = config.agentStatusProvider;
    this.messageSender = config.messageSender;
    this._idleEmptyMs = config.idleEmptyMs ?? 10 * 60 * 1000;  // 10 min
    this._idleLongMs  = config.idleLongMs  ?? 24 * 60 * 60 * 1000; // 24 h
    this._deletionRetentionMs = config.deletionRetentionMs ?? SESSION_DELETION_RETENTION_MS;
    this.conversationGateConfig = config.conversationGateConfig;
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
   * Gracefully stop the broker by clearing the GC interval, tearing down bus
   * subscriptions, and persisting state. Call from DaemonServer.stop().
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

  /**
   * Install the hook that routes an agent's answer back to the channel the
   * message arrived on. See SharedSessionSurfaceReplyBinder — the broker
   * announces every (agent, surface-originated input) pairing through it, so a
   * host wires the reply path once instead of per adapter.
   */
  setSurfaceReplyBinder(binder: SharedSessionSurfaceReplyBinder | null): void {
    this.surfaceReplyBinder = binder;
  }

  /**
   * Install the path for a one-line unsolicited message to a route's channel —
   * distinct from the reply binder above, which pairs an AGENT's answer with a
   * conversation. Today's only caller is the route-binding healing in
   * session-broker-intent.ts, telling a chat its conversation moved.
   */
  setSurfaceNoticeSender(sender: ((routeId: string, text: string) => void) | null): void {
    this.surfaceNoticeSender = sender;
  }

  private announceSurfaceReply(binding: SharedSessionSurfaceReplyBinding): void {
    if (!this.surfaceReplyBinder) return;
    // A local surface (a terminal the operator is sitting at) has no route
    // binding and needs no delivery; only announce something a channel could
    // actually carry.
    if (!binding.routeId && !binding.surfaceKind) return;
    try {
      this.surfaceReplyBinder(binding);
    } catch (error) {
      logger.error('Surface reply binding failed — an answer may not reach its conversation', {
        sessionId: binding.sessionId,
        agentId: binding.agentId,
        bindingId: binding.routeId ?? null,
        surface: binding.surfaceKind ?? null,
        reason: binding.reason,
        error: summarizeError(error),
      });
    }
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
    // Boot reconciliation: cancel stuck spawned/delivered inputs, clear stale activeAgentId.
    for (const sessionId of reconcileSessionBrokerBoot(this.sessions, this.inputs)) {
      this.refreshPendingInputCount(sessionId);
    }
    await this.persist();
    if (!this._gcInterval) {
      // .unref() so the GC interval does not keep the process alive past shutdown.
      const iv = setInterval(() => { this.gcSweep(); }, 60_000);
      (iv as unknown as { unref?: () => void }).unref?.();
      this._gcInterval = iv;
    }
  }

  listSessions(limit = 100, options: ListSharedSessionsOptions = {}): SharedSessionRecord[] {
    const sorted = sortSessions(this.sessions.values());
    const filtered = sorted.filter((session) => {
      if (options.project !== undefined && session.project !== options.project) return false;
      if (options.kind !== undefined && session.kind !== options.kind) return false;
      if (options.includeClosed === false && session.status === 'closed') return false;
      return true;
    });
    return filtered.slice(0, Math.max(1, limit));
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
      if (options.project !== undefined && session.project !== options.project) return false;
      return true;
    });
    return candidates[0] ?? null;
  }

  async ensureSession(input: EnsureSharedSessionInput = {}): Promise<SharedSessionRecord> {
    await this.start();
    const existing = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
    if (existing) {
      const active = existing.status === 'closed'
        ? (await this.reopenSession(existing.id)) ?? existing
        : existing;
      // Adopt: record the participant + advance lastSeenAt (register heartbeat).
      return input.participant
        ? this.attachParticipantAndRoute(active, participantToAttachInput(input.participant, input.title))
        : active;
    }
    return this.createSession({
      id: input.sessionId,
      kind: input.kind,
      project: input.project,
      title: input.title,
      metadata: input.metadata,
      routeBinding: input.routeBinding,
      participant: input.participant,
    });
  }

  /** Idempotent register/heartbeat; a brand-new session is born ALREADY
   * surface-managed (avoids a create-then-patch race where a concurrent steer
   * sees active-but-not-yet-managed and hits the executor path). */
  async register(input: RegisterSharedSessionInput): Promise<SharedSessionRegisterResult> {
    await this.start();
    const createManaged = (i: CreateSharedSessionInput) =>
      this.createSession({ ...i, metadata: { ...i.metadata, [SESSION_SURFACE_MANAGED_METADATA_KEY]: true } });
    const result = await registerSharedSession({
      getSession: (id) => this.sessions.get(id) ?? null,
      createSession: createManaged,
      reopenSession: (id) => this.reopenSession(id),
      attachParticipant: (s, a) => this.attachParticipantAndRoute(s, a),
    }, input);
    const marked = await this.markSurfaceManaged(result.record.id); // backstop; no-op if already set
    return marked ? { ...result, record: marked } : result;
  }

  private async markSurfaceManaged(sessionId: string): Promise<SharedSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.metadata?.[SESSION_SURFACE_MANAGED_METADATA_KEY] === true) return session;
    const updated: SharedSessionRecord = {
      ...session,
      metadata: { ...session.metadata, [SESSION_SURFACE_MANAGED_METADATA_KEY]: true },
      updatedAt: Date.now(),
    };
    this.sessions.set(updated.id, updated);
    await this.persist();
    return updated;
  }

  getMessages(sessionId: string, limit = 100): SharedSessionMessage[] {
    return listSharedSessionMessages(this.messageStore(), sessionId, limit);
  }

  getInputs(sessionId: string, limit = 100): SharedSessionInputRecord[] {
    const bucket = this.inputs.get(sessionId) ?? [];
    return bucket.slice(-Math.max(1, limit));
  }

  async createSession(input: CreateSharedSessionInput = {}): Promise<SharedSessionRecord> {
    await this.start();
    const session = createSharedSessionRecord(input);
    this.sessions.set(session.id, session);
    if (input.routeBinding?.id) {
      await this.routeBindings.patchBinding(input.routeBinding.id, { sessionId: session.id });
    }
    await this.persist();
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

  /**
   * Permanently remove a shared session record and its queued messages/inputs
   * from the home-scoped store (see CHANGELOG 1.0.0: a real hard-delete verb, distinct from
   * `closeSession` — closed sessions are HISTORY and are never touched by this
   * path unless explicitly asked). Requires the session to already be closed:
   * deleting a still-active session returns `'active'` so the caller can
   * surface an honest 409 (close it, then delete) rather than yanking a
   * record out from under a live participant/agent. An unknown OR
   * already-deleted id returns `'not-found'` — delete is not a 200-noop; a
   * second delete of the same id is an honest 404 at the route layer.
   *
   * Emits `session-deleted` on the same `session-update` wire channel as
   * close/reopen/detach so subscribers drop the row live.
   */
  async deleteSession(sessionId: string): Promise<'deleted' | 'not-found' | 'active'> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return 'not-found';
    if (session.status !== 'closed') return 'active';
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.inputs.delete(sessionId);
    await this.persist();
    sessionsActive.set(this.sessions.size);
    this.publishUpdate('session-deleted', { sessionId });
    return 'deleted';
  }

  /**
   * Detach a surface's participant + route binding without closing or killing the
   * session ("detach != close != kill"). Emits `session-detached`. Idempotent:
   * unknown session -> null (404); closed session or no matching participant ->
   * returned unchanged (a closed session emits no updates, so "stop receiving
   * updates" is already satisfied). See the module helper `detachSharedSessionParticipant`.
   */
  async detachParticipant(sessionId: string, surfaceId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status === 'closed') return session;
    const { session: updated, changed } = detachSharedSessionParticipant(session, surfaceId);
    if (!changed) return session;
    this.sessions.set(sessionId, updated);
    await this.persist();
    this.publishUpdate('session-detached', {
      sessionId: updated.id,
      surfaceId,
      participants: updated.participants.length,
    });
    return updated;
  }

  async bindAgent(sessionId: string, agentId: string): Promise<SharedSessionRecord | null> {
    await this.start();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const updated = bindSharedSessionAgent(session, agentId);
    this.sessions.set(sessionId, updated);
    const claimed = claimNextQueuedSessionInput(this.sessionInputStore(), sessionId, agentId);
    await this.persist();
    this.publishUpdate('session-agent-bound', updated);
    if (claimed) {
      this.publishInputLifecycleEvent('session-input-spawned', claimed, {
        agentId,
      });
      // The claimed input is the message this agent was started for. When it
      // arrived over a channel, that channel is where the answer belongs.
      this.announceSurfaceReply({
        sessionId,
        agentId,
        ...(claimed.routeId ? { routeId: claimed.routeId } : {}),
        ...(claimed.surfaceKind ? { surfaceKind: claimed.surfaceKind } : {}),
        task: claimed.body,
        reason: 'spawn-claimed-input',
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
      readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<SharedSessionMessage | null> {
    if (!input.body.trim()) return null;
    return this.appendMessage(sessionId, {
      role: 'user',
      body: input.body,
      metadata: {
        ...(input.metadata ?? {}),
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
    // One stored completion per agent (see shouldStoreAgentCompletion); the rest of this method still runs for the second reporter.
    const role = metadata.status === 'failed' || metadata.status === 'cancelled' ? 'system' : 'assistant';
    if (shouldStoreAgentCompletion(this.messageStore(), sessionId, agentId)) {
      await this.appendMessage(sessionId, { role, body, agentId, metadata });
    }
    const now = Date.now();
    const updated: SharedSessionRecord = {
      ...(this.sessions.get(sessionId) ?? session),
      activeAgentId: (this.sessions.get(sessionId)?.activeAgentId === agentId) ? undefined : this.sessions.get(sessionId)?.activeAgentId,
      lastAgentId: agentId,
      updatedAt: now,
      lastActivityAt: now,
      ...(metadata.status === 'failed' ? { lastError: body } : {}),
    };
    this.sessions.set(sessionId, updated);
    const finalizedInputs = finalizeAgentSessionInputs(
      this.sessionInputStore(),
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
    const updated = updateSharedSessionInput(this.sessionInputStore(), sessionId, inputId, (entry) => {
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
    input: ParticipantRouteAttachInput,
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

  /** Snapshot now, write in call order — `gcSweep` persists unawaited and would
   * otherwise land a stale view over a `cancelInput`. See StoreWriteQueue. */
  private async persist(): Promise<void> {
    const state = { sessions: this.sessions, messages: this.messages, inputs: this.inputs };
    const snapshot = createSessionBrokerSnapshot(state, MAX_PERSISTED_MESSAGES);
    await this.writes.run(() => this.store.persist(snapshot));
  }

  private publishUpdate(event: string, payload: unknown): void {
    this.eventPublisher?.('session-update', { event, payload, createdAt: Date.now() });
  }

  private publishInputLifecycleEvent(event: string, input: SharedSessionInputRecord, extra: Record<string, unknown> = {}): void {
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
    return handleSharedSessionIntent(
      {
        sessions: this.sessions,
        messageSender: this.messageSender,
        start: () => this.start(),
        resolveBinding: (i) => this.resolveBinding(i),
        createSession: (i) => this.createSession(i),
        attachParticipantAndRoute: (session, i, binding) => this.attachParticipantAndRoute(session, i, binding),
        appendMessage: (sessionId, i) => this.appendMessage(sessionId, i),
        sessionInputStore: () => this.sessionInputStore(),
        publishInputLifecycleEvent: (event, i, extra) => this.publishInputLifecycleEvent(event, i, extra),
        resolveActiveAgentId: (session) => this.resolveActiveAgentId(session),
        persist: () => this.persist(),
        publishUpdate: (event, payload) => this.publishUpdate(event, payload),
        announceSurfaceReply: (binding) => this.announceSurfaceReply(binding),
        ...(this.surfaceNoticeSender ? { sendSurfaceNotice: this.surfaceNoticeSender } : {}),
        buildContinuationTask: (sessionId) => this.buildContinuationTask(sessionId),
        ...(this.conversationGateConfig ? { conversationGateConfig: this.conversationGateConfig } : {}),
      },
      intent,
      input,
      allowSpawnFallback,
    );
  }

  /** Collection read for a live surface (see the module helper `filterSessionInputsSince`). */
  getInputsSince(
    sessionId: string,
    options: { readonly state?: SharedSessionInputRecord['state'] | undefined; readonly since?: number | undefined; readonly limit?: number | undefined } = {},
  ): SharedSessionInputRecord[] {
    return filterSessionInputsSince(this.inputs.get(sessionId) ?? [], options);
  }

  /** A live surface reports a collected input delivered (`consumed:false`) or
   * consumed/completed (`consumed:true`), optionally naming the agent answering it.
   * Lifecycle, the agent pairing and the events live in `applySurfaceInputDelivery`. */
  async markInputDelivered(
    sessionId: string,
    inputId: string,
    options: { readonly consumed?: boolean | undefined; readonly agentId?: string | undefined } = {},
  ): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const applied = applySurfaceInputDelivery(this.sessionInputStore(), sessionId, inputId, options, {
      publish: (event, payload) => this.publishUpdate(event, payload),
      publishInput: (event, input, extra) => this.publishInputLifecycleEvent(event, input, extra),
      announce: (binding) => this.announceSurfaceReply(binding),
    });
    if (!applied) return null;
    await this.persist();
    return applied;
  }

  /**
   * A surface reports a collected input it could not act on.
   *
   * The counterpart to `markInputDelivered(consumed: true)`, and the reason
   * that call is not the only terminal one: a surface that collected an input
   * and then failed to hand it to its loop used to mark it completed anyway,
   * which is a record saying the owner's message was answered when nothing
   * received it. This moves it to `failed` with the reason attached, so the
   * lifecycle event says what happened and the record can be read afterwards.
   */
  async failInput(sessionId: string, inputId: string, error: string): Promise<SharedSessionInputRecord | null> {
    await this.start();
    const updated = updateSharedSessionInput(this.sessionInputStore(), sessionId, inputId, (entry) => {
      if (entry.state !== 'queued' && entry.state !== 'delivered') return entry;
      return { ...entry, state: 'failed', updatedAt: Date.now(), error };
    });
    if (!updated || updated.state !== 'failed') return null;
    this.refreshPendingInputCount(sessionId);
    await this.persist();
    this.publishInputLifecycleEvent('session-input-failed', updated);
    return updated;
  }

  private async runQueuedFollowUp(sessionId: string): Promise<{ input: SharedSessionInputRecord; agentId: string } | null> {
    const bucket = this.inputs.get(sessionId) ?? [];
    const next = bucket.find((entry) => entry.intent === 'follow-up' && entry.state === 'queued');
    if (!next) return null;
    if (!this.continuationRunner) {
      // A queued follow-up with nobody to run it is a message that will never
      // be answered. Harmless for a local caller that polls its own inputs;
      // for one that arrived over a channel it is silence, so say so.
      if (next.routeId ?? next.surfaceKind) {
        logger.error('A channel follow-up is queued but no continuation runner is installed — it will not be answered', {
          sessionId,
          inputId: next.id,
          bindingId: next.routeId ?? null,
          surface: next.surfaceKind ?? null,
        });
      }
      return null;
    }
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

  /** Periodic sweep: idle-close active sessions and (only under a finite retention
   * window) delete closed ones. Full policy lives in the module helper `sweepSharedSessions`. */
  /** Retained in-memory record count (sessions + message/input bucket entries), for MemoryGovernor visibility. */
  retainedRecordCount(): number {
    let total = this.sessions.size;
    for (const bucket of this.messages.values()) total += bucket.length;
    for (const bucket of this.inputs.values()) total += bucket.length;
    return total;
  }

  /**
   * MemoryGovernor trim hook — a REAL reclaim. `floor` runs the idle/closed
   * session GC sweep immediately; `flush` additionally truncates the message
   * and input buckets of every non-busy session to a short tail (the full
   * transcript persists in the session store; these buckets are the live
   * relay mirror).
   */
  trimRetained(level: 'floor' | 'flush'): void {
    this.gcSweep();
    if (level !== 'flush') return;
    const keepTail = 20;
    const isBusy = (sessionId: string): boolean => {
      const session = this.sessions.get(sessionId);
      return session ? session.pendingInputCount > 0 : false;
    };
    for (const [sessionId, bucket] of this.messages) {
      if (!isBusy(sessionId) && bucket.length > keepTail) {
        this.messages.set(sessionId, bucket.slice(-keepTail));
      }
    }
    for (const [sessionId, bucket] of this.inputs) {
      if (!isBusy(sessionId) && bucket.length > keepTail) {
        this.inputs.set(sessionId, bucket.slice(-keepTail));
      }
    }
  }

  private gcSweep(): void {
    const anyChanged = sweepSharedSessions(
      { sessions: this.sessions, messages: this.messages, inputs: this.inputs },
      {
        idleEmptyMs: this._idleEmptyMs,
        idleLongMs: this._idleLongMs,
        deletionRetentionMs: this._deletionRetentionMs,
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
