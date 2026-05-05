/**
 * Adapter behavioral coverage — WhatsApp adapter.
 */
import { describe, expect, test } from 'bun:test';
import { handleWhatsAppSurfaceWebhook } from '../packages/sdk/src/platform/adapters/whatsapp/index.js';

function makeWhatsAppContext(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const binding = {
    id: 'binding-1',
    kind: 'channel',
    surfaceKind: 'whatsapp',
    surfaceId: 'phone-number-1',
    externalId: '15551234567',
    channelId: '15551234567',
    title: 'Alice',
    metadata: {},
  };
  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: {
        get: (key: string) => {
          if (key === 'surfaces.whatsapp.provider') return 'bridge';
          if (key === 'surfaces.whatsapp.verifyToken') return 'verify-token';
          if (key === 'surfaces.whatsapp.signingSecret') return 'whatsapp-token';
          if (key === 'surfaces.whatsapp.phoneNumberId') return 'phone-number-1';
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
            task: { prompt: 'hello whatsapp' },
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

describe('whatsapp adapter — contract surface', () => {
  test('returns the configured Meta verification challenge', async () => {
    const { context } = makeWhatsAppContext();
    const res = await handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-1'), context);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('challenge-1');
  });

  test('acknowledges non-message webhook payloads with an explicit ignored outcome', async () => {
    const { context, calls } = makeWhatsAppContext();
    const res = await handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
      method: 'POST',
      headers: { 'x-goodvibes-whatsapp-token': 'whatsapp-token' },
      body: JSON.stringify({
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: 'phone-number-1' },
              statuses: [{ id: 'wamid.1', status: 'delivered' }],
            },
          }],
        }],
      }),
    }), context);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      acknowledged: true,
      queued: false,
      outcome: 'ignored',
      reason: 'no-message-event',
    });
    expect(calls).toEqual([]);
  });

  test('routes valid WhatsApp bridge messages and queues a reply', async () => {
    const { context, calls } = makeWhatsAppContext();
    const res = await handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
      method: 'POST',
      headers: { 'x-goodvibes-whatsapp-token': 'whatsapp-token' },
      body: JSON.stringify({
        entry: [{
          changes: [{
            value: {
              metadata: { phone_number_id: 'phone-number-1' },
              contacts: [{ profile: { name: 'Alice' } }],
              messages: [{
                id: 'wamid.1',
                from: '15551234567',
                text: { body: 'hello whatsapp' },
              }],
            },
          }],
        }],
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
      surface: 'whatsapp',
      userId: '15551234567',
      channelId: '15551234567',
      conversationKind: 'direct',
      text: 'hello whatsapp',
      mentioned: true,
    });
  });
});
