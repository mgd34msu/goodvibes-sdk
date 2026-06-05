import { ArtifactStore } from '../../artifacts/index.js';
import { ConfigManager } from '../../config/manager.js';
import { ServiceRegistry } from '../../config/service-registry.js';
import type { ChannelDeliveryStrategy } from './types.js';
import {
  appendAttachmentSummary,
  extractResponseId,
  firstNonEmpty,
  normalizeBaseUrl,
  postBridgePayload,
  requireOkResponse,
  resolveAttachments,
  resolveChannelDeliverySurfaceKind,
  success,
  trimForSurface,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';

export function createSignalDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:signal',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'signal';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bridgeUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        String(configManager.get('surfaces.signal.bridgeUrl') ?? ''),
        serviceRegistry.get('signal')?.baseUrl,
        process.env.SIGNAL_BRIDGE_URL,
      );
      const recipient = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.signal.defaultRecipient') ?? ''),
      );
      if (!bridgeUrl) throw new Error('Missing Signal bridge URL');
      if (!recipient) throw new Error('Missing Signal recipient');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('signal', 'primary'),
        String(configManager.get('surfaces.signal.token') ?? ''),
        process.env.SIGNAL_BRIDGE_TOKEN,
      );
      const responseId = await postBridgePayload(bridgeUrl, {
        surface: 'signal',
        account: firstNonEmpty(String(configManager.get('surfaces.signal.account') ?? '')),
        recipient,
        text: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        title: request.title,
        jobId: request.jobId,
        runId: request.runId,
        routeId: request.binding?.id,
        threadId: request.binding?.threadId,
        attachments,
      }, {
        label: 'Signal bridge delivery failed',
        token,
      });
      return success(responseId ?? recipient);
    },
  };
}

export function createWhatsAppDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:whatsapp',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'whatsapp';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const provider = firstNonEmpty(String(configManager.get('surfaces.whatsapp.provider') ?? ''), 'meta-cloud') ?? 'meta-cloud';
      const recipient = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.whatsapp.defaultRecipient') ?? ''),
      );
      if (!recipient) throw new Error('Missing WhatsApp recipient');
      if (provider === 'bridge') {
        const bridgeUrl = firstNonEmpty(
          request.target.address?.startsWith('https://') ? request.target.address : undefined,
          serviceRegistry.get('whatsapp')?.baseUrl,
          process.env.WHATSAPP_BRIDGE_URL,
        );
        if (!bridgeUrl) throw new Error('Missing WhatsApp bridge URL');
        const token = firstNonEmpty(
          await serviceRegistry.resolveSecret('whatsapp', 'primary'),
          String(configManager.get('surfaces.whatsapp.accessToken') ?? ''),
          process.env.WHATSAPP_ACCESS_TOKEN,
        );
        const responseId = await postBridgePayload(bridgeUrl, {
          surface: 'whatsapp',
          provider,
          recipient,
          text: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          attachments,
        }, {
          label: 'WhatsApp bridge delivery failed',
          token,
        });
        return success(responseId ?? recipient);
      }

      const phoneNumberId = firstNonEmpty(String(configManager.get('surfaces.whatsapp.phoneNumberId') ?? ''));
      const accessToken = firstNonEmpty(
        await serviceRegistry.resolveSecret('whatsapp', 'primary'),
        String(configManager.get('surfaces.whatsapp.accessToken') ?? ''),
        process.env.WHATSAPP_ACCESS_TOKEN,
      );
      if (!phoneNumberId) throw new Error('Missing WhatsApp phone number id');
      if (!accessToken) throw new Error('Missing WhatsApp access token');
      const apiBaseUrl = firstNonEmpty(process.env.WHATSAPP_BASE_URL, 'https://graph.facebook.com/v17.0')!;
      const response = await instrumentedFetch(`${normalizeBaseUrl(apiBaseUrl)}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'text',
          text: {
            preview_url: true,
            body: trimForSurface(appendAttachmentSummary(request.body, attachments), 4_096),
          },
        }),
      });
      const payload = await requireOkResponse('WhatsApp delivery failed', response);
      return success(extractResponseId(payload) ?? recipient);
    },
  };
}

function escapeTwiml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function createTelephonyDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:telephony',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'telephony';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const provider = firstNonEmpty(String(configManager.get('surfaces.telephony.provider') ?? ''), 'twilio') ?? 'twilio';
      const mode = firstNonEmpty(String(configManager.get('surfaces.telephony.mode') ?? ''), provider === 'bridge' ? 'bridge' : 'sms') ?? 'sms';
      const targetAddress = firstNonEmpty(request.target.address);
      const targetAddressIsBridgeUrl = targetAddress?.startsWith('https://') ?? false;
      const recipient = firstNonEmpty(
        targetAddressIsBridgeUrl ? undefined : targetAddress,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.telephony.defaultRecipient') ?? ''),
      );
      if (!recipient) throw new Error('Missing telephony recipient');
      const text = trimForSurface(appendAttachmentSummary(request.body, attachments), mode === 'voice' ? 1_400 : 1_600);

      if (provider === 'bridge' || mode === 'bridge') {
        const bridgeUrl = firstNonEmpty(
          targetAddressIsBridgeUrl ? targetAddress : undefined,
          String(configManager.get('surfaces.telephony.bridgeUrl') ?? ''),
          serviceRegistry.get('telephony')?.baseUrl,
          process.env.TELEPHONY_BRIDGE_URL,
        );
        if (!bridgeUrl) throw new Error('Missing telephony bridge URL');
        const token = firstNonEmpty(
          await serviceRegistry.resolveSecret('telephony', 'primary'),
          String(configManager.get('surfaces.telephony.token') ?? ''),
          process.env.TELEPHONY_BRIDGE_TOKEN,
        );
        const responseId = await postBridgePayload(bridgeUrl, {
          surface: 'telephony',
          mode,
          recipient,
          from: firstNonEmpty(String(configManager.get('surfaces.telephony.fromNumber') ?? '')),
          text,
          title: request.title,
          jobId: request.jobId,
          runId: request.runId,
          routeId: request.binding?.id,
          threadId: request.binding?.threadId,
          attachments,
        }, {
          label: 'Telephony bridge delivery failed',
          token,
        });
        return success(responseId ?? recipient);
      }

      const accountSid = firstNonEmpty(String(configManager.get('surfaces.telephony.accountSid') ?? ''), process.env.TWILIO_ACCOUNT_SID);
      const authToken = firstNonEmpty(
        await serviceRegistry.resolveSecret('telephony', 'authToken'),
        String(configManager.get('surfaces.telephony.authToken') ?? ''),
        process.env.TWILIO_AUTH_TOKEN,
      );
      const fromNumber = firstNonEmpty(String(configManager.get('surfaces.telephony.fromNumber') ?? ''), process.env.TWILIO_FROM_NUMBER, process.env.TELEPHONY_FROM_NUMBER);
      if (!accountSid) throw new Error('Missing Twilio account SID');
      if (!authToken) throw new Error('Missing Twilio auth token');
      if (!fromNumber) throw new Error('Missing telephony from number');
      const body = new URLSearchParams({
        To: recipient,
        From: fromNumber,
        ...(mode === 'voice'
          ? {
              Twiml: `<Response><Say language="${escapeTwiml(firstNonEmpty(String(configManager.get('surfaces.telephony.voiceLanguage') ?? ''), 'en-US')!)}">${escapeTwiml(text)}</Say></Response>`,
            }
          : {
              Body: text,
            }),
      });
      const endpoint = mode === 'voice' ? 'Calls' : 'Messages';
      const response = await instrumentedFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/${endpoint}.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
        body: body.toString(),
      });
      const payload = await requireOkResponse(`Telephony ${mode === 'voice' ? 'call' : 'message'} delivery failed`, response);
      return success(extractResponseId(payload) ?? recipient);
    },
  };
}

export function createIMessageDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:imessage',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'imessage';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager);
      const bridgeUrl = firstNonEmpty(
        request.target.address?.startsWith('https://') ? request.target.address : undefined,
        String(configManager.get('surfaces.imessage.bridgeUrl') ?? ''),
        serviceRegistry.get('imessage')?.baseUrl,
        process.env.IMESSAGE_BRIDGE_URL,
      );
      const chatId = firstNonEmpty(
        request.target.address?.startsWith('https://') ? undefined : request.target.address,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.imessage.defaultChatId') ?? ''),
      );
      if (!bridgeUrl) throw new Error('Missing iMessage bridge URL');
      if (!chatId) throw new Error('Missing iMessage chat id');
      const token = firstNonEmpty(
        await serviceRegistry.resolveSecret('imessage', 'primary'),
        String(configManager.get('surfaces.imessage.token') ?? ''),
        process.env.IMESSAGE_BRIDGE_TOKEN,
      );
      const responseId = await postBridgePayload(bridgeUrl, {
        surface: 'imessage',
        account: firstNonEmpty(String(configManager.get('surfaces.imessage.account') ?? '')),
        chatId,
        text: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        title: request.title,
        jobId: request.jobId,
        runId: request.runId,
        routeId: request.binding?.id,
        threadId: request.binding?.threadId,
        attachments,
      }, {
        label: 'iMessage bridge delivery failed',
        token,
      });
      return success(responseId ?? chatId);
    },
  };
}

export function createBlueBubblesDeliveryStrategy(
  configManager: ConfigManager,
  serviceRegistry: ServiceRegistry,
  artifactStore: ArtifactStore,
): ChannelDeliveryStrategy {
  return {
    id: 'channel-delivery:bluebubbles',
    canHandle(request) {
      return resolveChannelDeliverySurfaceKind(request.target) === 'bluebubbles';
    },
    async deliver(request) {
      const attachments = await resolveAttachments(request, artifactStore, configManager, 128 * 1024);
      const serverUrl = firstNonEmpty(
        String(configManager.get('surfaces.bluebubbles.serverUrl') ?? ''),
        serviceRegistry.get('bluebubbles')?.baseUrl,
        process.env.BLUEBUBBLES_SERVER_URL,
      );
      const password = firstNonEmpty(
        await serviceRegistry.resolveSecret('bluebubbles', 'password'),
        String(configManager.get('surfaces.bluebubbles.password') ?? ''),
        process.env.BLUEBUBBLES_PASSWORD,
      );
      const chatGuid = firstNonEmpty(
        request.target.address,
        typeof request.binding?.metadata.chatGuid === 'string' ? request.binding.metadata.chatGuid : undefined,
        request.binding?.channelId,
        request.binding?.externalId,
        String(configManager.get('surfaces.bluebubbles.defaultChatGuid') ?? ''),
      );
      if (!serverUrl) throw new Error('Missing BlueBubbles server URL');
      if (!password) throw new Error('Missing BlueBubbles password');
      if (!chatGuid) throw new Error('Missing BlueBubbles chat guid');
      const response = await instrumentedFetch(`${normalizeBaseUrl(serverUrl)}/api/v1/message/text?password=${encodeURIComponent(password)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatGuid,
          tempGuid: crypto.randomUUID(),
          message: trimForSurface(appendAttachmentSummary(request.body, attachments), 8_000),
        }),
      });
      const payload = await requireOkResponse('BlueBubbles delivery failed', response);
      return success(extractResponseId(payload) ?? chatGuid);
    },
  };
}
