/**
 * Adapter behavioral coverage, Telegram adapter.
 */
import { describe, expect, test } from 'bun:test';
import { handleTelegramSurfaceWebhook } from '../packages/sdk/src/platform/adapters/telegram/index.js';

function makeTelegramContext(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const binding = {
    id: 'binding-1',
    kind: 'thread',
    surfaceKind: 'telegram',
    surfaceId: 'goodvibes_bot',
    externalId: '99',
    channelId: '12345',
    threadId: '99',
    title: 'Team Chat',
    metadata: {},
  };
  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: {
        get: (key: string) => {
          if (key === 'surfaces.telegram.webhookSecret') return 'telegram-secret';
          if (key === 'surfaces.telegram.botUsername') return 'goodvibes_bot';
          return undefined;
        },
      },
      routeBindings: {
        upsertBinding: async (input: unknown) => {
          calls.push({ kind: 'upsertBinding', input });
          return binding;
        },
      },
      sessionBroker: {
        submitMessage: async (input: unknown) => {
          calls.push({ kind: 'submitMessage', input });
          return {
            mode: 'spawn',
            task: { prompt: 'triage build' },
            session: { id: 'session-1' },
            routeBinding: binding,
          };
        },
        bindAgent: async (sessionId: string, agentId: string) => {
          calls.push({ kind: 'bindAgent', input: { sessionId, agentId } });
        },
      },
      authorizeSurfaceIngress: async (input: unknown) => {
        calls.push({ kind: 'authorizeSurfaceIngress', input });
        return { allowed: true };
      },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return { id: 'agent-1' };
      },
      queueSurfaceReplyFromBinding: (routeBinding: unknown, input: unknown) => {
        calls.push({ kind: 'queueSurfaceReplyFromBinding', input: { routeBinding, input } });
      },
      ...overrides,
    } as never,
  };
}

describe('telegram adapter — contract surface', () => {
  test('rejects requests with a mismatched Telegram webhook secret', async () => {
    const { context } = makeTelegramContext();
    const res = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      body: JSON.stringify({ message: { chat: { id: 12345, type: 'private' }, text: 'hello' } }),
    }), context);
    expect(res.status).toBe(401);
  });

  test('acknowledges unsupported updates with an explicit ignored outcome', async () => {
    const { context, calls } = makeTelegramContext();
    const res = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      body: JSON.stringify({ update_id: 99, my_chat_member: { chat: { id: 12345 } } }),
    }), context);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'unsupported-update-type',
      updateId: '99',
    });
    expect(calls).toEqual([]);
  });

  test('strips the bot command, binds the thread, and queues a reply', async () => {
    const { context, calls } = makeTelegramContext();
    const res = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      body: JSON.stringify({
        update_id: 42,
        message: {
          message_thread_id: 99,
          chat: { id: 12345, type: 'supergroup', title: 'Team Chat' },
          from: { id: 678, username: 'alice' },
          text: '/goodvibes@goodvibes_bot triage build',
        },
      }),
    }), context);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      queued: true,
      bindingId: 'binding-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
    });
    expect(calls.map((call) => call.kind)).toEqual([
      'authorizeSurfaceIngress',
      'upsertBinding',
      'submitMessage',
      'trySpawnAgent',
      'bindAgent',
      'queueSurfaceReplyFromBinding',
    ]);
    expect(calls[0]?.input).toMatchObject({
      surface: 'telegram',
      userId: '678',
      channelId: '12345',
      threadId: '99',
      conversationKind: 'thread',
      text: 'triage build',
      mentioned: true,
    });
    expect(calls[2]?.input).toMatchObject({ body: 'triage build' });
  });
});

/**
 * `/start` is the first thing Telegram sends when anyone taps "Start" on a bot.
 * It used to fall straight through to the task path, spawning an agent whose
 * task was the literal string "/start". These tests pin the onboarding
 * behaviour: bind the route, answer usefully, dispatch nothing.
 */
describe('telegram adapter — standard bot commands', () => {
  async function sendText(text: string, chatType = 'private', extraDeps: Record<string, unknown> = {}) {
    const harness = makeTelegramContext();
    const sent: Array<{ chatId: string; text: string }> = [];
    const res = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      body: JSON.stringify({
        update_id: 7,
        message: {
          chat: { id: 12345, type: chatType, title: 'Team Chat' },
          from: { id: 678, username: 'alice' },
          text,
        },
      }),
    }), harness.context, {
      sendMessage: async (input) => { sent.push({ chatId: input.chatId, text: input.text }); },
      ...extraDeps,
    });
    return { res, calls: harness.calls, sent };
  }

  test('/start onboards instead of dispatching a task named "/start"', async () => {
    const { res, calls, sent } = await sendText('/start');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      acknowledged: true,
      queued: false,
      outcome: 'command',
      command: 'start',
      bindingId: 'binding-1',
      replied: true,
    });

    // The route is bound, the daemon can now talk back to this chat...
    expect(calls.map((call) => call.kind)).toEqual(['authorizeSurfaceIngress', 'upsertBinding']);
    // ...and crucially, no agent was spawned and no task was submitted.
    expect(calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
    expect(calls.some((call) => call.kind === 'submitMessage')).toBe(false);

    // The user gets something that answers "I pressed Start, now what?"
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe('12345');
    expect(sent[0]?.text).toContain('GoodVibes is connected');
  });

  test('/start carrying a deep-link payload still onboards', async () => {
    const { calls, sent } = await sendText('/start ref_abc123');
    expect(calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
    expect(sent[0]?.text).toContain('GoodVibes is connected');
  });

  test('/start@botname in a group onboards with group addressing guidance', async () => {
    const { calls, sent } = await sendText('/start@goodvibes_bot', 'supergroup');
    expect(calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
    // Assert the guidance's SHAPE, not its prose: a group reader must be told
    // the command prefix and that unaddressed chatter is ignored. Pinning the
    // exact sentence means every copy edit reads as a behaviour regression.
    expect(sent[0]?.text).toContain('/goodvibes');
    expect(sent[0]?.text).toContain('address me directly');
  });

  test('/help and /stop are answered rather than dispatched', async () => {
    const help = await sendText('/help');
    expect(help.calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
    expect(help.sent[0]?.text).toContain('how to talk to me');

    const stop = await sendText('/stop');
    expect(stop.calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
    expect(stop.sent[0]?.text).toContain('cancel <id>');
  });

  test('an unrelated slash command is still real work, not swallowed as onboarding', async () => {
    const { calls } = await sendText('/goodvibes deploy the site');
    expect(calls.some((call) => call.kind === 'trySpawnAgent')).toBe(true);
  });

  test('onboarding still succeeds when no outbound sender is available', async () => {
    // A webhook caller with no resolvable token cannot send; the update must
    // still be acknowledged and bound, and the reply offered inline instead.
    const harness = makeTelegramContext();
    const res = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-secret' },
      body: JSON.stringify({
        update_id: 8,
        message: { chat: { id: 12345, type: 'private' }, from: { id: 1 }, text: '/start' },
      }),
    }), harness.context);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ outcome: 'command', command: 'start', replied: false });
    // Telegram accepts a method call as the webhook response body.
    expect(body.method).toBe('sendMessage');
    expect(String(body.text)).toContain('GoodVibes is connected');
    expect(harness.calls.some((call) => call.kind === 'trySpawnAgent')).toBe(false);
  });
});
