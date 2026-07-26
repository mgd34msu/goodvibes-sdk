/**
 * surface-approval-delivery.ts — per-surface rendering of an approval update.
 *
 * Split out of surface-delivery.ts, which was over the 800-line cap. These
 * four are a cohesive block: each takes the same approval + route binding and
 * differs only in how that surface expresses "approve / deny / here is the
 * console link". Nothing here decides WHICH surface to use — that stays in
 * DaemonSurfaceDeliveryHelper.notifyApprovalUpdate, the one router.
 *
 * Every function takes its collaborators as an object rather than a bound
 * method. Passing `configManager.get` on its own would lose the receiver and
 * throw inside the ConfigManager (`this.resolvePath` is undefined) — the same
 * defect class this round fixed in the control-plane gateway registration.
 */
import type { ConfigManager } from '../config/manager.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SharedApprovalRecord } from '../control-plane/index.js';
import { SlackIntegration, DiscordIntegration, NtfyIntegration } from '../integrations/index.js';
import { logger } from '../utils/logger.js';
import { validatePublicWebhookUrl } from '../utils/url-safety.js';
import { summarizeError } from '../utils/error-display.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';

type RouteBinding = import('../automation/routes.js').AutomationRouteBinding;

export interface SurfaceApprovalDeliveryDeps {
  readonly serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly controlPlaneWebUrl: (
    input: { readonly approvalId?: string; readonly sessionId?: string | undefined },
  ) => string | undefined;
  readonly resolveSlackWebhookUrl: () => Promise<string | null>;
  readonly resolveSlackBotToken: () => Promise<string | null>;
  readonly signWebhookPayload: (body: string, secret: string) => string;
}

/** 'pending' and 'claimed' both still want the approve/deny affordance. */
function isPendingApproval(approval: SharedApprovalRecord): boolean {
  return approval.status === 'pending' || approval.status === 'claimed';
}

export async function deliverSlackApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<void> {
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const webhookUrl = await deps.resolveSlackWebhookUrl();
  const botToken = await deps.resolveSlackBotToken();
  const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
  const blocks = isPending
    ? [
        { type: 'section', text: { type: 'mrkdwn', text: `*Approval required* for \`${approval.request.tool}\`\n${summary}` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `gv:approval:approve:${approval.id}` },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Deny' }, action_id: `gv:approval:deny:${approval.id}` },
            ...(webUrl ? [{ type: 'button', text: { type: 'plain_text', text: 'Open Console' }, url: webUrl }] : []),
          ],
        },
      ]
    : undefined;
  const text = isPending ? `Approval required: ${summary}` : `Approval ${approval.status}: ${summary}`;
  if (typeof binding.metadata.responseUrl === 'string' && binding.metadata.responseUrl.startsWith('https://')) {
    await instrumentedFetch(binding.metadata.responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'in_channel',
        text,
        ...(blocks ? { blocks } : {}),
      }),
    }).catch((error) => logger.warn('Slack approval response delivery failed', {
      approvalId: approval.id,
      error: summarizeError(error),
    }));
    return;
  }
  if (binding.channelId) {
    await slack.postMessage(binding.channelId, text, blocks);
  }
}

export async function deliverDiscordApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<void> {
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const webhookUrl =
    await deps.serviceRegistry.resolveSecret('discord', 'webhookUrl')
    ?? process.env.DISCORD_WEBHOOK_URL;
  const botToken =
    await deps.serviceRegistry.resolveSecret('discord', 'primary')
    ?? process.env.DISCORD_BOT_TOKEN;
  const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
  const content = isPending
    ? `Approval required for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`
    : `Approval ${approval.status} for \`${approval.request.tool}\`: ${summary}${webUrl ? `\n${webUrl}` : ''}`;
  const applicationId = typeof binding.metadata.applicationId === 'string' ? binding.metadata.applicationId : undefined;
  const interactionToken = typeof binding.metadata.interactionToken === 'string' ? binding.metadata.interactionToken : undefined;
  if (applicationId && interactionToken) {
    await discord.editOriginalResponse(applicationId, interactionToken, content).catch((error) => {
      logger.warn('Discord approval interaction update failed', {
        approvalId: approval.id,
        error: summarizeError(error),
      });
    });
    return;
  }
  if (binding.channelId) {
    await discord.postMessage(binding.channelId, content).catch((error) => {
      logger.warn('Discord approval channel update failed', {
        approvalId: approval.id,
        channelId: binding.channelId,
        error: summarizeError(error),
      });
    });
  }
}

export async function deliverNtfyApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<void> {
  const topic = binding.channelId ?? binding.externalId;
  if (!topic) return;
  const webUrl = deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
  const isPending = isPendingApproval(approval);
  const summary = approval.request.analysis.summary;
  const ntfy = new NtfyIntegration(
    String(deps.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
    await deps.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
  );
  await ntfy.publish(topic, `${isPending ? 'Approval required' : `Approval ${approval.status}`}: ${summary}`, {
    title: approval.request.tool,
    ...(webUrl ? { click: webUrl } : {}),
    markGoodVibesOrigin: true,
  }).catch((error) => logger.warn('ntfy approval update failed', {
    approvalId: approval.id,
    topic,
    error: summarizeError(error),
  }));
}

export async function deliverWebhookApprovalUpdate(
  deps: SurfaceApprovalDeliveryDeps,
  approval: SharedApprovalRecord,
  binding: RouteBinding,
): Promise<void> {
  if (typeof binding.metadata.callbackUrl !== 'string') return;
  const validation = validatePublicWebhookUrl(binding.metadata.callbackUrl);
  if (!validation.ok) {
    logger.warn('DaemonServer: refusing unsafe webhook approval callback URL', {
      approvalId: approval.id,
      reason: validation.error,
    });
    return;
  }
  const payload = JSON.stringify({
    type: 'approval',
    approval,
    webUrl: deps.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId }) ?? null,
  });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const secret = String(deps.configManager.get('surfaces.webhook.secret') ?? '');
  if (secret) {
    headers.set('X-Goodvibes-Signature', deps.signWebhookPayload(payload, secret));
  }
  await instrumentedFetch(validation.url, {
    method: 'POST',
    headers,
    body: payload,
  }).catch((error) => logger.warn('Webhook approval update failed', {
    approvalId: approval.id,
    error: summarizeError(error),
  }));
}
