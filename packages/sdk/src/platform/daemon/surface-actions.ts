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
import { HomeAssistantIntegration } from '../integrations/homeassistant.js';
import {
  HOME_ASSISTANT_DEFAULT_EVENT_TYPE,
  resolveHomeAssistantAccessToken,
  resolveHomeAssistantBaseUrl,
} from '../channels/builtin/homeassistant.js';
import {
  postHomeAssistantChatMessage as postHomeAssistantChatTurn,
  readHomeAssistantRemoteSessionTtlMs,
} from './homeassistant-chat.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

interface PendingNtfyChatReply {
  readonly sessionId: string;
  readonly topic: string;
  readonly body: string;
  readonly title?: string;
  readonly messageId: string;
  readonly createdAt: number;
  turnId?: string;
  turnSessionId?: string;
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
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string; readonly workflowChainId?: string; readonly sessionId?: string },
  ) => void;
  readonly queueWebhookReply: (input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string;
    readonly routeId?: string;
    readonly callbackUrl?: string;
    readonly callbackCorrelationId?: string;
    readonly callbackSignature?: import('./types.js').PendingSurfaceReply['callbackSignature'];
  }) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
  ) => Promise<Response>;
  readonly resolveDefaultProviderModel?: () => { provider: string; model: string } | null;
}

export class DaemonSurfaceActionHelper {
  private static readonly NTFY_CHAT_REPLY_TTL_MS = 10 * 60_000;
  private readonly pendingNtfyChatReplies = new Map<string, PendingNtfyChatReply[]>();
  private ntfyChatReplyUnsubscribers: Array<() => void> = [];
  private ntfyRemoteSessionId: string | null = null;

  constructor(private readonly context: DaemonSurfaceActionContext) {}

  buildSurfaceAdapterContext(): SurfaceAdapterContext {
    return {
      serviceRegistry: this.context.serviceRegistry,
      secretsManager: this.context.secretsManager,
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: (input) => this.authorizeSurfaceIngress(input),
      parseSurfaceControlCommand: (text) => this.parseSurfaceControlCommand(text),
      performSurfaceControlCommand: (command) => this.performSurfaceControlCommand(command),
      performInteractiveSurfaceAction: (actionId, surface, request) => this.performInteractiveSurfaceAction(actionId, surface, request),
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
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

  async authorizeSurfaceIngress(input: ChannelIngressPolicyInput): Promise<ChannelPolicyDecision> {
    return this.context.channelPolicy.evaluateIngress(input);
  }

  parseSurfaceControlCommand(text: string): { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string } | null {
    const trimmed = text.trim();
    const match = trimmed.match(/^(status|cancel|retry)\s+([a-z0-9:_-]+)/i);
    if (!match) return null;
    return {
      action: match[1]!.toLowerCase() as 'status' | 'cancel' | 'retry',
      id: match[2]!,
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
        approvalId,
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
        const run = await this.context.automationManager.cancelRun(runId, 'interactive-surface-cancel');
        return run ? `Cancelled run ${runId}` : `Failed to cancel run ${runId}`;
      }
      try {
        await this.context.automationManager.retryRun(runId);
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
        (envelope) => this.matchNtfyChatReplyTurn(
          envelope.sessionId,
          envelope.payload.turnId,
          envelope.payload.prompt,
          envelope.payload.origin,
        ),
      ),
      this.context.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>(
        'TURN_COMPLETED',
        (envelope) => {
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

    let fallback: { readonly pending: PendingNtfyChatReply; readonly bucketSessionId: string } | null = null;
    for (const [bucketSessionId, bucket] of this.pendingNtfyChatReplies.entries()) {
      if (bucketSessionId === preferredSessionId) continue;
      const candidate = bucket.find((entry) => !entry.turnId && entry.body.trim() === normalizedPrompt);
      if (!candidate) continue;
      if (!fallback || candidate.createdAt < fallback.pending.createdAt) {
        fallback = { pending: candidate, bucketSessionId };
      }
    }
    return fallback;
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
    readonly title?: string;
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
      readonly title?: string;
    },
  ): Promise<void> {
    try {
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

  private async postHomeAssistantChatMessage(input: {
    readonly body: string;
    readonly messageId: string;
    readonly conversationId: string;
    readonly surfaceId: string;
    readonly channelId: string;
    readonly threadId?: string;
    readonly userId?: string;
    readonly displayName?: string;
    readonly title: string;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly tools?: readonly string[];
    readonly context?: Record<string, unknown>;
    readonly remoteSessionTtlMs?: number;
    readonly publishEvent?: boolean;
  }): Promise<{
    readonly sessionId: string;
    readonly routeId?: string;
    readonly messageId: string;
    readonly assistantMessageId?: string;
    readonly response?: string;
    readonly delivered: boolean;
    readonly error?: string;
  }> {
    const manager = this.context.companionChatManager;
    if (!manager) {
      return {
        sessionId: '',
        messageId: input.messageId,
        delivered: false,
        error: 'Home Assistant remote chat manager is unavailable',
      };
    }

    try {
      const result = await postHomeAssistantChatTurn(
        {
          configManager: this.context.configManager,
          routeBindings: this.context.routeBindings,
          chatManager: manager,
          resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
        },
        {
          text: input.body,
          messageId: input.messageId,
          conversationId: input.conversationId,
          surfaceId: input.surfaceId,
          channelId: input.channelId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          title: input.title,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
          ...(input.tools?.length ? { tools: input.tools } : {}),
          ...(input.context ? { context: input.context } : {}),
          remoteSessionTtlMs: readHomeAssistantRemoteSessionTtlMs(this.context.configManager, input.remoteSessionTtlMs),
        },
        {
          wait: true,
          timeoutMs: 120_000,
          clientId: `homeassistant:${input.surfaceId}:${input.conversationId}`,
        },
      );
      const response = result.response?.trim();
      const error = result.error ?? (response ? undefined : 'No response from Home Assistant remote chat');
      if (input.publishEvent !== false) {
        await this.publishHomeAssistantChatReply(input, {
          sessionId: result.session.id,
          routeId: result.binding.id,
          assistantMessageId: result.assistantMessageId,
          response: response || `Error: ${error}`,
          status: error ? 'failed' : 'completed',
        });
      }
      return {
        sessionId: result.session.id,
        routeId: result.binding.id,
        messageId: input.messageId,
        ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
        ...(response ? { response } : {}),
        delivered: !error,
        ...(error ? { error } : {}),
      };
    } catch (error) {
      const errorMessage = summarizeError(error);
      if (input.publishEvent !== false) {
        try {
          await this.publishHomeAssistantChatReply(input, {
            sessionId: '',
            response: `Error: ${errorMessage}`,
            status: 'failed',
          });
        } catch (publishError) {
          logger.warn('DaemonSurfaceActionHelper: failed to publish Home Assistant chat error', {
            conversationId: input.conversationId,
            error: summarizeError(publishError),
          });
        }
      }
      return {
        sessionId: '',
        messageId: input.messageId,
        delivered: false,
        error: errorMessage,
      };
    }
  }

  private async publishHomeAssistantChatReply(
    input: {
      readonly body: string;
      readonly messageId: string;
      readonly conversationId: string;
      readonly surfaceId: string;
      readonly channelId: string;
      readonly threadId?: string;
      readonly userId?: string;
      readonly displayName?: string;
      readonly title: string;
      readonly context?: Record<string, unknown>;
    },
    result: {
      readonly sessionId: string;
      readonly routeId?: string;
      readonly assistantMessageId?: string;
      readonly response: string;
      readonly status: string;
    },
  ): Promise<void> {
    const baseUrl = resolveHomeAssistantBaseUrl(this.context.configManager, this.context.serviceRegistry);
    const accessToken = await resolveHomeAssistantAccessToken(this.context);
    if (!baseUrl || !accessToken) {
      throw new Error('Home Assistant instance URL or access token is not configured.');
    }
    const eventType = String(this.context.configManager.get('surfaces.homeassistant.eventType') || HOME_ASSISTANT_DEFAULT_EVENT_TYPE);
    const client = new HomeAssistantIntegration({ baseUrl, accessToken });
    await client.publishGoodVibesEvent(eventType, {
      type: 'message',
      title: input.title || 'GoodVibes',
      body: result.response,
      speechText: result.response,
      status: result.status,
      sessionId: result.sessionId,
      ...(result.routeId ? { routeId: result.routeId } : {}),
      surfaceId: input.surfaceId,
      externalId: input.conversationId,
      ...(result.assistantMessageId ? { messageId: result.assistantMessageId } : {}),
      replyToMessageId: input.messageId,
      conversationId: input.conversationId,
      metadata: {
        threadId: input.threadId ?? null,
        channelId: input.channelId,
        userId: input.userId ?? null,
        displayName: input.displayName ?? null,
        inboundMessageId: input.messageId,
        conversationId: input.conversationId,
        ...(input.context ? { homeAssistantContext: input.context } : {}),
      },
    });
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
