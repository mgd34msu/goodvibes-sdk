/**
 * Adapter behavioral coverage — Signal adapter.
 */
import { describe, expect, test } from 'bun:test';
import { handleSignalSurfaceWebhook } from '../packages/sdk/src/platform/adapters/signal/index.js';

function makeSignalContext(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const binding = {
    id: 'binding-1',
    kind: 'thread',
    surfaceKind: 'signal',
    surfaceId: 'signal-account',
    externalId: 'thread-1',
    channelId: '+15551234567',
    threadId: 'thread-1',
    title: '+15551234567',
    metadata: {},
  };
  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: {
        get: (key: string) => {
          if (key === 'surfaces.signal.token') return 'signal-token';
          if (key === 'surfaces.signal.account') return 'signal-account';
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
            task: { prompt: 'hello signal' },
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

describe('signal adapter — contract surface', () => {
  test('rejects requests with a mismatched Signal token', async () => {
    const { context } = makeSignalContext();
    const res = await handleSignalSurfaceWebhook(new Request('http://localhost/signal', {
      method: 'POST',
      headers: { 'x-goodvibes-signal-token': 'wrong-token' },
      body: JSON.stringify({ recipient: '+15551234567', message: 'hello signal' }),
    }), context);
    expect(res.status).toBe(401);
  });

  test('routes valid Signal messages into a threaded session and queues a reply', async () => {
    const { context, calls } = makeSignalContext();
    const res = await handleSignalSurfaceWebhook(new Request('http://localhost/signal', {
      method: 'POST',
      headers: { Authorization: 'Bearer signal-token' },
      body: JSON.stringify({
        recipient: '+15551234567',
        threadId: 'thread-1',
        message: 'hello signal',
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
      surface: 'signal',
      userId: '+15551234567',
      channelId: '+15551234567',
      threadId: 'thread-1',
      conversationKind: 'thread',
      text: 'hello signal',
    });
  });
});
