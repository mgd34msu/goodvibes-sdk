import { ArtifactStore } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import { ServiceRegistry } from '../../config/service-registry.js';
import { resolveSecretInput } from '../../config/secret-refs.js';
import { ControlPlaneGateway } from '../../control-plane/gateway.js';
import { DiscordIntegration, HomeAssistantIntegration, NtfyIntegration, SlackIntegration } from '../../integrations/index.js';
import { validatePublicWebhookUrl } from '../../utils/url-safety.js';
import type { ChannelDeliveryStrategy } from './types.js';
import {
  appendAttachmentSummary,
  extractResponseId,
  firstNonEmpty,
  requireOkResponse,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  success,
  titleFromBody,
  trimForSurface,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';

export function createWebhookDeliveryStrategy(configManager: ConfigManager, artifactStore: ArtifactStore): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:webhook',
    canHandle(request) {
      return request.target.kind === 'webhook' || resolveChannelDeliverySurfaceKind(request.target) === 'webhook';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const address = request.target.address
        ?? (typeof request.binding?.metadata.callbackUrl === 'string' ? request.binding.metadata.callbackUrl : undefined)
        ?? String(configManager.get('surfaces.webhook.defaultTarget') ?? '');
      if (!address) throw new Error('Missing webhook delivery target');
      const validation = validatePublicWebhookUrl(address);
      if (!validation.ok) throw new Error(validation.error);
      const timeoutMs = Number(configManager.get('surfaces.webhook.timeoutMs') ?? 15_000);
      const response = await instrumentedFetch(validation.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          text: request.body,
          message: request.body,
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          attachments,
          artifacts: attachments,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
      }
      return success(validation.url);
    },
  };
}

export function createSlackDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:slack',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'slack';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const webhookUrl =
        await serviceRegistry.resolveSecret('slack', 'webhookUrl')
        ?? process.env.SLACK_WEBHOOK_URL;
      const botToken =
        await serviceRegistry.resolveSecret('slack', 'primary')
        ?? await resolveSecretInput(configManager.get('surfaces.slack.botToken'), {
          resolveLocalSecret: secretsManager ? (key) => secretsManager.get(key) : undefined,
          homeDirectory: secretsManager?.getGlobalHome?.() ?? undefined,
        })
        ?? process.env.SLACK_BOT_TOKEN;
      const slack = new SlackIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const responseUrl = typeof request.binding?.metadata.responseUrl === 'string'
        ? request.binding.metadata.responseUrl
        : undefined;
      if (responseUrl?.startsWith('https://hooks.slack.com/')) {
        await instrumentedFetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type: 'in_channel',
            blocks: slack.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments),
          }),
        });
        return success(responseUrl);
      }
      if (request.target.address?.startsWith('https://')) {
        await slack.postWebhook(bodyWithAttachments, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await slack.postMessage(request.target.address, bodyWithAttachments);
        return success(request.target.address);
      }
      await slack.postWebhook(bodyWithAttachments);
      return success(webhookUrl ?? undefined);
    },
  };
}

export function createDiscordDeliveryStrategy(
  serviceRegistry: ServiceRegistry,
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:discord',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'discord';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bodyWithAttachments = appendAttachmentSummary(request.body, attachments);
      const webhookUrl =
        await serviceRegistry.resolveSecret('discord', 'webhookUrl')
        ?? process.env.DISCORD_WEBHOOK_URL;
      const botToken =
        await serviceRegistry.resolveSecret('discord', 'primary')
        ?? process.env.DISCORD_BOT_TOKEN;
      const discord = new DiscordIntegration(webhookUrl ?? undefined, botToken ?? undefined);
      const applicationId = typeof request.binding?.metadata.applicationId === 'string'
        ? request.binding.metadata.applicationId
        : undefined;
      const interactionToken = typeof request.binding?.metadata.interactionToken === 'string'
        ? request.binding.metadata.interactionToken
        : undefined;
      if (applicationId && interactionToken) {
        await discord.editOriginalResponse(
          applicationId,
          interactionToken,
          '',
          [discord.formatAgentResult(request.agentId ?? request.runId, request.title, bodyWithAttachments)],
        );
        return success(`${applicationId}:${interactionToken}`);
      }
      if (request.target.address?.startsWith('https://')) {
        await discord.postWebhook(bodyWithAttachments, undefined, request.target.address);
        return success(request.target.address);
      }
      if (request.target.address) {
        await discord.postMessage(request.target.address, bodyWithAttachments);
        return success(request.target.address);
      }
      await discord.postWebhook(bodyWithAttachments);
      return success(webhookUrl ?? undefined);
    },
  };
}

export function createNtfyDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:ntfy',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'ntfy';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const baseUrl = String(configManager.get('surfaces.ntfy.baseUrl') ?? 'https://ntfy.sh');
      const token = await serviceRegistry.resolveSecret('ntfy', 'primary') ?? process.env.NTFY_ACCESS_TOKEN;
      const topic = request.target.address ?? String(configManager.get('surfaces.ntfy.topic') ?? '');
      if (!topic) throw new Error('Missing ntfy topic');
      const ntfy = new NtfyIntegration(baseUrl, token ?? undefined);
      const baseUrlHint = String(configManager.get('controlPlane.baseUrl') ?? configManager.get('web.publicBaseUrl') ?? '');
      const primaryAttachment = attachments[0];
      await ntfy.publish(topic, appendAttachmentSummary(request.body, attachments), {
        title: request.target.label ?? titleFromBody(request.body),
        ...(request.includeLinks && baseUrlHint ? { click: `${baseUrlHint.replace(/\/+$/, '')}/api/control-plane/web` } : {}),
        ...(primaryAttachment?.contentUrl ? { attach: primaryAttachment.contentUrl } : {}),
        markGoodVibesOrigin: true,
      });
      return success(topic);
    },
  };
}

export function createWebControlPlaneDeliveryStrategy(
  configManager: ConfigManager,
  artifactStore: ArtifactStore,
  getGateway: () => ControlPlaneGateway | null,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:web-control-plane',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'web';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const gateway = getGateway();
      if (!gateway) {
        throw new Error('Web control-plane gateway unavailable');
      }
      const published = gateway.publishSurfaceMessage({
        surface: 'web',
        title: request.target.label ?? request.title,
        body: request.body,
        level: request.status === 'failed' ? 'error' : request.status === 'completed' ? 'success' : 'info',
        routeId: request.binding?.id ?? request.target.routeId,
        surfaceId: request.binding?.surfaceId,
        attachments,
        metadata: {
          jobId: request.jobId,
          runId: request.runId,
          agentId: request.agentId,
        },
      });
      return success(published.id);
    },
  };
}

export function createHomeAssistantDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
  secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'>,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:homeassistant',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'homeassistant';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const baseUrl = firstNonEmpty(
        String(configManager.get('surfaces.homeassistant.instanceUrl') ?? ''),
        serviceRegistry.get('homeassistant')?.baseUrl,
        process.env.HOMEASSISTANT_URL,
        process.env.HOME_ASSISTANT_URL,
        process.env.HA_URL,
      );
      if (!baseUrl) throw new Error('Missing Home Assistant instance URL');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('homeassistant', 'primary'),
        await resolveSecretInput(configManager.get('surfaces.homeassistant.accessToken'), {
          resolveLocalSecret: secretsManager ? (key) => secretsManager.get(key) : undefined,
          homeDirectory: secretsManager?.getGlobalHome?.() ?? undefined,
        }),
        process.env.HOMEASSISTANT_ACCESS_TOKEN,
        process.env.HOME_ASSISTANT_ACCESS_TOKEN,
        process.env.HA_ACCESS_TOKEN,
      );
      if (!token) throw new Error('Missing Home Assistant access token');
      const eventType = firstNonEmpty(
        String(configManager.get('surfaces.homeassistant.eventType') ?? ''),
        'goodvibes_message',
      )!;
      const client = new HomeAssistantIntegration({ baseUrl, accessToken: token });
      const result = await client.publishGoodVibesEvent(eventType, {
        type: request.status === 'failed' ? 'error' : 'message',
        title: request.target.label ?? request.title,
        body: appendAttachmentSummary(request.body, attachments),
        status: request.status,
        jobId: request.jobId,
        runId: request.runId,
        agentId: request.agentId,
        routeId: request.binding?.id,
        surfaceId: request.binding?.surfaceId,
        externalId: request.binding?.externalId,
        metadata: {
          threadId: request.binding?.threadId,
          channelId: request.binding?.channelId,
          attachments,
        },
      });
      return success(extractResponseId(result) ?? eventType);
    },
  };
}

export function createTelegramDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:telegram',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'telegram';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('telegram', 'primary'),
        String(configManager.get('surfaces.telegram.botToken') ?? ''),
        process.env.TELEGRAM_BOT_TOKEN,
      );
      const chatId = firstNonEmpty(
        request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.telegram.defaultChatId') ?? ''),
      );
      if (!token) throw new Error('Missing Telegram bot token');
      if (!chatId) throw new Error('Missing Telegram chat id');
      const response = await instrumentedFetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          disable_web_page_preview: true,
          ...(request.binding?.threadId && /^\d+$/.test(request.binding.threadId)
            ? { message_thread_id: Number(request.binding.threadId) }
            : {}),
        }),
      });
      const payload = await requireOkResponse('Telegram delivery failed', response);
      return success(extractResponseId(payload) ?? chatId);
    },
  };
}

export function createGoogleChatDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:google-chat',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'google-chat';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const webhookUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        await serviceRegistry.resolveSecret('google-chat', 'webhookUrl'),
        serviceRegistry.get('google-chat')?.baseUrl,
        String(configManager.get('surfaces.googleChat.webhookUrl') ?? ''),
        process.env.GOOGLE_CHAT_WEBHOOK_URL,
      );
      if (!webhookUrl) {
        throw new Error('Missing Google Chat webhook URL');
      }
      const threadKey = firstNonEmpty(request.binding?.threadId, request.binding?.channelId, request.binding?.externalId);
      const response = await instrumentedFetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_000),
          ...(threadKey ? { thread: { threadKey } } : {}),
        }),
      });
      const payload = await requireOkResponse('Google Chat delivery failed', response);
      return success(extractResponseId(payload) ?? webhookUrl);
    },
  };
}
