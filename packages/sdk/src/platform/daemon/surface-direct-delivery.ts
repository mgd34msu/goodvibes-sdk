/**
 * surface-direct-delivery.ts, sending straight to one surface's own API,
 * bypassing the channel render path.
 *
 * Split out of surface-delivery.ts, which was back over the 800-line cap. Same
 * arrangement as surface-approval-delivery.ts: a cohesive per-surface block
 * that differs only in how each surface expresses the same message, with the
 * routing decision left in DaemonSurfaceDeliveryHelper.
 *
 * IMPORTANT, what this module is NOT. `deliverSurfaceProgress` here is
 * implemented for slack, discord and ntfy only, and that list is much smaller
 * than the set of surfaces the platform can talk to. It is a fallback, not the
 * delivery path: the general path is the channel delivery router, which every
 * surface has a strategy for. An unimplemented surface therefore THROWS by
 * name, returning quietly is what let a caller read "nothing was sent" as
 * "the message went out".
 *
 * Every function takes its collaborators as an object rather than a bound
 * method: passing `configManager.get` on its own loses the receiver and throws
 * inside the ConfigManager.
 */
import type { ConfigManager } from '../config/manager.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { AgentManager } from '../tools/agent/index.js';
import { SlackIntegration, DiscordIntegration, NtfyIntegration } from '../integrations/index.js';
import { logger } from '../utils/logger.js';
import { validatePublicWebhookUrl } from '../utils/url-safety.js';
import { resolveReachableBaseUrl } from '../utils/reachable-base-url.js';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import type { PendingSurfaceReply } from './types.js';

export interface SurfaceDirectDeliveryDeps {
  readonly serviceRegistry: Pick<ServiceRegistry, 'resolveSecret'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly agentManager: Pick<AgentManager, 'getStatus'>;
  readonly resolveSlackWebhookUrl: () => Promise<string | null>;
  readonly resolveSlackBotToken: () => Promise<string | null>;
  readonly signWebhookPayload: (body: string, secret: string) => string;
}

/**
 * Push a one-line status to a surface directly.
 *
 * See the module header: slack/discord/ntfy only, and anything else throws.
 */
export async function deliverSurfaceProgress(
  deps: SurfaceDirectDeliveryDeps,
  pending: PendingSurfaceReply,
  progress: string,
): Promise<void> {
  if (pending.surfaceKind === 'slack') {
    const webhookUrl = await deps.resolveSlackWebhookUrl();
    const botToken = await deps.resolveSlackBotToken();
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
    const discord = new DiscordIntegration(
      await deps.serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL ?? undefined,
      await deps.serviceRegistry.resolveSecret('discord', 'primary') ?? process.env.DISCORD_BOT_TOKEN ?? undefined,
    );
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
    const topic = pending.topic ?? String(deps.configManager.get('surfaces.ntfy.topic') ?? '');
    if (!topic) return;
    const ntfy = new NtfyIntegration(
      String(deps.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
      await deps.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
    );
    await ntfy.publish(topic, progress.slice(0, 300), {
      title: `Agent ${pending.agentId}`,
      markGoodVibesOrigin: true,
    });
    return;
  }
  // Not a no-op. Returning here is what let a caller treat "this surface has
  // no direct-progress implementation" as "the message went out".
  throw new Error(
    `Direct surface progress is not implemented for ${pending.surfaceKind}; `
    + 'this surface delivers through the channel reply pipeline, so nothing was sent',
  );
}

export async function deliverSlackAgentReply(
  deps: SurfaceDirectDeliveryDeps,
  pending: PendingSurfaceReply,
  message: string,
): Promise<void> {
  const webhookUrl = await deps.resolveSlackWebhookUrl();
  const botToken = await deps.resolveSlackBotToken();
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

export async function deliverDiscordAgentReply(
  deps: SurfaceDirectDeliveryDeps,
  pending: PendingSurfaceReply,
  message: string,
): Promise<void> {
  const discord = new DiscordIntegration(
    await deps.serviceRegistry.resolveSecret('discord', 'webhookUrl') ?? process.env.DISCORD_WEBHOOK_URL ?? undefined,
    await deps.serviceRegistry.resolveSecret('discord', 'primary') ?? process.env.DISCORD_BOT_TOKEN ?? undefined,
  );
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

export async function deliverNtfyAgentReply(
  deps: SurfaceDirectDeliveryDeps,
  pending: PendingSurfaceReply,
  message: string,
): Promise<void> {
  const topic = pending.topic ?? String(deps.configManager.get('surfaces.ntfy.topic') ?? '');
  if (!topic) return;
  const ntfy = new NtfyIntegration(
    String(deps.configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh'),
    await deps.serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN ?? undefined,
  );
  // undefined = nothing configured resolves to an address a phone could
  // reach; publish without a click target rather than with a dead one.
  const baseAction = resolveReachableBaseUrl(deps.configManager as ConfigManager, 'off-host');
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

export async function deliverWebhookAgentReply(
  deps: SurfaceDirectDeliveryDeps,
  pending: PendingSurfaceReply,
  message: string,
): Promise<void> {
  const callbackUrl = pending.callbackUrl ?? String(deps.configManager.get('surfaces.webhook.defaultTarget') ?? '');
  if (!callbackUrl) return;
  const validation = validatePublicWebhookUrl(callbackUrl);
  if (!validation.ok) {
    logger.warn('DaemonServer: refusing unsafe webhook callback URL', {
      agentId: pending.agentId,
      reason: validation.error,
    });
    return;
  }
  const timeoutMs = Number(deps.configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
  const body = JSON.stringify({
    agentId: pending.agentId,
    sessionId: pending.sessionId ?? null,
    routeId: pending.routeId ?? null,
    task: pending.task,
    message,
    status: deps.agentManager.getStatus(pending.agentId)?.status ?? 'completed',
    correlationId: pending.callbackCorrelationId ?? null,
    completedAt: Date.now(),
  });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (pending.callbackCorrelationId) {
    headers.set('X-Goodvibes-Correlation-Id', pending.callbackCorrelationId);
  }
  const secret = String(deps.configManager.get('surfaces.webhook.secret') ?? '');
  if (secret && pending.callbackSignature === 'hmac-sha256') {
    headers.set('X-Goodvibes-Signature', deps.signWebhookPayload(body, secret));
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
