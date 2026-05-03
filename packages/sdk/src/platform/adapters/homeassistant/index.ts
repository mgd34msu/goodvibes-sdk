import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { SurfaceAdapterContext } from '../types.js';
import { parseJsonRecord, readTextBodyWithinLimit } from '../helpers.js';
import {
  HOME_ASSISTANT_SURFACE,
  resolveHomeAssistantWebhookSecret,
} from '../../channels/builtin/homeassistant.js';
import type { ChannelConversationKind } from '../../channels/index.js';

export async function handleHomeAssistantSurfaceWebhook(
  req: Request,
  context: SurfaceAdapterContext,
): Promise<Response> {
  const enabled = Boolean(context.configManager.get('surfaces.homeassistant.enabled'));
  const secret = await resolveHomeAssistantWebhookSecret(context);
  if (!enabled || !secret) {
    return Response.json({ error: 'Home Assistant ingress is not configured' }, { status: 503 });
  }

  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  if (!isAuthorizedHomeAssistantRequest(req, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const contentType = req.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') || rawBody.trim().startsWith('{')
    ? parseJsonRecord(rawBody)
    : { message: rawBody.trim() };
  if (body instanceof Response) return body;

  const text = readString(body.prompt)
    ?? readString(body.message)
    ?? readString(body.text)
    ?? readString(body.task)
    ?? '';
  const controlCommand = text ? context.parseSurfaceControlCommand(text) : null;
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ acknowledged: true, control: true, message });
  }

  const conversationId = readString(body.conversationId ?? body.conversation_id)
    ?? readString(body.threadId ?? body.thread_id)
    ?? readString(body.deviceId ?? body.device_id)
    ?? String(context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes');
  const surfaceId = readString(body.surfaceId ?? body.instanceId ?? body.instance_id)
    ?? readString(body.hassInstanceId ?? body.hass_instance_id)
    ?? 'homeassistant';
  const threadId = readString(body.threadId ?? body.thread_id);
  const channelId = readString(body.areaId ?? body.area_id)
    ?? readString(body.entityId ?? body.entity_id)
    ?? conversationId;
  const messageId = readString(body.messageId ?? body.message_id) ?? `ha-${randomUUID()}`;
  const mode = readString(body.mode ?? body.type)?.toLowerCase() ?? 'prompt';
  const conversationKind = conversationKindForHomeAssistant(mode, threadId, channelId);

  const policy = await context.authorizeSurfaceIngress({
    surface: HOME_ASSISTANT_SURFACE,
    userId: readString(body.userId ?? body.user_id),
    channelId,
    groupId: readString(body.areaId ?? body.area_id) ?? channelId,
    threadId,
    workspaceId: readString(body.instanceId ?? body.instance_id),
    conversationKind,
    hasAnyMention: typeof body.hasAnyMention === 'boolean' ? body.hasAnyMention : true,
    text,
    mentioned: typeof body.mentioned === 'boolean' ? body.mentioned : true,
    metadata: body,
  });
  if (!policy.allowed) {
    return Response.json({ error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  if (!text.trim()) {
    await context.routeBindings.start();
    const binding = await context.routeBindings.upsertBinding({
      kind: threadId ? 'thread' : 'channel',
      surfaceKind: HOME_ASSISTANT_SURFACE,
      surfaceId,
      externalId: conversationId,
      threadId,
      channelId,
      title: readString(body.title) ?? 'Home Assistant',
      metadata: {
        ...body,
        directoryKind: conversationKind === 'direct' ? 'user' : conversationKind,
        source: 'homeassistant',
        messageId,
        conversationId,
      },
    });
    await context.routeBindings.patchBinding(binding.id, {
      sessionId: null,
      jobId: null,
      runId: null,
    });
    return Response.json({
      acknowledged: true,
      queued: false,
      bindingId: binding.id,
    });
  }

  const routing = readRouting(body);
  if (!context.postHomeAssistantChatMessage) {
    return Response.json({ error: 'Home Assistant remote chat is unavailable in this runtime' }, { status: 503 });
  }
  const result = await context.postHomeAssistantChatMessage({
    body: text,
    messageId,
    conversationId,
    surfaceId,
    channelId,
    ...(threadId ? { threadId } : {}),
    ...(readString(body.userId ?? body.user_id) ? { userId: readString(body.userId ?? body.user_id)! } : {}),
    ...(readString(body.displayName ?? body.userName ?? body.user_name) ? { displayName: readString(body.displayName ?? body.userName ?? body.user_name)! } : {}),
    title: readString(body.title) ?? 'Home Assistant',
    ...(routing?.providerId ? { providerId: routing.providerId } : {}),
    ...(routing?.modelId ? { modelId: routing.modelId } : {}),
    ...(routing?.tools?.length ? { tools: routing.tools } : {}),
    context: {
      ...body,
      source: 'homeassistant',
      messageId,
      conversationId,
      deviceId: readString(body.deviceId ?? body.device_id) ?? null,
      entityId: readString(body.entityId ?? body.entity_id) ?? null,
    },
    publishEvent: true,
  });

  return Response.json({
    acknowledged: true,
    queued: false,
    delivered: result.delivered,
    ...(result.routeId ? { bindingId: result.routeId } : {}),
    sessionId: result.sessionId,
    messageId,
    ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
    ...(result.error ? { error: result.error } : {}),
    conversationId,
  });
}

function isAuthorizedHomeAssistantRequest(req: Request, secret: string): boolean {
  const candidates = [
    req.headers.get('x-goodvibes-homeassistant-secret'),
    req.headers.get('x-goodvibes-webhook-secret'),
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return candidates.some((candidate) => safeEqual(candidate, secret));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function conversationKindForHomeAssistant(
  mode: string,
  threadId: string | undefined,
  channelId: string | undefined,
): ChannelConversationKind {
  if (threadId) return 'thread';
  if (mode === 'conversation' || mode === 'chat' || mode === 'prompt') return 'direct';
  return channelId ? 'channel' : 'service';
}

function readRouting(body: Record<string, unknown>): {
  providerId?: string;
  modelId?: string;
  tools?: readonly string[];
} | undefined {
  const providerId = readString(body.providerId ?? body.provider);
  const modelId = readString(body.modelId ?? body.model);
  const tools = readStringList(body.tools);
  if (!providerId && !modelId && !tools.length) return undefined;
  return {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}
