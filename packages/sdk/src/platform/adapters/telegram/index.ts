import type { SurfaceAdapterContext } from '../types.js';
import { constantTimeEquals, parseJsonRecord, readTextBodyWithinLimit } from '../helpers.js';
import { logger } from '../../utils/logger.js';
import { parseTelegramBotCommand, telegramBotCommandReply } from './commands.js';

/**
 * Capabilities an ingress mode lends to update handling.
 *
 * Both the webhook route and the getUpdates poller process updates through the
 * SAME function below; this is the only thing that differs between them. The
 * poller passes a live Bot API sender; a webhook caller may pass one too, and
 * omits it only where no bot token is resolvable.
 */
export interface TelegramUpdateDeps {
  readonly sendMessage?: ((input: {
    readonly chatId: string;
    readonly text: string;
    readonly threadId?: string | undefined;
  }) => Promise<void>) | undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumberString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBotUsername(value?: string): string {
  return value ? value.replace(/^@/, '').trim() : '';
}

function extractTelegramTask(message: Record<string, unknown>, botUsername?: string): string {
  const text = readString(message.text) ?? readString(message.caption) ?? '';
  if (!text) return '';
  const trimmed = text.trim();
  const botHandle = normalizeBotUsername(botUsername);
  const commandPattern = botHandle
    ? new RegExp(`^/goodvibes(?:@${escapeRegExp(botHandle)})?\\s*`, 'i')
    : /^\/goodvibes\s*/i;
  return trimmed.replace(commandPattern, '').trim();
}

function telegramConversationKind(chatType?: string, threadId?: string): import('../../channels/index.js').ChannelConversationKind {
  if (threadId) return 'thread';
  if (chatType === 'private') return 'direct';
  if (chatType === 'channel') return 'channel';
  return 'group';
}

/**
 * HTTP entry point for webhook mode.
 *
 * Everything here is webhook-SPECIFIC: the shared-secret header check and the
 * request body read. Telegram sends the secret token only on webhook POSTs, so
 * this check must not sit in the shared path — a polled update carries no
 * headers and would be rejected by it.
 */
export async function handleTelegramSurfaceWebhook(
  req: Request,
  context: SurfaceAdapterContext,
  deps: TelegramUpdateDeps = {},
): Promise<Response> {
  const configuredSecret =
    String(context.configManager.get('surfaces.telegram.webhookSecret') ?? '')
    || await context.serviceRegistry.resolveSecret('telegram', 'signingSecret')
    || process.env.TELEGRAM_WEBHOOK_SECRET
    || '';
  if (configuredSecret) {
    const providedSecret = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!constantTimeEquals(configuredSecret, providedSecret)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  const rawBody = await readTextBodyWithinLimit(req);
  if (rawBody instanceof Response) return rawBody;
  const body = parseJsonRecord(rawBody);
  if (body instanceof Response) return body;
  const payload = readRecord(body);
  if (!payload) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  return processTelegramUpdate(payload, context, deps);
}

/**
 * Handle one Telegram Update object — policy, route binding, standard bot
 * commands, control commands, and task dispatch.
 *
 * Shared verbatim by webhook mode and getUpdates polling so the two can never
 * drift into different behaviour for the same message. The Response return
 * shape is what the webhook route replies with; the poller reads it only for
 * logging.
 */
export async function processTelegramUpdate(
  payload: Record<string, unknown>,
  context: SurfaceAdapterContext,
  deps: TelegramUpdateDeps = {},
): Promise<Response> {
  const message = readRecord(payload.message)
    ?? readRecord(payload.edited_message)
    ?? readRecord(payload.channel_post)
    ?? readRecord(payload.edited_channel_post);
  if (!message) {
    logger.info('handleTelegramSurfaceWebhook: update ignored', {
      reason: 'unsupported-update-type',
      updateId: readNumberString(payload.update_id),
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unsupported-update-type',
      updateId: readNumberString(payload.update_id) ?? null,
    });
  }

  const chat = readRecord(message.chat);
  const from = readRecord(message.from);
  const chatId = readNumberString(chat?.id);
  if (!chatId) {
    logger.info('handleTelegramSurfaceWebhook: update ignored', {
      reason: 'missing-chat-id',
      updateId: readNumberString(payload.update_id),
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'missing-chat-id',
      updateId: readNumberString(payload.update_id) ?? null,
    });
  }
  const threadId = readNumberString(message.message_thread_id);
  const botUsername = readString(context.configManager.get('surfaces.telegram.botUsername'));
  const botHandle = normalizeBotUsername(botUsername);
  const task = extractTelegramTask(message, botUsername);
  const text = readString(message.text) ?? readString(message.caption) ?? '';
  const mentioned = Boolean(
    (chat?.type === 'private')
    || /^\/goodvibes\b/i.test(text)
    || (botHandle && new RegExp(`@${escapeRegExp(botHandle)}\\b`, 'i').test(text)),
  );
  const policy = await context.authorizeSurfaceIngress({
    surface: 'telegram',
    userId: readNumberString(from?.id),
    channelId: chatId,
    groupId: chatId,
    threadId,
    workspaceId: readString(chat?.username),
    conversationKind: telegramConversationKind(readString(chat?.type), threadId),
    text: task || text,
    mentioned,
    metadata: {
      updateId: readNumberString(payload.update_id),
      chatType: readString(chat?.type),
      chatTitle: readString(chat?.title),
      fromUsername: readString(from?.username),
    },
  });
  if (!policy.allowed) {
    return Response.json({ ok: false, error: `Blocked by channel policy: ${policy.reason}` }, { status: 403 });
  }

  const binding = await context.routeBindings.upsertBinding({
    kind: threadId ? 'thread' : 'channel',
    surfaceKind: 'telegram',
    surfaceId: botUsername || 'telegram',
    externalId: threadId ?? chatId,
    channelId: chatId,
    threadId,
    title: readString(chat?.title) ?? readString(chat?.username) ?? chatId,
    metadata: {
      chatType: readString(chat?.type),
      fromId: readNumberString(from?.id),
      fromUsername: readString(from?.username),
      updateId: readNumberString(payload.update_id),
    },
  });

  // Standard Telegram bot commands are onboarding, not work. This runs AFTER
  // the route binding above (so the reply has a bound conversation to land in)
  // and BEFORE task dispatch — otherwise `/start`, which every new user sends
  // first, spawns an agent whose task is the literal string "/start".
  const botCommand = parseTelegramBotCommand(text, botUsername);
  if (botCommand) {
    const reply = telegramBotCommandReply(botCommand.command, {
      botUsername,
      isPrivateChat: readString(chat?.type) === 'private',
    });
    let replied = false;
    if (deps.sendMessage) {
      try {
        await deps.sendMessage({ chatId, text: reply, threadId });
        replied = true;
      } catch (error) {
        logger.warn('processTelegramUpdate: onboarding reply failed', {
          command: botCommand.command,
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info('processTelegramUpdate: standard bot command handled', {
      command: botCommand.command,
      bindingId: binding.id,
      chatId,
      threadId,
      replied,
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'command',
      command: botCommand.command,
      bindingId: binding.id,
      replied,
      // Webhook mode can answer inline: Telegram accepts a method call as the
      // webhook response body, so a daemon with no outbound sender still
      // replies. The poller ignores these fields and uses sendMessage.
      method: 'sendMessage',
      chat_id: chatId,
      text: reply,
      ...(threadId && /^\d+$/.test(threadId) ? { message_thread_id: Number(threadId) } : {}),
    });
  }

  if (!task) {
    logger.info('handleTelegramSurfaceWebhook: message acknowledged without queueing', {
      reason: 'no-actionable-text',
      bindingId: binding.id,
      chatId,
      threadId,
    });
    return Response.json({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-actionable-text',
      bindingId: binding.id,
    });
  }

  const controlCommand = context.parseSurfaceControlCommand(task);
  if (controlCommand) {
    const message = await context.performSurfaceControlCommand(controlCommand);
    return Response.json({ ok: true, acknowledged: true, message });
  }

  const submission = await context.sessionBroker.submitMessage({
    routeId: binding.id,
    surfaceKind: 'telegram',
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    threadId: binding.threadId ?? binding.channelId,
    userId: readNumberString(from?.id),
    displayName: readString(from?.username) ?? readString(from?.first_name),
    title: binding.title ?? 'Telegram',
    body: task,
    metadata: {
      chatType: readString(chat?.type),
      updateId: readNumberString(payload.update_id),
    },
  });
  if (submission.mode === 'continued-live') {
    return Response.json({ ok: true, continued: true, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null });
  }

  const spawnResult = context.trySpawnAgent(
    { mode: 'spawn', task: submission.task! },
    'handleTelegramSurfaceWebhook',
    submission.session.id,
  );
  if (spawnResult instanceof Response) return spawnResult;
  await context.sessionBroker.bindAgent(submission.session.id, spawnResult.id);
  context.queueSurfaceReplyFromBinding(submission.routeBinding ?? binding, {
    agentId: spawnResult.id,
    task,
    sessionId: submission.session.id,
  });
  return Response.json({
    ok: true,
    queued: true,
    bindingId: binding.id,
    sessionId: submission.session.id,
    agentId: spawnResult.id,
  });
}
