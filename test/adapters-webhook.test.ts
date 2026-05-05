/**
 * Adapter behavioral coverage — Webhook adapter.
 */
import { describe, expect, test } from 'bun:test';
import { handleGenericWebhookSurface } from '../packages/sdk/src/platform/adapters/webhook/index.js';

function makeWebhookContext(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const binding = {
    id: 'binding-1',
    kind: 'message',
    surfaceKind: 'webhook',
    surfaceId: 'webhook',
    externalId: 'webhook',
    title: 'webhook',
    metadata: {},
  };
  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: {
        get: (key: string) => {
          if (key === 'surfaces.webhook.enabled') return true;
          if (key === 'surfaces.webhook.secret') return 'webhook-secret';
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
            task: { prompt: 'hello webhook' },
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
      signWebhookPayload: (body: string, secret: string) => `signed:${secret}:${body.length}`,
      surfaceDeliveryEnabled: () => true,
      queueWebhookReply: (input: unknown) => {
        calls.push({ kind: 'queueWebhookReply', input });
      },
      parseSurfaceControlCommand: () => null,
      performSurfaceControlCommand: async () => 'ok',
      performInteractiveSurfaceAction: async () => 'ok',
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return { id: 'agent-1' };
      },
      queueSurfaceReplyFromBinding: () => undefined,
      ...overrides,
    } as never,
  };
}

describe('webhook adapter — contract surface', () => {
  test('rejects requests without a valid shared secret or signature', async () => {
    const { context } = makeWebhookContext();
    const res = await handleGenericWebhookSurface(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello webhook' }),
    }), context);
    expect(res.status).toBe(401);
  });

  test('routes valid webhook messages and queues callback delivery', async () => {
    const { context, calls } = makeWebhookContext();
    const res = await handleGenericWebhookSurface(new Request('http://localhost/webhook?externalId=route-id', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goodvibes-webhook-secret': 'webhook-secret',
        'x-goodvibes-correlation-id': 'corr-1',
      },
      body: JSON.stringify({
        message: 'hello webhook',
        channelId: 'channel-1',
        callbackUrl: 'https://callback.example.com/reply',
      }),
    }), context);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      acknowledged: true,
      queued: true,
      bindingId: 'binding-1',
      sessionId: 'session-1',
      agentId: 'agent-1',
      callbackUrl: 'https://callback.example.com/reply',
      correlationId: 'corr-1',
    });
    expect(calls.map((call) => call.kind)).toEqual([
      'authorizeSurfaceIngress',
      'upsertBinding',
      'submitMessage',
      'trySpawnAgent',
      'bindAgent',
      'queueWebhookReply',
    ]);
    expect(calls[0]?.input).toMatchObject({
      surface: 'webhook',
      channelId: 'channel-1',
      conversationKind: 'channel',
      text: 'hello webhook',
      mentioned: true,
    });
  });

  test('reports skipped callback delivery when webhook egress is disabled', async () => {
    const { context, calls } = makeWebhookContext({
      surfaceDeliveryEnabled: () => false,
    });
    const res = await handleGenericWebhookSurface(new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goodvibes-webhook-secret': 'webhook-secret',
      },
      body: JSON.stringify({
        message: 'hello webhook',
        callbackUrl: 'https://callback.example.com/reply',
      }),
    }), context);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      acknowledged: true,
      queued: true,
      callbackDelivery: {
        status: 'skipped',
        reason: 'webhook-delivery-disabled',
      },
    });
    expect(calls.map((call) => call.kind)).not.toContain('queueWebhookReply');
  });
});
