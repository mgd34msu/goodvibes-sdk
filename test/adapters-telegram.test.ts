/**
 * Adapter behavioral coverage — Telegram adapter.
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
