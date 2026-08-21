/**
 * commands.ts, the standard Telegram bot commands every client offers.
 *
 * Telegram's own UI puts `/start` in front of every new user: tapping "Start"
 * on a bot sends it before any conversation exists. `/help` and `/stop` are the
 * other two BotFather-documented commands clients surface in the command menu.
 *
 * These are ONBOARDING, not work. Routing them through the normal task path
 * spawns an agent whose task is the literal string "/start", which is what the
 * adapter used to do, and it is both useless and surprising. They are answered
 * here instead, after the route binding is established so the reply lands in a
 * chat the daemon can talk back to.
 *
 * `/goodvibes` is deliberately NOT in this set: it is the task prefix, stripped
 * by extractTelegramTask, and the text after it is real work.
 */

/** A standard Telegram bot command the adapter answers itself. */
export type TelegramBotCommand = 'start' | 'help' | 'stop';

export interface ParsedTelegramBotCommand {
  readonly command: TelegramBotCommand;
  /** Anything after the command, e.g. a `/start <payload>` deep-link value. */
  readonly args: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recognise `/start`, `/help`, or `/stop`, with or without the `@botname`
 * suffix Telegram appends in group chats, and with or without trailing
 * arguments (`/start` carries a deep-link payload when the user arrives from a
 * t.me link). Returns null for anything else, including a bare `/` or an
 * unrelated slash command, which stay on the normal task path.
 */
export function parseTelegramBotCommand(
  text: string | undefined,
  botUsername?: string,
): ParsedTelegramBotCommand | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const handle = botUsername ? botUsername.replace(/^@/, '').trim() : '';
  const suffix = handle ? `(?:@${escapeRegExp(handle)})?` : '(?:@[A-Za-z0-9_]+)?';
  const match = new RegExp(`^/(start|help|stop)${suffix}(?:\\s+([\\s\\S]*))?$`, 'i').exec(trimmed);
  if (!match) return null;
  return {
    command: match[1]!.toLowerCase() as TelegramBotCommand,
    args: (match[2] ?? '').trim(),
  };
}

/**
 * The reply text for a standard command. Written to answer the question a new
 * user actually has, "I pressed Start, now what?", rather than confirming
 * receipt and leaving them staring at an idle chat.
 */
export function telegramBotCommandReply(
  command: TelegramBotCommand,
  options: { readonly botUsername?: string | undefined; readonly isPrivateChat: boolean },
): string {
  const handle = options.botUsername ? `@${options.botUsername.replace(/^@/, '')}` : '@yourbot';
  const addressing = options.isPrivateChat
    ? 'In this direct chat, just talk to me. Messages are a conversation, not orders, if something looks like real work, I ask before starting it.'
    : `In a group, address me directly: "/goodvibes <message>" or "${handle} <message>". I ignore everything else so I do not interrupt the conversation. If something looks like real work, I ask before starting it.`;

  if (command === 'stop') {
    return [
      'Stopping.',
      '',
      'To stop a task that is already running, send "cancel <id>", the id comes back when the task starts.',
      'To stop me reaching this chat entirely, disable the Telegram surface in your GoodVibes settings (surfaces.telegram.enabled=false); I cannot remove my own access from here.',
    ].join('\n');
  }

  const header = command === 'start'
    ? 'GoodVibes is connected. Talk to me here, and I can run work on your machine when you ask me to.'
    : 'GoodVibes, how to talk to me:';

  return [
    header,
    '',
    addressing,
    '',
    'When I propose work, reply "yes" (or "go ahead") to start it, or say no and I drop it.',
    '',
    'Once work is running:',
    '  status <id>, where it has got to',
    '  cancel <id>, stop it',
    '  retry <id>, run it again after a failure',
    '',
    'Send /help any time to see this again.',
  ].join('\n');
}
