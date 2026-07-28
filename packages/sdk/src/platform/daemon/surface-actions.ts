import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';
import type { RouteBindingManager, ChannelPolicyManager } from '../channels/index.js';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../adapters/index.js';
import type { AutomationManager } from '../automation/index.js';
import type { ChannelPolicyDecision, ChannelIngressPolicyInput } from '../channels/index.js';
import type { RuntimeEventBus, TurnEvent, TurnInputOrigin } from '../runtime/events/index.js';
import { emitCompanionMessageReceived } from '../runtime/emitters/index.js';
import { NtfyIntegration } from '../integrations/ntfy.js';
import {
  postHomeAssistantSurfaceChatMessage,
  type HomeAssistantSurfaceChatInput,
  type HomeAssistantSurfaceChatResult,
} from './surface-homeassistant-reply.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { tryResolveApprovalReplyFromChannel, type ApprovalReplyBroker } from './approval-reply.js';
import { tryResolveWorkProposalReplyFromChannel } from './work-proposal-reply.js';
import { refuseCardShapedIngress, CARD_SHAPES_REFUSED_REASON } from './surface-card-gate.js';
import {
  deliverProposalNotice,
  gateSurfaceSpawn,
  startAgreedWork,
  type SurfaceIngressOrigin,
} from './surface-conversation-gate.js';
import type { WorkProposalStore } from '../agents/work-proposal-store.js';

interface PendingNtfyChatReply {
  readonly sessionId: string;
  readonly topic: string;
  readonly body: string;
  readonly title?: string | undefined;
  readonly messageId: string;
  readonly createdAt: number;
  turnId?: string | undefined;
  turnSessionId?: string | undefined;
}

interface DaemonSurfaceActionContext {
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly channelPolicy: ChannelPolicyManager;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly runtimeBus: RuntimeEventBus;
  readonly companionChatManager: CompanionChatManager | null;
  readonly automationManager: AutomationManager;
  readonly agentManager: AgentManager;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('../automation/routes.js').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string | undefined; readonly workflowChainId?: string | undefined; readonly sessionId?: string | undefined },
  ) => void;
  readonly queueWebhookReply: (input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly callbackUrl?: string | undefined;
    readonly callbackCorrelationId?: string | undefined;
    readonly callbackSignature?: import('./types.js').PendingSurfaceReply['callbackSignature'] | undefined;
  }) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
  ) => Promise<Response>;
  /**
   * Shared pending-approval broker — the same machinery the TUI and webui
   * resolve asks through. Lets a paired channel owner approve, deny, or
   * steer a pending ask by replying in the channel.
   */
  readonly approvalBroker?: ApprovalReplyBroker | undefined;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /**
   * Pending work proposals for the conversation-first gate. Absent = the gate
   * is not installed and inbound messages spawn as they always did, which is
   * what isolated contexts and older embedders get.
   */
  readonly workProposals?: WorkProposalStore | undefined;
  /**
   * Put one short line on the channel a binding points at, and say whether it
   * got there. The outcome is discriminated rather than boolean so a caller
   * can log WHICH guard refused — see SurfaceNoticeRefusal.
   */
  readonly deliverSurfaceNotice?: ((binding: import('../automation/routes.js').AutomationRouteBinding | undefined, text: string) => Promise<import('./types.js').SurfaceNoticeDelivery>) | undefined;
}

export class DaemonSurfaceActionHelper {
  private static readonly NTFY_CHAT_REPLY_TTL_MS = 10 * 60_000;
  private readonly pendingNtfyChatReplies = new Map<string, PendingNtfyChatReply[]>();
  private ntfyChatReplyUnsubscribers: Array<() => void> = [];
  private ntfyRemoteSessionId: string | null = null;

  constructor(private readonly context: DaemonSurfaceActionContext) {}

  buildSurfaceAdapterContext(): SurfaceAdapterContext {
    // One cell per inbound message (see SurfaceIngressOrigin). authorizeSurfaceIngress
    // fills it; the gated trySpawnAgent below reads it.
    const origin: { current: SurfaceIngressOrigin | null } = { current: null };
    return {
      serviceRegistry: this.context.serviceRegistry,
      secretsManager: this.context.secretsManager,
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: async (input) => {
        origin.current = {
          surface: input.surface,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        };
        const decision = await this.authorizeSurfaceIngress(input);
        // A card-refused message must not stay readable from the cell the gated
        // spawn path reads. Every adapter does return early on a not-allowed
        // decision, so this changes no behaviour today — it stops the guarantee
        // from depending on all nineteen of them continuing to.
        if (!decision.allowed && decision.reason.startsWith(CARD_SHAPES_REFUSED_REASON)) {
          origin.current = null;
        }
        return decision;
      },
      parseSurfaceControlCommand: (text) => this.parseSurfaceControlCommand(text),
      performSurfaceControlCommand: (command) => this.performSurfaceControlCommand(command),
      performInteractiveSurfaceAction: (actionId, surface, request) => this.performInteractiveSurfaceAction(actionId, surface, request),
      // The shared spawn boundary: every channel surface adapter routes its
      // spawn through the conversation-first gate (surface-conversation-gate.ts).
      trySpawnAgent: (input, logLabel, sessionId) =>
        gateSurfaceSpawn(this.conversationGateDeps(), origin.current, input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(binding, input),
      publishConversationFollowup: (sessionId, envelope) => this.publishConversationFollowup(sessionId, envelope),
      queueNtfyChatReply: (input) => this.queueNtfyChatReply(input),
      postNtfyRemoteChatMessage: (input) => this.postNtfyRemoteChatMessage(input),
      postHomeAssistantChatMessage: (input) => this.postHomeAssistantChatMessage(input),
    };
  }

  buildGenericWebhookAdapterContext(): GenericWebhookAdapterContext {
    return {
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
      surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.context.signWebhookPayload(body, secret),
      queueWebhookReply: (input) => this.context.queueWebhookReply(input),
    };
  }

  /** The slice of this helper's context the conversation gate consults. Public
   * so the shared-session continuation runner gates through the SAME deps. */
  conversationGateDeps() {
    return {
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      trySpawnAgent: this.context.trySpawnAgent,
      queueSurfaceReplyFromBinding: this.context.queueSurfaceReplyFromBinding,
      workProposals: this.context.workProposals,
      deliverSurfaceNotice: this.context.deliverSurfaceNotice,
    };
  }

  async authorizeSurfaceIngress(input: ChannelIngressPolicyInput): Promise<ChannelPolicyDecision> {
    // FIRST, before anything below can store, log or transcribe the message
    // (docs/inbound-email.md §11.0). evaluateIngress writes input.text into the
    // channel policy audit trail and schedules it to disk, and an approval
    // reply's trailing text becomes a stored steering note — so a card number
    // typed here reaches disk by two routes unless this runs ahead of both.
    // Approvals and vetoes themselves keep working over remote channels: a
    // remote surface has authority to say yes or no about a purchase, and no
    // path for entering the instrument. Authority over a decision is not a
    // channel for a secret.
    const cardRefusal = await refuseCardShapedIngress(
      { ...this.conversationGateDeps(), channelPolicy: this.context.channelPolicy },
      input,
    );
    if (cardRefusal) return cardRefusal;
    const decision = await this.context.channelPolicy.evaluateIngress(input);
    if (!decision.allowed) return decision;
    // An answer to a pending work proposal is consumed here, on the shared
    // ingress hook every surface adapter already calls — which is what makes
    // agreement answerable over whatever channel the proposal went out on,
    // with no per-adapter wiring and no walk to a terminal.
    const proposalReply = await tryResolveWorkProposalReplyFromChannel(input, {
      proposals: this.context.workProposals,
      startAgreedWork: (proposal, note) => startAgreedWork(this.conversationGateDeps(), proposal, note),
      replyOnChannel: async (proposal, text) => {
        const binding = proposal.routeId ? this.context.routeBindings.getBinding(proposal.routeId) : undefined;
        await deliverProposalNotice(this.context, binding, text);
      },
    });
    if (proposalReply.consumed) {
      // Report not-allowed so the adapter neither creates a session nor sends
      // a chat turn: the answer has already been acted on.
      return { ...decision, allowed: false, reason: `work-proposal-${proposalReply.action}` };
    }
    const consumed = await tryResolveApprovalReplyFromChannel(input, decision, {
      approvalBroker: this.context.approvalBroker,
      routeBindings: this.context.routeBindings,
    });
    if (consumed) {
      // The reply was an approval verb from the paired owner and resolved a
      // pending ask through the shared broker. Report it as not-allowed so
      // the adapter neither creates a session nor sends a chat turn — the
      // approval machinery publishes its own resolution events.
      return { ...decision, allowed: false, reason: 'approval-reply-consumed' };
    }
    return decision;
  }

  parseSurfaceControlCommand(text: string): { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string } | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^(status|cancel|retry)\s+([a-z0-9:_-]+)/i);
    if (!match) return null;
    return {
      action: (match[1]?.toLowerCase() ?? 'status') as 'status' | 'cancel' | 'retry',
      id: match[2] ?? ''
    };
  }

  async performSurfaceControlCommand(
    command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string },
  ): Promise<string> {
    if (command.action === 'status') {
      const run = this.context.automationManager.getRun(command.id);
      if (run) {
        return `Run ${run.id}: ${run.status}${run.agentId ? ` agent=${run.agentId}` : ''}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        return `Agent ${agent.id}: ${agent.status}${agent.progress ? ` (${agent.progress})` : ''}`;
      }
      const session = this.context.sessionBroker.getSession(command.id);
      if (session) {
        return `Session ${session.id}: ${session.status} messages=${session.messageCount}${session.activeAgentId ? ` activeAgent=${session.activeAgentId}` : ''}`;
      }
      return `Unknown run, agent, or session: ${command.id}`;
    }

    if (command.action === 'cancel') {
      const run = await this.context.automationManager.cancelRun(command.id, 'surface-cancelled');
      if (run) {
        return `Cancelled run ${run.id}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        this.context.agentManager.cancel(command.id);
        return `Cancelled agent ${command.id}`;
      }
      return `Unknown run or agent: ${command.id}`;
    }

    try {
      const run = await this.context.automationManager.retryRun(command.id);
      return `Retried run ${run.id}`;
    } catch {
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        const retried = this.context.trySpawnAgent({
          mode: 'spawn',
          task: agent.task,
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.provider ? { provider: agent.provider } : {}),
          ...(agent.tools.length > 0 ? { tools: agent.tools } : {}),
        }, 'DaemonSurfaceActionHelper.performSurfaceControlCommand');
        if (!(retried instanceof Response)) {
          return `Retried agent ${command.id} as ${retried.id}`;
        }
      }
      return `Unable to retry ${command.id}`;
    }
  }

  async performInteractiveSurfaceAction(
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
  ): Promise<string> {
    const approvalMatch = actionId.match(/^gv:approval:(approve|deny|claim):(.+)$/);
    if (approvalMatch) {
      const [, action, approvalId] = approvalMatch;
      const result = await this.context.handleApprovalAction(
        approvalId!,
        action as 'approve' | 'deny' | 'claim',
        new Request(req.url, {
          method: 'POST',
          headers: req.headers,
        }),
      );
      const body = await result.json().catch(() => ({} as Record<string, unknown>));
      return result.ok
        ? `Approval ${action}d: ${approvalId}`
        : String((body as Record<string, unknown>).error ?? `Failed to ${action} approval ${approvalId}`);
    }
    const runMatch = actionId.match(/^gv:run:(cancel|retry):(.+)$/);
    if (runMatch) {
      const [, action, runId] = runMatch;
      if (action === 'cancel') {
        const run = await this.context.automationManager.cancelRun(runId!, 'interactive-surface-cancel');
        return run ? `Cancelled run ${runId}` : `Failed to cancel run ${runId}`;
      }
      try {
        await this.context.automationManager.retryRun(runId!);
        return `Retried run ${runId}`;
      } catch (error) {
        return error instanceof Error ? error.message : `Failed to retry run ${runId}`;
      }
    }
    return `No handler for ${surface} action ${actionId}`;
  }

  private publishConversationFollowup(
    sessionId: string,
    envelope: Omit<ConversationMessageEnvelope, 'sessionId'>,
  ): void {
    this.context.controlPlaneGateway.publishEvent(
      'conversation.followup.companion',
      { sessionId, ...envelope },
      { clientKind: 'tui' },
    );
    emitCompanionMessageReceived(
      this.context.runtimeBus,
      { sessionId, traceId: `ntfy:${envelope.messageId}`, source: 'ntfy-chat' },
      {
        sessionId,
        messageId: envelope.messageId,
        body: envelope.body,
        source: envelope.source,
        timestamp: envelope.timestamp,
        ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
      },
    );
  }

  private queueNtfyChatReply(input: Omit<PendingNtfyChatReply, 'createdAt'>): void {
    this.ensureNtfyChatReplyListeners();
    this.cleanupExpiredNtfyChatReplies();
    const bucket = this.pendingNtfyChatReplies.get(input.sessionId) ?? [];
    bucket.push({
      ...input,
      createdAt: Date.now(),
    });
    this.pendingNtfyChatReplies.set(input.sessionId, bucket);
  }

  private ensureNtfyChatReplyListeners(): void {
    if (this.ntfyChatReplyUnsubscribers.length > 0) return;
    this.ntfyChatReplyUnsubscribers = [
      this.context.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>(
        'TURN_SUBMITTED',
        (envelope) => {
          if (!envelope.sessionId) return;
          this.matchNtfyChatReplyTurn(
            envelope.sessionId,
            envelope.payload.turnId,
            envelope.payload.prompt,
            envelope.payload.origin,
          );
        },
      ),
      this.context.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>(
        'TURN_COMPLETED',
        (envelope) => {
          if (!envelope.sessionId) return;
          void this.deliverNtfyChatReply(
            envelope.sessionId,
            envelope.payload.turnId,
            envelope.payload.response,
          ).catch((error: unknown) => {
            logger.warn('Daemon surface action: ntfy reply delivery failed', {
              sessionId: envelope.sessionId,
              turnId: envelope.payload.turnId,
              error: summarizeError(error),
            });
          });
        },
      ),
      this.context.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>(
        'TURN_ERROR',
        (envelope) => {
          if (!envelope.sessionId) return;
          void this.deliverNtfyChatReply(
            envelope.sessionId,
            envelope.payload.turnId,
            `Error: ${envelope.payload.error}`,
          ).catch((error: unknown) => {
            logger.warn('Daemon surface action: ntfy error reply delivery failed', {
              sessionId: envelope.sessionId,
              turnId: envelope.payload.turnId,
              error: summarizeError(error),
            });
          });
        },
      ),
    ];
  }

  private matchNtfyChatReplyTurn(
    sessionId: string,
    turnId: string,
    prompt: string,
    origin?: TurnInputOrigin,
  ): void {
    this.cleanupExpiredNtfyChatReplies();
    const originMessageId = this.readNtfyOriginMessageId(origin);
    const matchByMessageId = originMessageId
      ? this.findPendingNtfyChatReplyForMessageId(originMessageId)
      : null;
    if (matchByMessageId) {
      matchByMessageId.pending.turnId = turnId;
      matchByMessageId.pending.turnSessionId = sessionId;
      return;
    }
    const normalizedPrompt = prompt.trim();
    const match = this.findPendingNtfyChatReplyForPrompt(sessionId, normalizedPrompt);
    if (!match) return;
    match.pending.turnId = turnId;
    match.pending.turnSessionId = sessionId;
  }

  private readNtfyOriginMessageId(origin?: TurnInputOrigin): string | null {
    if (!origin) return null;
    if (typeof origin.messageId === 'string' && origin.messageId.trim()) {
      return origin.messageId.trim();
    }
    const metadataMessageId = origin.metadata?.['ntfyMessageId'] ?? origin.metadata?.['messageId'];
    return typeof metadataMessageId === 'string' && metadataMessageId.trim()
      ? metadataMessageId.trim()
      : null;
  }

  private async deliverNtfyChatReply(sessionId: string, turnId: string, message: string): Promise<void> {
    const pending = this.takeNtfyChatReply(sessionId, turnId);
    if (!pending) return;
    try {
      await this.publishNtfyReply(
        pending.topic,
        message.trim() || '(empty response)',
        pending.title ?? 'GoodVibes chat',
      );
    } catch (error) {
      logger.warn('DaemonSurfaceActionHelper: failed to publish ntfy chat reply', {
        sessionId,
        turnId,
        topic: pending.topic,
        error: summarizeError(error),
      });
    }
  }

  private findPendingNtfyChatReplyForPrompt(
    preferredSessionId: string,
    normalizedPrompt: string,
  ): { readonly pending: PendingNtfyChatReply; readonly bucketSessionId: string } | null {
    const preferredBucket = this.pendingNtfyChatReplies.get(preferredSessionId);
    const preferred = preferredBucket?.find((entry) => !entry.turnId && entry.body.trim() === normalizedPrompt);
    if (preferred) return { pending: preferred, bucketSessionId: preferredSessionId };

    let crossSessionCandidate: { readonly pending: PendingNtfyChatReply; readonly bucketSessionId: string } | null = null;
    for (const [bucketSessionId, bucket] of this.pendingNtfyChatReplies.entries()) {
      if (bucketSessionId === preferredSessionId) continue;
      const candidate = bucket.find((entry) => !entry.turnId && entry.body.trim() === normalizedPrompt);
      if (!candidate) continue;
      if (!crossSessionCandidate || candidate.createdAt < crossSessionCandidate.pending.createdAt) {
        crossSessionCandidate = { pending: candidate, bucketSessionId };
      }
    }
    if (crossSessionCandidate) {
      logger.debug('DaemonSurfaceActionHelper: matched pending ntfy chat reply in another session bucket', {
        preferredSessionId,
        matchedSessionId: crossSessionCandidate.bucketSessionId,
        messageId: crossSessionCandidate.pending.messageId,
      });
    }
    return crossSessionCandidate;
  }

  private findPendingNtfyChatReplyForMessageId(
    messageId: string,
  ): { readonly pending: PendingNtfyChatReply; readonly bucketSessionId: string } | null {
    for (const [bucketSessionId, bucket] of this.pendingNtfyChatReplies.entries()) {
      const pending = bucket.find((entry) => !entry.turnId && entry.messageId === messageId);
      if (pending) return { pending, bucketSessionId };
    }
    return null;
  }

  private takeNtfyChatReply(sessionId: string, turnId: string): PendingNtfyChatReply | null {
    for (const [bucketSessionId, bucket] of this.pendingNtfyChatReplies.entries()) {
      const index = bucket.findIndex((entry) =>
        entry.turnId === turnId && (!entry.turnSessionId || entry.turnSessionId === sessionId)
      );
      if (index < 0) continue;
      const [pending] = bucket.splice(index, 1);
      if (bucket.length === 0) {
        this.pendingNtfyChatReplies.delete(bucketSessionId);
      }
      return pending ?? null;
    }
    return null;
  }

  private cleanupExpiredNtfyChatReplies(now = Date.now()): void {
    for (const [sessionId, bucket] of this.pendingNtfyChatReplies.entries()) {
      const fresh = bucket.filter((entry) => now - entry.createdAt < DaemonSurfaceActionHelper.NTFY_CHAT_REPLY_TTL_MS);
      if (fresh.length === 0) {
        this.pendingNtfyChatReplies.delete(sessionId);
      } else if (fresh.length !== bucket.length) {
        this.pendingNtfyChatReplies.set(sessionId, fresh);
      }
    }
  }

  private async postNtfyRemoteChatMessage(input: {
    readonly topic: string;
    readonly body: string;
    readonly title?: string | undefined;
  }): Promise<{ readonly sessionId: string; readonly messageId: string; readonly delivered: boolean; readonly error?: string }> {
    const manager = this.context.companionChatManager;
    if (!manager) {
      return {
        sessionId: '',
        messageId: '',
        delivered: false,
        error: 'ntfy remote chat manager is unavailable',
      };
    }

    let sessionId = this.ntfyRemoteSessionId ?? '';
    try {
      await manager.init();
      let session = sessionId ? manager.getSession(sessionId) : null;
      const defaultProviderModel = this.context.resolveDefaultProviderModel?.() ?? null;
      if (!session || session.status === 'closed') {
        session = manager.createSession({
          title: input.title ?? 'GoodVibes ntfy',
          ...(defaultProviderModel
            ? {
                provider: defaultProviderModel.provider,
                model: defaultProviderModel.model,
              }
            : {}),
        });
        this.ntfyRemoteSessionId = session.id;
      } else if (defaultProviderModel) {
        session = manager.updateSession(session.id, {
          provider: defaultProviderModel.provider,
          model: defaultProviderModel.model,
        });
      }
      sessionId = session.id;
      void this.runNtfyRemoteChatTurn(manager, sessionId, input).catch((error: unknown) => {
        logger.warn('DaemonSurfaceActionHelper: ntfy remote chat turn failed', {
          sessionId,
          topic: input.topic,
          error: summarizeError(error),
        });
      });
      return {
        sessionId,
        messageId: '',
        delivered: true,
      };
    } catch (error) {
      const errorMessage = summarizeError(error);
      try {
        await this.publishNtfyReply(input.topic, `Error: ${errorMessage}`, input.title ?? 'GoodVibes ntfy');
      } catch (publishError) {
        logger.warn('DaemonSurfaceActionHelper: failed to publish ntfy remote chat error', {
          topic: input.topic,
          error: summarizeError(publishError),
        });
      }
      return {
        sessionId,
        messageId: '',
        delivered: false,
        error: errorMessage,
      };
    }
  }

  private async runNtfyRemoteChatTurn(
    manager: CompanionChatManager,
    sessionId: string,
    input: {
      readonly topic: string;
      readonly body: string;
      readonly title?: string | undefined;
    },
  ): Promise<void> {
    try {
      // No `ownerDirect`: an ntfy topic is a channel, so the untrusted-content window stays open (security/turn-boundary.ts).
      const result = await manager.postMessageAndWaitForReply(
        sessionId,
        input.body,
        `ntfy:${input.topic}`,
        { timeoutMs: 120_000 },
      );
      const response = result.response?.trim();
      const resultError = result.error ?? (response ? undefined : 'No response from ntfy remote chat');
      const outbound = response || `Error: ${resultError}`;
      await this.publishNtfyReply(input.topic, outbound, input.title ?? 'GoodVibes ntfy');
    } catch (error) {
      const errorMessage = summarizeError(error);
      try {
        await this.publishNtfyReply(input.topic, `Error: ${errorMessage}`, input.title ?? 'GoodVibes ntfy');
      } catch (publishError) {
        logger.warn('DaemonSurfaceActionHelper: failed to publish ntfy remote chat error', {
          topic: input.topic,
          error: summarizeError(publishError),
        });
      }
    }
  }

  /**
   * Run an inbound Home Assistant message as a chat turn and publish the reply.
   * The work lives in surface-homeassistant-reply.ts; this stays so the adapter
   * context keeps the same shape.
   */
  private async postHomeAssistantChatMessage(
    input: HomeAssistantSurfaceChatInput,
  ): Promise<HomeAssistantSurfaceChatResult> {
    return postHomeAssistantSurfaceChatMessage(this.context, input);
  }

  private async publishNtfyReply(topic: string, message: string, title: string): Promise<void> {
    if (!topic || !message.trim()) return;
    const ntfy = new NtfyIntegration(
      String(this.context.configManager.get('surfaces.ntfy.baseUrl') || 'https://ntfy.sh'),
      await this.resolveNtfyToken() ?? undefined,
    );
    await ntfy.publish(topic, message, {
      title,
      markGoodVibesOrigin: true,
    });
  }

  private async resolveNtfyToken(): Promise<string | null> {
    return await this.context.serviceRegistry.resolveSecret('ntfy', 'primary')
      || String(this.context.configManager.get('surfaces.ntfy.token') || '')
      || process.env.NTFY_ACCESS_TOKEN
      || null;
  }
}
