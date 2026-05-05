/**
 * Adapter behavioral coverage — Matrix adapter.
 */
import { describe, expect, test } from 'bun:test';
import { handleMatrixSurfaceWebhook } from '../packages/sdk/src/platform/adapters/matrix/index.js';

function makeMatrixContext(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const binding = {
    id: 'binding-1',
    kind: 'channel',
    surfaceKind: 'matrix',
    surfaceId: '@goodvibes:example.org',
    externalId: '!room:example.org',
    channelId: '!room:example.org',
    title: '!room:example.org',
    metadata: {},
  };
  return {
    calls,
    context: {
      serviceRegistry: { resolveSecret: async () => null },
      configManager: {
        get: (key: string) => {
          if (key === 'surfaces.matrix.accessToken') return 'matrix-token';
          if (key === 'surfaces.matrix.userId') return '@goodvibes:example.org';
          if (key === 'surfaces.matrix.homeserverUrl') return 'https://matrix.example.org';
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
            task: { prompt: 'hello matrix' },
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

describe('matrix adapter — contract surface', () => {
  test('rejects requests with a mismatched matrix token', async () => {
    const { context } = makeMatrixContext();
    const res = await handleMatrixSurfaceWebhook(new Request('http://localhost/matrix', {
      method: 'POST',
      headers: { 'x-goodvibes-matrix-token': 'wrong-token' },
      body: JSON.stringify({ event: { room_id: '!room:example.org', content: { body: 'hello' } } }),
    }), context);
    expect(res.status).toBe(401);
  });

  test('routes a valid room message into a session and queues a reply', async () => {
    const { context, calls } = makeMatrixContext();
    const res = await handleMatrixSurfaceWebhook(new Request('http://localhost/matrix', {
      method: 'POST',
      headers: { 'x-goodvibes-matrix-token': 'matrix-token' },
      body: JSON.stringify({
        event: {
          room_id: '!room:example.org',
          sender: '@alice:example.org',
          event_id: '$event',
          content: {
            msgtype: 'm.text',
            body: 'hello matrix',
            'm.relates_to': { event_id: '$thread' },
          },
        },
      }),
    }), context);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['queued']).toBe(true);
    expect(calls.map((call) => call.kind)).toEqual([
      'authorizeSurfaceIngress',
      'upsertBinding',
      'submitMessage',
      'trySpawnAgent',
      'bindAgent',
      'queueSurfaceReplyFromBinding',
    ]);
    expect(calls[0]?.input).toMatchObject({
      surface: 'matrix',
      channelId: '!room:example.org',
      threadId: '$thread',
      text: 'hello matrix',
      mentioned: true,
    });
  });
});
