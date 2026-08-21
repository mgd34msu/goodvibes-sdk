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
import { logger } from '../utils/logger.js';
import { resolveReachableBaseUrl } from '../utils/reachable-base-url.js';
import type { SharedApprovalRecord } from '../control-plane/index.js';
import type { PendingSurfaceReply, SurfaceNoticeDelivery, SurfaceNoticeRefusal } from './types.js';
import { summarizeError } from '../utils/error-display.js';
import { renderNoticeForSurface } from '../email/inbound-notice-channels.js';
import type { StructuredNotice } from '../email/inbound-notice.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { isOwnerFacingProgress } from '../agents/progress-audience.js';
import { renderAgentCompletionAnswer } from '../agents/completion-answer.js';
import {
  deliverDiscordAgentReply,
  deliverNtfyAgentReply,
  deliverSlackAgentReply,
  deliverSurfaceProgress,
  deliverWebhookAgentReply,
  type SurfaceDirectDeliveryDeps,
} from './surface-direct-delivery.js';
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

/**
 * Title carried on a gate notice. Surfaces that render a heading (ntfy, Slack
 * blocks) show this; chat surfaces that only take a body ignore it.
 */
const NOTICE_TITLE = 'goodvibes';

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
  /** Required: surface credentials that are `goodvibes://secrets/...` references resolve through this. */
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
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

/** Why a surface reply could not be created, carried into the log line. */
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
   * agent, the broker announces the pairing centrally and the adapter that
   * spawned it also asks, and re-tracking would reset the pipeline's event
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
   * pairing from inside the broker, the one place every ingress converges on.
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
    // terminal, a surface with no egress) is not a failure, there was never a
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
   * carry one, a follow-up typed into a session that a channel is attached to
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
   *
   * It sends through the SAME channel render path a conversational reply takes
   *, `channelPlugins.render` -> the surface's renderEvent -> the channel
   * delivery router, which is why a proposal is deliverable on every surface
   * the platform can already talk to. Telegram is the case that proves it: the
   * bot could always answer a chat message, because that answer went through
   * the router's `sendMessage` strategy, while the gate's notice went through
   * `deliverSurfaceProgress`, which is implemented for slack/discord/ntfy only.
   * A gated surface with no notice path is a black hole, the owner is asked
   * nothing and the daemon waits for an answer to a question never posed.
   *
   * `deliverSurfaceProgress` remains only as the fallback for a surface whose
   * plugin is not registered at all (an embedder with its own registry).
   */
  /**
   * Deliver a notice that is still STRUCTURE, escaping it for whatever surface
   * the binding points at.
   *
   * This is the entry point anything holding a `StructuredNotice` must use,
   * and the reason it exists rather than leaving callers to render first is
   * that the destination is not knowable at the call site. The binding is
   * resolved here, so the escaper is chosen from the surface the message will
   * actually land on, a caller cannot pick the wrong one, and cannot skip
   * escaping, because it never holds a string to pass.
   *
   * That is the same structural-over-conventional rule the inbound-mail path
   * runs on elsewhere: the producer (`renderInboundMailNotice`) cannot emit a
   * channel-formatted string, and this is the only place one is made.
   *
   * A surface with no verified escaper gets fully-neutralized plain text, not
   * the raw span concatenation, see `noticeChannelForSurface`.
   */
  async deliverStructuredNotice(
    binding: RouteBinding | undefined,
    notice: StructuredNotice,
  ): Promise<SurfaceNoticeDelivery> {
    if (!binding) {
      // Refused for the same reason and by the same name as below; rendering
      // first would mean escaping text for a surface that does not exist.
      return this.deliverSurfaceNotice(binding, '');
    }
    return this.deliverSurfaceNotice(binding, renderNoticeForSurface(notice, binding.surfaceKind));
  }

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
      const rendered = await this.context.channelPlugins.render(binding.surfaceKind as ChannelSurface, {
        surface: binding.surfaceKind as ChannelSurface,
        // 'progress' rather than 'final': a notice is not an agent's answer, and
        // the final phase decorates the message with control-plane links and
        // completion framing that do not belong on a question.
        phase: 'progress',
        agentId: pending.agentId,
        routeId: binding.id,
        title: NOTICE_TITLE,
        text,
        events: [],
        pending: pending as unknown as Record<string, unknown>,
        metadata: { notice: true },
      });
      if (rendered?.delivered) return { delivered: true };
      if (rendered) {
        return refuse('delivery-failed', String(rendered.metadata.reason ?? 'channel-reported-not-delivered'));
      }
      // No plugin is registered for this surface, so there is no render path to
      // use. Fall back to the direct per-surface push, which throws by name for
      // any surface it does not implement.
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

  /**
   * A surface that ran the turn in ITS OWN process reports the answer.
   *
   * `pollPendingSurfaceReplies` below is the same three steps, write the
   * answer into the shared session, push it down the reply pipeline, drop the
   * pending entry, driven by this daemon's own AgentManager. That loop can
   * only ever see agents THIS process spawned, so an answer produced by a TUI
   * or agent process that collected the input over `sessions.inputs.list` was
   * invisible to it: the pending reply sat until the pipeline's own retention
   * dropped it, and the conversation got silence.
   *
   * Returns whether a channel delivery was attempted. `false` is the ordinary
   * outcome for a session with no channel behind it (a local terminal), and is
   * not an error, the session message is still written.
   */
  async completeSurfaceReplyFromSurface(input: {
    readonly agentId: string;
    readonly sessionId?: string | undefined;
    readonly body: string;
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  }): Promise<boolean> {
    const pending = this.context.pendingSurfaceReplies.get(input.agentId);
    const status = input.status ?? 'completed';
    const sessionId = input.sessionId ?? pending?.sessionId;
    if (sessionId) {
      await this.context.sessionBroker.completeAgent(sessionId, input.agentId, input.body, {
        status,
        ...(pending?.routeId ? { routeId: pending.routeId } : {}),
      });
    }
    if (!pending) return false;
    try {
      await this.context.channelReplyPipeline.deliverFinal(input.agentId, input.body, {
        keepTracking: pending.surfaceKind === 'ntfy' && typeof pending.workflowChainId === 'string',
      });
    } catch (error) {
      logger.error('Agent reply delivery failed, the answer did not reach its conversation', {
        surface: pending.surfaceKind,
        agentId: input.agentId,
        sessionId: sessionId ?? null,
        bindingId: pending.routeId ?? null,
        reason: summarizeError(error),
      });
      this.recordUndeliveredReply({
        surfaceKind: pending.surfaceKind as ChannelSurface,
        agentId: input.agentId,
        sessionId: pending.sessionId,
        routeId: pending.routeId,
        phase: 'final',
        body: input.body,
        reason: summarizeError(error),
      });
    }
    this.context.pendingSurfaceReplies.delete(input.agentId);
    return true;
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
        // `record.progress` ONLY, on every surface, and only the lines written
        // for the person on the other end. `streamingContent` is the raw model
        // output accumulated so far, both a growing transcript and a fragment
        // of the answer, so sending it made every notification a superset of
        // the previous one and leaked the reply a piece at a time. The answer
        // goes out once, complete, in the final message.
        //
        // The audience test is what this route was missing. `record.progress`
        // is mostly the running tool and a scrap of its arguments, kept for the
        // TUI's activity surfaces. The channel renderer strips the `Turn 3 · `
        // prefix, so those arrived on the owner's phone as bare tool traces,
        // `registry, email send`, `exec, standard`, in the middle of a
        // conversation. Only lines the orchestrator marked `owner` (a retry, a
        // model fallback, a stall the reader can act on) travel this way now.
        // See agents/progress-audience.ts.
        const progress = isOwnerFacingProgress(record.progressAudience) ? record.progress : undefined;
        if (progress && progress !== pending.lastProgress && (Date.now() - (pending.lastProgressAt ?? 0)) >= 10_000) {
          try {
            await this.context.channelReplyPipeline.deliverProgress(pending.agentId, progress, true, 'owner');
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
      const message = this.renderAgentCompletionForSurface(record);
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
        // Error level with the binding in hand, plus a ledger entry, silence
        // here is what made a dropped answer look like a message that was
        // never sent.
        logger.error('Agent reply delivery failed, the answer did not reach its conversation', {
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

  /**
   * Collaborators for the direct per-surface senders in
   * surface-direct-delivery.ts (this file was over the line cap). These stay as
   * methods because facade-composition wires them by name into the daemon route
   * context and the builtin channel plugins.
   */
  private directDeliveryDeps(): SurfaceDirectDeliveryDeps {
    return {
      serviceRegistry: this.context.serviceRegistry,
      configManager: this.context.configManager,
      agentManager: this.context.agentManager,
      resolveSlackWebhookUrl: () => this.resolveSlackWebhookUrl(),
      resolveSlackBotToken: () => this.resolveSlackBotToken(),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
    };
  }

  /**
   * Push a one-line status to a surface directly. slack/discord/ntfy only,
   * every other surface throws by name. This is the FALLBACK; the general path
   * is the channel delivery router. See surface-direct-delivery.ts.
   */
  async deliverSurfaceProgress(pending: PendingSurfaceReply, progress: string): Promise<void> {
    await deliverSurfaceProgress(this.directDeliveryDeps(), pending, progress);
  }

  async deliverSlackAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverSlackAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverDiscordAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverDiscordAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverNtfyAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverNtfyAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverWebhookAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverWebhookAgentReply(this.directDeliveryDeps(), pending, message);
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
      resolveLocalSecret: (key) => this.context.secretsManager.get(key),
      homeDirectory: this.context.secretsManager.getGlobalHome?.() ?? undefined,
    });
  }

  private renderAgentCompletionForSurface(
    record: import('../tools/agent/index.js').AgentRecord,
  ): string {
    // ntfy used to take a branch of its own here that never looked at the
    // agent's output at all: a completed run was announced as
    // `Agent agent-1a2b3c completed.`, an id and a past-tense verb, on the
    // owner's primary surface, in place of the answer he asked for. Every
    // other surface was already handed `record.fullOutput`. There is no reason
    // for the answer to depend on which app is displaying it, so the branch is
    // gone and ntfy renders what everyone else renders.
    //
    // The rule itself lives in agents/completion-answer.ts, because a surface
    // that ran a dispatched turn in its own process renders the same answer
    // before reporting it back, see runtime/client/session-dispatch.ts.
    return renderAgentCompletionAnswer(record);
  }
}
