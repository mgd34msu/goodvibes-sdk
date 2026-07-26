import { createHmac } from 'crypto';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { ChannelPluginRegistry, ChannelReplyPipeline, RouteBindingManager } from '../channels/index.js';
import type { ChannelSurface } from '../channels/index.js';
import type { DeliveredChannelReply, UndeliveredChannelReply } from '../channels/reply-pipeline.js';
import type { SharedSessionSurfaceReplyBinding } from '../control-plane/session-intents.js';
import { SlackIntegration, DiscordIntegration, NtfyIntegration } from '../integrations/index.js';
import { logger } from '../utils/logger.js';
import { validatePublicWebhookUrl } from '../utils/url-safety.js';
import { resolveReachableBaseUrl } from '../utils/reachable-base-url.js';
import type { SharedApprovalRecord } from '../control-plane/index.js';
import type { PendingSurfaceReply, SurfaceNoticeDelivery, SurfaceNoticeRefusal } from './types.js';
import { summarizeError } from '../utils/error-display.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import {
  deliverDiscordApprovalUpdate,
  deliverNtfyApprovalUpdate,
  deliverSlackApprovalUpdate,
  deliverWebhookApprovalUpdate,
  type SurfaceApprovalDeliveryDeps,
} from './surface-approval-delivery.js';

type DeliverySurface =
  | 'slack'
  | 'discord'
  | 'ntfy'
  | 'webhook'
  | 'homeassistant'
  | 'telegram'
  | 'google-chat'
  | 'signal'
  | 'whatsapp'
  | 'telephony'
  | 'imessage'
  | 'msteams'
  | 'bluebubbles'
  | 'mattermost'
  | 'matrix';

type RouteBinding = import('../automation/routes.js').AutomationRouteBinding;

function isSupportedDeliverySurface(surface: string): surface is DeliverySurface {
  return surface === 'slack'
    || surface === 'discord'
    || surface === 'ntfy'
    || surface === 'webhook'
    || surface === 'homeassistant'
    || surface === 'telegram'
    || surface === 'google-chat'
    || surface === 'signal'
    || surface === 'whatsapp'
    || surface === 'telephony'
    || surface === 'imessage'
    || surface === 'msteams'
    || surface === 'bluebubbles'
    || surface === 'mattermost'
    || surface === 'matrix';
}

interface SurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly workflowChainId?: string | undefined;
  readonly sessionId?: string | undefined;
}

interface WebhookReplyInput extends SurfaceReplyInput {
  readonly routeId?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackCorrelationId?: string | undefined;
  readonly callbackSignature?: PendingSurfaceReply['callbackSignature'] | undefined;
}

interface DaemonSurfaceDeliveryContext {
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly configManager: ConfigManager;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly agentManager: AgentManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly authToken: () => string | null;
  readonly surfaceDeliveryEnabled: (surface: DeliverySurface) => boolean;
  /** Records surface reply attempts in the shared delivery ledger. */
  readonly recordDeliveryAttempt?: SurfaceDeliveryLedgerRecorder | undefined;
}

/** One entry the delivery ledger should show for a surface reply. */
export interface SurfaceDeliveryLedgerEntry {
  readonly deliveryId: string;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceKind: string;
  readonly targetId: string;
  readonly phase: 'queued' | 'started' | 'succeeded' | 'failed';
  readonly error?: string | undefined;
}

export type SurfaceDeliveryLedgerRecorder = (entry: SurfaceDeliveryLedgerEntry) => void;

/** Why a surface reply could not be created — carried into the log line. */
type SurfaceReplyRefusal =
  | 'no-route-binding'
  | 'unsupported-delivery-surface'
  | 'surface-delivery-disabled'
  | 'no-deliverable-target';

export class DaemonSurfaceDeliveryHelper {
  constructor(private readonly context: DaemonSurfaceDeliveryContext) {}

  /**
   * Track the reply an agent owes a conversation.
   *
   * Idempotent by agent id. Several paths legitimately reach here for the same
   * agent — the broker announces the pairing centrally and the adapter that
   * spawned it also asks — and re-tracking would reset the pipeline's event
   * buffer and republish everything already sent. First writer wins.
   */
  queueSurfaceReplyFromBinding(binding: RouteBinding | undefined, input: SurfaceReplyInput): boolean {
    if (!binding) return false;
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return false;
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return false;
    if (this.context.pendingSurfaceReplies.has(input.agentId)) return true;
    const pending = this.buildPendingSurfaceReply(binding, input);
    if (!pending) return false;
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
    this.recordLedger({
      deliveryId: `surface-reply:${input.agentId}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      routeId: binding.id,
      surfaceKind: binding.surfaceKind,
      targetId: binding.channelId ?? binding.externalId ?? binding.id,
      phase: 'queued',
    });
    return true;
  }

  /**
   * The shared reply-routing point: an agent is going to answer a message that
   * arrived over a channel, so make sure its answer has somewhere to go.
   *
   * Wired to SharedSessionBroker.setSurfaceReplyBinder, which announces the
   * pairing from inside the broker — the one place every ingress converges on.
   * Fixing it here rather than in an adapter is what makes a message landing in
   * an EXISTING live session get an answer, on all fifteen delivery surfaces,
   * without each adapter having to remember.
   *
   * Never silent: when no delivery can be created for a message that demonstrably
   * came from a channel, that is a produced answer with nowhere to go, and it is
   * reported at error with the surface, session, binding and reason, plus a
   * failed ledger entry so "should have sent, did not" is visible rather than
   * indistinguishable from "nothing happened".
   */
  ensureSurfaceReply(binding: SharedSessionSurfaceReplyBinding): boolean {
    if (this.context.pendingSurfaceReplies.has(binding.agentId)) return true;
    const route = binding.routeId ? this.context.routeBindings.getBinding(binding.routeId) : undefined;
    const resolved = route ?? this.resolveBindingFromSession(binding);
    const refusal = this.describeRefusal(resolved);
    if (!refusal) {
      return this.queueSurfaceReplyFromBinding(resolved, {
        agentId: binding.agentId,
        task: binding.task,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      });
    }
    // 'no-route-binding' for a surface we cannot deliver to at all (a local
    // terminal, a surface with no egress) is not a failure — there was never a
    // conversation to answer into. Everything else is a dropped reply.
    if (refusal === 'unsupported-delivery-surface' && !binding.routeId) return false;
    logger.error('An answer was produced for a channel message but no delivery could be created', {
      surface: binding.surfaceKind ?? resolved?.surfaceKind ?? 'unknown',
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      bindingId: binding.routeId ?? resolved?.id ?? null,
      pairedBy: binding.reason,
      reason: refusal,
    });
    this.recordLedger({
      deliveryId: `surface-reply:${binding.agentId}`,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      routeId: binding.routeId ?? resolved?.id,
      surfaceKind: binding.surfaceKind ?? resolved?.surfaceKind ?? 'unknown',
      targetId: resolved?.channelId ?? resolved?.externalId ?? binding.routeId ?? 'unknown',
      phase: 'failed',
      error: `no surface reply could be created (${refusal})`,
    });
    return false;
  }

  /** Record a reply that reached its conversation. */
  recordDeliveredReply(reply: DeliveredChannelReply): void {
    const route = reply.routeId ? this.context.routeBindings.getBinding(reply.routeId) : undefined;
    this.recordLedger({
      deliveryId: `surface-reply:${reply.agentId}`,
      agentId: reply.agentId,
      sessionId: reply.sessionId,
      routeId: reply.routeId,
      surfaceKind: reply.surfaceKind,
      targetId: route?.channelId ?? route?.externalId ?? reply.responseId ?? reply.routeId ?? 'unknown',
      phase: 'succeeded',
    });
  }

  /** Record a reply that reached the pipeline but never reached the conversation. */
  recordUndeliveredReply(reply: UndeliveredChannelReply): void {
    if (reply.phase !== 'final') return;
    const route = reply.routeId ? this.context.routeBindings.getBinding(reply.routeId) : undefined;
    this.recordLedger({
      deliveryId: `surface-reply:${reply.agentId}`,
      agentId: reply.agentId,
      sessionId: reply.sessionId,
      routeId: reply.routeId,
      surfaceKind: reply.surfaceKind,
      targetId: route?.channelId ?? route?.externalId ?? reply.routeId ?? 'unknown',
      phase: 'failed',
      error: reply.reason,
    });
  }

  private describeRefusal(binding: RouteBinding | undefined): SurfaceReplyRefusal | null {
    if (!binding) return 'no-route-binding';
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return 'unsupported-delivery-surface';
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return 'surface-delivery-disabled';
    if (!this.buildPendingSurfaceReply(binding, { agentId: binding.id, task: '' })) return 'no-deliverable-target';
    return null;
  }

  /**
   * Fall back to the session's own route bindings when the announcement did not
   * carry one — a follow-up typed into a session that a channel is attached to
   * still belongs to that channel.
   */
  private resolveBindingFromSession(binding: SharedSessionSurfaceReplyBinding): RouteBinding | undefined {
    const session = this.context.sessionBroker.getSession(binding.sessionId);
    for (const routeId of session?.routeIds ?? []) {
      const candidate = this.context.routeBindings.getBinding(routeId);
      if (!candidate) continue;
      if (binding.surfaceKind && candidate.surfaceKind !== binding.surfaceKind) continue;
      return candidate;
    }
    return undefined;
  }

  private recordLedger(entry: SurfaceDeliveryLedgerEntry): void {
    try {
      this.context.recordDeliveryAttempt?.(entry);
    } catch (error) {
      logger.warn('Surface delivery ledger update failed', {
        agentId: entry.agentId,
        phase: entry.phase,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Send a single short message to whatever surface a binding points at,
   * without creating a tracked agent reply.
   *
   * This is what the conversation-first gate uses to put a work proposal (and
   * its accept/decline acknowledgement) on the channel the message arrived on.
   * It deliberately reuses the existing per-surface fan-out, so a proposal is
   * deliverable on every surface the platform can already talk to — there is
   * no second, gate-only delivery path to keep in sync.
   */
  async deliverSurfaceNotice(binding: RouteBinding | undefined, text: string): Promise<SurfaceNoticeDelivery> {
    const refuse = (reason: SurfaceNoticeRefusal, error?: string): SurfaceNoticeDelivery => {
      // ERROR, not warn, and never a silent `return false`: a notice the owner
      // does not receive is the difference between a proposal they can answer
      // and one the system holds open while they see nothing. Every guard here
      // names itself so the log says which one refused.
      logger.error('Surface notice was not delivered', {
        surface: binding?.surfaceKind ?? null,
        routeId: binding?.id ?? null,
        reason,
        ...(error ? { error } : {}),
      });
      return { delivered: false, reason, ...(error ? { error } : {}) };
    };
    if (!binding) return refuse('no-route-binding');
    if (!text.trim()) return refuse('empty-text');
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return refuse('unsupported-delivery-surface');
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return refuse('surface-delivery-disabled');
    const pending = this.buildPendingSurfaceReply(binding, {
      agentId: `notice:${binding.id}:${Date.now()}`,
      task: text,
    });
    if (!pending) return refuse('no-deliverable-target');
    try {
      await this.deliverSurfaceProgress(pending, text);
      return { delivered: true };
    } catch (error) {
      return refuse('delivery-failed', summarizeError(error));
    }
  }

  queueWebhookReply(input: WebhookReplyInput): void {
    const pending: PendingSurfaceReply = {
      agentId: input.agentId,
      surfaceKind: 'webhook',
      task: input.task,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: input.routeId,
      callbackUrl: input.callbackUrl,
      callbackCorrelationId: input.callbackCorrelationId,
      callbackSignature: input.callbackSignature,
    };
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
  }

  async pollPendingSurfaceReplies(syncFinishedAgentTask: (record: import('../tools/agent/index.js').AgentRecord) => void): Promise<void> {
    if (this.context.pendingSurfaceReplies.size === 0) return;
    const completed: string[] = [];
    for (const pending of this.context.pendingSurfaceReplies.values()) {
      if (!this.context.channelReplyPipeline.has(pending.agentId)) {
        completed.push(pending.agentId);
        continue;
      }
      const record = this.context.agentManager.getStatus(pending.agentId);
      if (record && (record.status === 'pending' || record.status === 'running')) {
        // `record.progress` ONLY, on every surface. It is the concise one-line
        // status the orchestrator maintains ("Turn 3 · Read(src/parse.ts)",
        // "Network error, retrying in 5s…"). `streamingContent` is the raw
        // model output accumulated so far — both a growing transcript and a
        // fragment of the answer, so sending it made every notification a
        // superset of the previous one and leaked the reply a piece at a time.
        // The answer goes out once, complete, in the final message.
        const progress = record.progress;
        if (progress && progress !== pending.lastProgress && (Date.now() - (pending.lastProgressAt ?? 0)) >= 10_000) {
          try {
            await this.context.channelReplyPipeline.deliverProgress(pending.agentId, progress, true);
            pending.lastProgress = progress;
            pending.lastProgressAt = Date.now();
          } catch (error) {
            logger.warn('DaemonServer: progress delivery failed', {
              surface: pending.surfaceKind,
              agentId: pending.agentId,
              error: summarizeError(error),
            });
          }
        }
      }
      if (!record || (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled')) {
        continue;
      }
      const message = this.renderAgentCompletionForSurface(pending, record);
      syncFinishedAgentTask(record);
      if (pending.sessionId) {
        await this.context.sessionBroker.completeAgent(pending.sessionId, pending.agentId, message, {
          status: record.status,
          routeId: pending.routeId,
        });
      }
      try {
        await this.context.channelReplyPipeline.deliverFinal(pending.agentId, message, {
          keepTracking: pending.surfaceKind === 'ntfy' && typeof pending.workflowChainId === 'string',
        });
      } catch (error) {
        // The reply exists, the conversation is known, and it did not arrive.
        // Error level with the binding in hand, plus a ledger entry — silence
        // here is what made a dropped answer look like a message that was
        // never sent.
        logger.error('Agent reply delivery failed — the answer did not reach its conversation', {
          surface: pending.surfaceKind,
          agentId: pending.agentId,
          sessionId: pending.sessionId ?? null,
          bindingId: pending.routeId ?? null,
          reason: summarizeError(error),
        });
        this.recordUndeliveredReply({
          surfaceKind: pending.surfaceKind as ChannelSurface,
          agentId: pending.agentId,
          sessionId: pending.sessionId,
          routeId: pending.routeId,
          phase: 'final',
          body: message,
          reason: summarizeError(error),
        });
      }
      completed.push(pending.agentId);
    }
    for (const agentId of completed) {
      this.context.pendingSurfaceReplies.delete(agentId);
    }
  }

  async deliverSurfaceProgress(pending: PendingSurfaceReply, progress: string): Promise<void> {
    if (pending.surfaceKind === 'slack') {
      const webhookUrl = await this.resolveSlackWebhookUrl();
      const botToken = await this.resolveSlackBotToken();
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.responseUrl) {
        await instrumentedFetch(pending.responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            text: `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`,
          }),
        });
        return;
      }
      if (pending.channelId) {
        await slack.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
      return;
    }
    if (pending.surfaceKind === 'discord') {
      const webhookUrl =
        await this.context.serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await this.context.serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      if (pending.applicationId && pending.interactionToken) {
        await discord.editOriginalResponse(pending.applicationId, pending.interactionToken, `Progress: ${progress.slice(0, 180)}`);
        return;
      }
      if (pending.channelId) {
        await discord.postMessage(pending.channelId, `Progress for ${pending.agentId}: ${progress.slice(0, 180)}`);
      }
      return;
    }
    if (pending.surfaceKind === 'ntfy') {
      const topic = pending.topic ?? String(this.context.configManager.get('surfaces.ntfy.topic') ?? '');
      if (!topic) return;
      const ntfy = new NtfyIntegration(
        String(this.context.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
        await this.context.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
      );
      await ntfy.publish(topic, progress.slice(0, 300), {
        title: `Agent ${pending.agentId}`,
        markGoodVibesOrigin: true,
      });
    }
  }

  async deliverSlackAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl = await this.resolveSlackWebhookUrl();
    const botToken = await this.resolveSlackBotToken();
    const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.responseUrl) {
      await instrumentedFetch(pending.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'in_channel',
          blocks: slack.formatAgentResult(pending.agentId, pending.task, message),
        }),
      });
      return;
    }
    if (pending.channelId) {
      await slack.postMessage(pending.channelId, message, slack.formatAgentResult(pending.agentId, pending.task, message));
    }
  }

  async deliverDiscordAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const webhookUrl =
      await this.context.serviceRegistry.resolveSecret('discord', 'webhookUrl')
      ?? process.env.DISCORD_WEBHOOK_URL;
    const botToken =
      await this.context.serviceRegistry.resolveSecret('discord', 'primary')
      ?? process.env.DISCORD_BOT_TOKEN;
    const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
    if (pending.applicationId && pending.interactionToken) {
      await discord.editOriginalResponse(
        pending.applicationId,
        pending.interactionToken,
        '',
        [discord.formatAgentResult(pending.agentId, pending.task, message)],
      );
      return;
    }
    if (pending.channelId) {
      await discord.postMessage(pending.channelId, message, [discord.formatAgentResult(pending.agentId, pending.task, message)]);
    }
  }

  async deliverNtfyAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const baseUrl = String(this.context.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
    const token = await this.context.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
    const topic = pending.topic ?? String(this.context.configManager.get('surfaces.ntfy.topic') ?? '');
    if (!topic) return;
    const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
    // undefined = nothing configured resolves to an address a phone could
    // reach; publish without a click target rather than with a dead one.
    const baseAction = resolveReachableBaseUrl(this.context.configManager, 'off-host');
    await ntfy.publish(topic, message, {
      title: `Agent ${pending.agentId}`,
      ...(baseAction
        ? {
            click: `${baseAction}/api/control-plane/web`,
            actions: [
              `${pending.sessionId ? `view,Session,${baseAction}/api/control-plane/web?session=${encodeURIComponent(pending.sessionId)}` : `view,Control Plane,${baseAction}/api/control-plane/web`}`,
            ],
          }
        : {}),
      markGoodVibesOrigin: true,
    });
  }

  async deliverWebhookAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    const callbackUrl = pending.callbackUrl ?? String(this.context.configManager.get('surfaces.webhook.defaultTarget') ?? '');
    if (!callbackUrl) return;
    const validation = validatePublicWebhookUrl(callbackUrl);
    if (!validation.ok) {
      logger.warn('DaemonServer: refusing unsafe webhook callback URL', {
        agentId: pending.agentId,
        reason: validation.error,
      });
      return;
    }
    const timeoutMs = Number(this.context.configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
    const payload = {
      agentId: pending.agentId,
      sessionId: pending.sessionId ?? null,
      routeId: pending.routeId ?? null,
      task: pending.task,
      message,
      status: this.context.agentManager.getStatus(pending.agentId)?.status ?? 'completed',
      correlationId: pending.callbackCorrelationId ?? null,
      completedAt: Date.now(),
    };
    const body = JSON.stringify(payload);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (pending.callbackCorrelationId) {
      headers.set('X-Goodvibes-Correlation-Id', pending.callbackCorrelationId);
    }
    const secret = String(this.context.configManager.get('surfaces.webhook.secret') ?? '');
    if (secret && pending.callbackSignature === 'hmac-sha256') {
      headers.set('X-Goodvibes-Signature', this.signWebhookPayload(body, secret));
    } else if (secret && pending.callbackSignature === 'shared-secret') {
      headers.set('X-Goodvibes-Webhook-Secret', secret);
    }
    await instrumentedFetch(validation.url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body,
    });
  }

  async notifyApprovalUpdate(approval: SharedApprovalRecord): Promise<void> {
    await this.context.sessionBroker.start();
    await this.context.routeBindings.start();
    const routeId = approval.routeId
      ?? this.context.sessionBroker.getSession(approval.sessionId ?? '')?.routeIds[0];
    if (!routeId) return;
    const binding = this.context.routeBindings.getBinding(routeId);
    if (!binding) return;
    if (binding.surfaceKind !== 'service') {
      const pluginDelivered = await this.context.channelPlugins.notifyApproval(binding.surfaceKind, approval, binding);
      if (pluginDelivered) {
        return;
      }
    }

    if (binding.surfaceKind === 'slack') {
      await this.deliverSlackApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'discord') {
      await this.deliverDiscordApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'ntfy') {
      await this.deliverNtfyApprovalUpdate(approval, binding);
      return;
    }
    if (binding.surfaceKind === 'webhook') {
      await this.deliverWebhookApprovalUpdate(approval, binding);
    }
  }

  controlPlaneWebUrl(input: { readonly approvalId?: string; readonly sessionId?: string | undefined }): string | undefined {
    const base = resolveReachableBaseUrl(this.context.configManager, 'off-host');
    if (!base) return undefined;
    const url = new URL(`${base}/api/control-plane/web`);
    if (input.approvalId) url.searchParams.set('approval', input.approvalId);
    if (input.sessionId) url.searchParams.set('session', input.sessionId);
    return url.toString();
  }

  signWebhookPayload(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  private buildPendingSurfaceReply(binding: RouteBinding, input: SurfaceReplyInput): PendingSurfaceReply | null {
    const shared = {
      agentId: input.agentId,
      task: input.task,
      ...(input.agentTask ? { agentTask: input.agentTask } : {}),
      ...(input.workflowChainId ? { workflowChainId: input.workflowChainId } : {}),
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: binding.id,
      threadId: binding.threadId,
    } as const;

    switch (binding.surfaceKind) {
      case 'slack':
        return {
          ...shared,
          surfaceKind: 'slack',
          responseUrl: typeof binding.metadata.responseUrl === 'string' ? binding.metadata.responseUrl : undefined,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'discord':
        return {
          ...shared,
          surfaceKind: 'discord',
          channelId: binding.channelId,
          applicationId: typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined,
          interactionToken: typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'ntfy':
        return {
          ...shared,
          surfaceKind: 'ntfy',
          topic: binding.channelId ?? binding.externalId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'webhook':
        return {
          ...shared,
          surfaceKind: 'webhook',
          callbackUrl: typeof binding.metadata.callbackUrl === 'string' ? binding.metadata.callbackUrl : undefined,
          callbackCorrelationId: typeof binding.metadata.correlationId === 'string' ? binding.metadata.correlationId : undefined,
          callbackSignature: typeof binding.metadata.callbackSignature === 'string'
            ? binding.metadata.callbackSignature as PendingSurfaceReply['callbackSignature']
            : undefined,
        };
      case 'homeassistant':
        return {
          ...shared,
          surfaceKind: 'homeassistant',
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
          surfaceId: binding.surfaceId,
          externalId: binding.externalId,
          conversationId: typeof binding.metadata.conversationId === 'string'
            ? binding.metadata.conversationId
            : binding.externalId,
          messageId: typeof binding.metadata.messageId === 'string' ? binding.metadata.messageId : undefined,
          replyToMessageId: typeof binding.metadata.messageId === 'string' ? binding.metadata.messageId : undefined,
        };
      case 'telegram':
      case 'google-chat':
      case 'signal':
      case 'whatsapp':
      case 'telephony':
      case 'imessage':
      case 'msteams':
      case 'bluebubbles':
      case 'mattermost':
      case 'matrix':
        return {
          ...shared,
          surfaceKind: binding.surfaceKind,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'service':
        return null;
      default:
        return null;
    }
  }

  /**
   * Per-surface approval rendering lives in surface-approval-delivery.ts (this
   * file was over the 800-line cap). These stay as methods because
   * facade-composition wires them by name into the daemon route context.
   */
  private approvalDeliveryDeps(): SurfaceApprovalDeliveryDeps {
    return {
      serviceRegistry: this.context.serviceRegistry,
      configManager: this.context.configManager,
      controlPlaneWebUrl: (input) => this.controlPlaneWebUrl(input),
      resolveSlackWebhookUrl: () => this.resolveSlackWebhookUrl(),
      resolveSlackBotToken: () => this.resolveSlackBotToken(),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
    };
  }

  async deliverSlackApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverSlackApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverDiscordApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverDiscordApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverNtfyApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverNtfyApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverWebhookApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverWebhookApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  private async resolveSlackWebhookUrl(): Promise<string | null> {
    return await this.context.serviceRegistry.resolveSecret('slack', 'webhookUrl')
      ?? process.env.SLACK_WEBHOOK_URL
      ?? null;
  }

  private async resolveSlackBotToken(): Promise<string | null> {
    return await this.context.serviceRegistry.resolveSecret('slack', 'primary')
      ?? await this.resolveConfigSecret(this.context.configManager.get('surfaces.slack.botToken'))
      ?? process.env.SLACK_BOT_TOKEN
      ?? null;
  }

  private async resolveConfigSecret(value: unknown): Promise<string | null> {
    return resolveSecretInput(value, {
      resolveLocalSecret: this.context.secretsManager
        ? (key) => this.context.secretsManager!.get(key)
        : undefined,
      homeDirectory: this.context.secretsManager?.getGlobalHome?.() ?? undefined,
    });
  }

  private renderAgentCompletionForSurface(
    pending: PendingSurfaceReply,
    record: import('../tools/agent/index.js').AgentRecord,
  ): string {
    if (pending.surfaceKind === 'ntfy') {
      if (record.status === 'completed') {
        const wrfcId = typeof record.wrfcId === 'string' && record.wrfcId.trim()
          ? record.wrfcId.trim()
          : '';
        return wrfcId
          ? `Agent ${record.id} finished initial work. WRFC ${wrfcId} is continuing; review, fix, and gate updates will be posted here.`
          : `Agent ${record.id} completed.`;
      }
      if (record.status === 'failed') {
        return `Agent ${record.id} failed: ${record.error ?? 'failed'}`;
      }
      if (record.status === 'cancelled') {
        return `Agent ${record.id} cancelled.`;
      }
    }
    const body = record.status === 'completed'
      ? (record.fullOutput ?? record.streamingContent ?? record.progress ?? 'Completed')
      : record.error ?? record.status;
    return String(body);
  }
}
