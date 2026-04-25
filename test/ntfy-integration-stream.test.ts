import { describe, expect, test } from 'bun:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_ORIGIN,
  GOODVIBES_NTFY_ORIGIN_HEADER,
  GOODVIBES_NTFY_OUTBOUND_TAG,
  GOODVIBES_NTFY_REMOTE_TOPIC,
  NtfyIntegration,
  createNtfyLiveSubscriptionSince,
  isGoodVibesNtfyDeliveryEcho,
  resolveGoodVibesNtfyTopics,
  type NtfyMessage,
} from '../packages/sdk/src/_internal/platform/integrations/ntfy.js';
import { handleNtfySurfacePayload } from '../packages/sdk/src/_internal/platform/adapters/ntfy/index.js';
import type { SurfaceAdapterContext } from '../packages/sdk/src/_internal/platform/adapters/types.js';
import { ChannelProviderRuntimeManager } from '../packages/sdk/src/_internal/platform/channels/provider-runtime.js';
import { DaemonSurfaceActionHelper } from '../packages/sdk/src/_internal/platform/daemon/surface-actions.js';
import { RuntimeEventBus } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';
import { emitTurnCompleted, emitTurnSubmitted } from '../packages/sdk/src/_internal/platform/runtime/emitters/index.js';

describe('NtfyIntegration.subscribeJsonStream()', () => {
  test('streams newline-delimited JSON with auth and exits cleanly on abort', async () => {
    const messages: NtfyMessage[] = [];
    let requestHeaders: IncomingHttpHeaders = {};
    let resolveMessage!: () => void;
    const receivedMessage = new Promise<void>((resolve) => {
      resolveMessage = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || !req.url?.startsWith('/goodvibes/json')) {
        res.writeHead(404).end();
        return;
      }
      requestHeaders = req.headers;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(JSON.stringify({ event: 'open', topic: 'goodvibes' }) + '\n');
      setTimeout(() => {
        res.write(JSON.stringify({ event: 'message', topic: 'goodvibes', message: 'hello' }) + '\n');
      }, 5);
    });

    try {
      const baseUrl = await listen(server);
      const abort = new AbortController();
      const ntfy = new NtfyIntegration(baseUrl, 'token-1');
      const subscription = ntfy.subscribeJsonStream('goodvibes', (message) => {
        messages.push(message);
        if (message.event === 'message') {
          resolveMessage();
          abort.abort();
        }
      }, {
        signal: abort.signal,
        reconnectDelayMs: 10,
      });

      await withTimeout(receivedMessage, 1_000, 'timed out waiting for ntfy message');
      await withTimeout(subscription, 1_000, 'timed out waiting for ntfy subscription abort');

      expect(requestHeaders.authorization).toBe('Bearer token-1');
      expect(messages.map((message) => message.event)).toEqual(['open', 'message']);
      expect(messages[1]?.message).toBe('hello');
    } finally {
      await close(server);
    }
  });

  test('advances the reconnect cursor and suppresses duplicate cached messages', async () => {
    const messages: NtfyMessage[] = [];
    const requestUrls: string[] = [];
    let requestCount = 0;
    let resolveSecondMessage!: () => void;
    const receivedSecondMessage = new Promise<void>((resolve) => {
      resolveSecondMessage = resolve;
    });
    const firstMessage = { id: 'ntfy-message-1', time: 1_700_000_000, event: 'message', topic: 'goodvibes', message: 'first' };
    const secondMessage = { id: 'ntfy-message-2', time: 1_700_000_001, event: 'message', topic: 'goodvibes', message: 'second' };
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || !req.url?.startsWith('/goodvibes/json')) {
        res.writeHead(404).end();
        return;
      }
      requestUrls.push(req.url);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(JSON.stringify({ event: 'open', topic: 'goodvibes' }) + '\n');
      requestCount++;
      if (requestCount === 1) {
        res.write(JSON.stringify(firstMessage) + '\n');
        res.end();
        return;
      }
      res.write(JSON.stringify(firstMessage) + '\n');
      res.write(JSON.stringify(secondMessage) + '\n');
    });

    try {
      const baseUrl = await listen(server);
      const abort = new AbortController();
      const ntfy = new NtfyIntegration(baseUrl);
      const subscription = ntfy.subscribeJsonStream('goodvibes', (message) => {
        if (message.event !== 'message') return;
        messages.push(message);
        if (message.id === secondMessage.id) {
          resolveSecondMessage();
          abort.abort();
        }
      }, {
        since: '1000',
        signal: abort.signal,
        reconnectDelayMs: 1,
      });

      await withTimeout(receivedSecondMessage, 1_000, 'timed out waiting for reconnect ntfy message');
      await withTimeout(subscription, 1_000, 'timed out waiting for ntfy subscription abort');

      expect(messages.map((message) => message.id)).toEqual([firstMessage.id, secondMessage.id]);
      expect(new URL(requestUrls[0]!, baseUrl).searchParams.get('since')).toBe('1000');
      expect(new URL(requestUrls[1]!, baseUrl).searchParams.get('since')).toBe(firstMessage.id);
    } finally {
      await close(server);
    }
  });

  test('provider runtime starts ntfy from current time instead of replaying the latest cached message', async () => {
    let resolveRequest!: (url: string) => void;
    const receivedRequest = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || !req.url?.includes('/json')) {
        res.writeHead(404).end();
        return;
      }
      resolveRequest(req.url);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(JSON.stringify({ event: 'open', topic: 'goodvibes-chat,goodvibes-agent,goodvibes-ntfy' }) + '\n');
    });

    try {
      const baseUrl = await listen(server);
      const calls = { authorize: 0, submit: 0, spawn: 0 };
      const before = Number(createNtfyLiveSubscriptionSince());
      const manager = new ChannelProviderRuntimeManager({
        configManager: {
          get: (key: string) => {
            if (key === 'surfaces.ntfy.enabled') return true;
            if (key === 'surfaces.ntfy.baseUrl') return baseUrl;
            return '';
          },
        },
        serviceRegistry: { resolveSecret: async () => null },
        buildSurfaceAdapterContext: () => makeRoutingContext({ calls }),
      } as unknown as ConstructorParameters<typeof ChannelProviderRuntimeManager>[0]);

      const result = await manager.start('ntfy');
      expect(result.ok).toBe(true);
      const requestUrl = await withTimeout(receivedRequest, 1_000, 'timed out waiting for ntfy runtime subscription');
      const after = Number(createNtfyLiveSubscriptionSince());
      const since = new URL(requestUrl, baseUrl).searchParams.get('since');
      expect(since).not.toBe('latest');
      expect(Number(since)).toBeGreaterThanOrEqual(before);
      expect(Number(since)).toBeLessThanOrEqual(after);
      manager.stop('ntfy');
    } finally {
      await close(server);
    }
  });
});

describe('ntfy topic routing', () => {
  test('resolves default and configured inbound route topics', () => {
    expect(resolveGoodVibesNtfyTopics()).toMatchObject({
      chatTopic: GOODVIBES_NTFY_CHAT_TOPIC,
      agentTopic: GOODVIBES_NTFY_AGENT_TOPIC,
      remoteTopic: GOODVIBES_NTFY_REMOTE_TOPIC,
    });
    expect(resolveGoodVibesNtfyTopics({
      chatTopic: 'phone-chat',
      agentTopic: 'phone-agent',
      remoteTopic: 'phone-remote',
    })).toEqual({
      chatTopic: 'phone-chat',
      agentTopic: 'phone-agent',
      remoteTopic: 'phone-remote',
      all: ['phone-chat', 'phone-agent', 'phone-remote'],
    });
  });

  test('goodvibes-chat appends to the active TUI session without spawning an agent', async () => {
    const calls = { authorize: 0, submit: 0, spawn: 0 };
    const appended: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
    const published: Array<{ sessionId: string; envelope: Record<string, unknown> }> = [];
    const queuedReplies: Record<string, unknown>[] = [];
    const context = makeRoutingContext({
      calls,
      sessionBroker: {
        findPreferredSession: async () => ({ id: 'tui-session-1' }),
        appendCompanionMessage: async (sessionId: string, input: Record<string, unknown>) => {
          appended.push({ sessionId, input });
          return {};
        },
      },
      publishConversationFollowup: (sessionId: string, envelope: Record<string, unknown>) => {
        published.push({ sessionId, envelope });
      },
      queueNtfyChatReply: (input: Record<string, unknown>) => {
        queuedReplies.push(input);
      },
    });

    const response = await handleNtfySurfacePayload({
      event: 'message',
      topic: GOODVIBES_NTFY_CHAT_TOPIC,
      message: 'hello tui',
      title: 'phone',
    }, context);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.routedTo).toBe('tui-chat');
    expect(body.sessionId).toBe('tui-session-1');
    expect(appended).toHaveLength(1);
    expect(appended[0]?.input).toMatchObject({ body: 'hello tui', source: 'ntfy-chat' });
    expect(published).toHaveLength(1);
    expect(published[0]?.envelope).toMatchObject({ body: 'hello tui', source: 'ntfy-chat' });
    expect(queuedReplies).toHaveLength(1);
    expect(queuedReplies[0]).toMatchObject({
      sessionId: 'tui-session-1',
      topic: GOODVIBES_NTFY_CHAT_TOPIC,
      body: 'hello tui',
      title: 'phone',
    });
    expect(calls).toEqual({ authorize: 1, submit: 0, spawn: 0 });
  });

  test('goodvibes-chat publishes the reply by ntfy message id when turn events use the orchestrator session id', async () => {
    const runtimeBus = new RuntimeEventBus();
    const publishCalls: Array<{ url: string; body: string; headers: IncomingHttpHeaders }> = [];
    let resolvePublish!: () => void;
    const published = new Promise<void>((resolve) => {
      resolvePublish = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/${GOODVIBES_NTFY_CHAT_TOPIC}`) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        publishCalls.push({
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: req.headers,
        });
        resolvePublish();
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      });
    });
    const baseUrl = await listen(server);
    try {
      const helper = new DaemonSurfaceActionHelper({
        serviceRegistry: { resolveSecret: async () => null },
        configManager: {
          get: (key: string) => key === 'surfaces.ntfy.baseUrl' ? baseUrl : '',
        },
        routeBindings: {},
        sessionBroker: {
          findPreferredSession: async () => ({ id: 'shared-tui-session' }),
          appendCompanionMessage: async () => ({}),
        },
        channelPolicy: { evaluateIngress: async () => ({ allowed: true }) },
        controlPlaneGateway: { publishEvent: () => {} },
        runtimeBus,
        companionChatManager: null,
        automationManager: {},
        agentManager: {},
        trySpawnAgent: () => ({ id: 'agent-1', status: 'running', task: '', tools: [], startedAt: Date.now() }),
        queueSurfaceReplyFromBinding: () => {},
        queueWebhookReply: () => {},
        surfaceDeliveryEnabled: () => true,
        signWebhookPayload: () => '',
        handleApprovalAction: async () => Response.json({ ok: true }),
      } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
      const response = await handleNtfySurfacePayload({
        event: 'message',
        topic: GOODVIBES_NTFY_CHAT_TOPIC,
        message: 'hi',
        title: 'phone',
      }, helper.buildSurfaceAdapterContext());

      expect(response.status).toBe(202);
      const routed = await response.json() as { messageId: string };
      emitTurnSubmitted(
        runtimeBus,
        { sessionId: 'orchestrator-private-session', traceId: 'turn-1', source: 'test' },
        {
          turnId: 'turn-1',
          prompt: 'different text is still correlated by origin id',
          origin: {
            source: 'ntfy-chat',
            surface: 'ntfy',
            topic: GOODVIBES_NTFY_CHAT_TOPIC,
            messageId: routed.messageId,
          },
        },
      );
      emitTurnCompleted(
        runtimeBus,
        { sessionId: 'orchestrator-private-session', traceId: 'turn-1', source: 'test' },
        { turnId: 'turn-1', response: 'hello from model', stopReason: 'completed' },
      );

      await withTimeout(published, 1_000, 'timed out waiting for ntfy chat reply publish');
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0]).toMatchObject({
        url: `/${GOODVIBES_NTFY_CHAT_TOPIC}`,
        body: 'hello from model',
      });
      expect(publishCalls[0]?.headers['x-goodvibes-origin']).toBe(GOODVIBES_NTFY_ORIGIN);
    } finally {
      await close(server);
    }
  });

  test('goodvibes-chat keeps a prompt fallback for clients that have not forwarded origin metadata yet', async () => {
    const runtimeBus = new RuntimeEventBus();
    const publishCalls: Array<{ url: string; body: string; headers: IncomingHttpHeaders }> = [];
    let resolvePublish!: () => void;
    const published = new Promise<void>((resolve) => {
      resolvePublish = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/${GOODVIBES_NTFY_CHAT_TOPIC}`) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        publishCalls.push({
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: req.headers,
        });
        resolvePublish();
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      });
    });
    const baseUrl = await listen(server);
    try {
      const helper = new DaemonSurfaceActionHelper({
        serviceRegistry: { resolveSecret: async () => null },
        configManager: {
          get: (key: string) => key === 'surfaces.ntfy.baseUrl' ? baseUrl : '',
        },
        routeBindings: {},
        sessionBroker: {
          findPreferredSession: async () => ({ id: 'shared-tui-session' }),
          appendCompanionMessage: async () => ({}),
        },
        channelPolicy: { evaluateIngress: async () => ({ allowed: true }) },
        controlPlaneGateway: { publishEvent: () => {} },
        runtimeBus,
        companionChatManager: null,
        automationManager: {},
        agentManager: {},
        trySpawnAgent: () => ({ id: 'agent-1', status: 'running', task: '', tools: [], startedAt: Date.now() }),
        queueSurfaceReplyFromBinding: () => {},
        queueWebhookReply: () => {},
        surfaceDeliveryEnabled: () => true,
        signWebhookPayload: () => '',
        handleApprovalAction: async () => Response.json({ ok: true }),
      } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
      const response = await handleNtfySurfacePayload({
        event: 'message',
        topic: GOODVIBES_NTFY_CHAT_TOPIC,
        message: 'hi',
        title: 'phone',
      }, helper.buildSurfaceAdapterContext());

      expect(response.status).toBe(202);
      emitTurnSubmitted(
        runtimeBus,
        { sessionId: 'orchestrator-private-session', traceId: 'turn-1', source: 'test' },
        { turnId: 'turn-1', prompt: 'hi' },
      );
      emitTurnCompleted(
        runtimeBus,
        { sessionId: 'orchestrator-private-session', traceId: 'turn-1', source: 'test' },
        { turnId: 'turn-1', response: 'hello from fallback', stopReason: 'completed' },
      );

      await withTimeout(published, 1_000, 'timed out waiting for ntfy chat reply publish');
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0]).toMatchObject({
        url: `/${GOODVIBES_NTFY_CHAT_TOPIC}`,
        body: 'hello from fallback',
      });
      expect(publishCalls[0]?.headers['x-goodvibes-origin']).toBe(GOODVIBES_NTFY_ORIGIN);
    } finally {
      await close(server);
    }
  });

  test('configured chat topic overrides the default ntfy chat topic', async () => {
    const calls = { authorize: 0, submit: 0, spawn: 0 };
    const appended: Array<{ sessionId: string; input: Record<string, unknown> }> = [];
    const context = makeRoutingContext({
      calls,
      configValues: {
        'surfaces.ntfy.chatTopic': 'phone-chat',
        'surfaces.ntfy.agentTopic': 'phone-agent',
        'surfaces.ntfy.remoteTopic': 'phone-remote',
      },
      sessionBroker: {
        findPreferredSession: async () => ({ id: 'tui-session-1' }),
        appendCompanionMessage: async (sessionId: string, input: Record<string, unknown>) => {
          appended.push({ sessionId, input });
          return {};
        },
      },
      publishConversationFollowup: () => {},
    });

    const routed = await handleNtfySurfacePayload({
      event: 'message',
      topic: 'phone-chat',
      message: 'custom chat',
    }, context);
    const ignored = await handleNtfySurfacePayload({
      event: 'message',
      topic: GOODVIBES_NTFY_CHAT_TOPIC,
      message: 'default chat',
    }, context);

    expect(routed.status).toBe(202);
    expect(await routed.json()).toMatchObject({ routedTo: 'tui-chat', topic: 'phone-chat' });
    expect(await ignored.json()).toMatchObject({
      acknowledged: true,
      queued: false,
      ignored: 'unknown-ntfy-topic',
      topic: GOODVIBES_NTFY_CHAT_TOPIC,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.input).toMatchObject({ body: 'custom chat', source: 'ntfy-chat' });
    expect(calls).toEqual({ authorize: 1, submit: 0, spawn: 0 });
  });

  test('unknown ntfy topics are ignored instead of spawning WRFC work', async () => {
    const calls = { authorize: 0, submit: 0, spawn: 0 };
    const context = makeRoutingContext({ calls });

    const response = await handleNtfySurfacePayload({
      event: 'message',
      topic: 'personal-topic',
      message: 'do not spawn',
    }, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      acknowledged: true,
      queued: false,
      ignored: 'unknown-ntfy-topic',
      topic: 'personal-topic',
    });
    expect(calls).toEqual({ authorize: 0, submit: 0, spawn: 0 });
  });

  test('goodvibes-ntfy routes to daemon remote chat without touching the TUI session', async () => {
    const calls = { authorize: 0, submit: 0, spawn: 0 };
    const remoteCalls: Record<string, unknown>[] = [];
    const context = makeRoutingContext({
      calls,
      postNtfyRemoteChatMessage: async (input: Record<string, unknown>) => {
        remoteCalls.push(input);
        return { sessionId: 'remote-1', messageId: 'message-1', delivered: true };
      },
    });

    const response = await handleNtfySurfacePayload({
      event: 'message',
      topic: GOODVIBES_NTFY_REMOTE_TOPIC,
      message: 'remote only',
    }, context);
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      routedTo: 'ntfy-remote-chat',
      sessionId: 'remote-1',
      messageId: 'message-1',
      topic: GOODVIBES_NTFY_REMOTE_TOPIC,
    });
    expect(remoteCalls).toEqual([{ topic: GOODVIBES_NTFY_REMOTE_TOPIC, body: 'remote only', title: 'GoodVibes ntfy' }]);
    expect(calls).toEqual({ authorize: 1, submit: 0, spawn: 0 });
  });

  test('goodvibes-agent submits agent work through the active TUI session when one is available', async () => {
    const calls = { authorize: 0, submit: 0, spawn: 0 };
    const submissions: Record<string, unknown>[] = [];
    const spawnInputs: Array<{ input: Record<string, unknown>; sessionId?: string }> = [];
    const queuedReplies: Array<{ binding: unknown; input: Record<string, unknown> }> = [];
    const context = makeRoutingContext({
      calls,
      sessionBroker: {
        findPreferredSession: async () => ({ id: 'tui-session-1' }),
        submitMessage: async (input: Record<string, unknown>) => {
          calls.submit++;
          submissions.push(input);
          return {
            mode: 'spawn',
            session: { id: input.sessionId },
            task: 'agent task',
            routeBinding: { id: 'route-1', surfaceId: 'ntfy', channelId: GOODVIBES_NTFY_AGENT_TOPIC, externalId: GOODVIBES_NTFY_AGENT_TOPIC },
          };
        },
        bindAgent: async () => {},
      },
      trySpawnAgent: (input: Record<string, unknown>, _logLabel: string, sessionId?: string) => {
        calls.spawn++;
        spawnInputs.push({ input, sessionId });
        return { id: 'agent-1' };
      },
      queueSurfaceReplyFromBinding: (binding: unknown, input: Record<string, unknown>) => {
        queuedReplies.push({ binding, input });
      },
    });

    const response = await handleNtfySurfacePayload({
      event: 'message',
      topic: GOODVIBES_NTFY_AGENT_TOPIC,
      message: 'run agent',
    }, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      acknowledged: true,
      queued: true,
      topic: GOODVIBES_NTFY_AGENT_TOPIC,
      sessionId: 'tui-session-1',
      agentId: 'agent-1',
    });
    expect(submissions[0]).toMatchObject({ sessionId: 'tui-session-1', body: 'run agent' });
    expect(spawnInputs).toEqual([{ input: { mode: 'spawn', task: 'agent task' }, sessionId: 'tui-session-1' }]);
    expect(queuedReplies[0]?.input).toMatchObject({ agentId: 'agent-1', task: 'run agent', sessionId: 'tui-session-1' });
    expect(calls).toEqual({ authorize: 1, submit: 1, spawn: 1 });
  });
});

describe('ntfy GoodVibes self-echo marker', () => {
  test('publish adds the SDK-owned marker header and tag', async () => {
    let requestHeaders: IncomingHttpHeaders = {};
    const server = createServer((req, res) => {
      requestHeaders = req.headers;
      req.resume();
      req.on('end', () => {
        res.writeHead(200).end();
      });
    });

    try {
      const baseUrl = await listen(server);
      const ntfy = new NtfyIntegration(baseUrl);
      await ntfy.publish('goodvibes', 'outbound', {
        tags: ['agent'],
        markGoodVibesOrigin: true,
      });

      expect(requestHeaders[GOODVIBES_NTFY_ORIGIN_HEADER.toLowerCase()]).toBe(GOODVIBES_NTFY_ORIGIN);
      expect(String(requestHeaders.tags)).toContain('agent');
      expect(String(requestHeaders.tags)).toContain(GOODVIBES_NTFY_OUTBOUND_TAG);
    } finally {
      await close(server);
    }
  });

  test('inbound adapter ignores only explicitly marked GoodVibes ntfy deliveries', async () => {
    const calls = { authorize: 0, upsert: 0, submit: 0, spawn: 0, queue: 0 };
    const context = makeSurfaceAdapterContext(calls);
    const response = await handleNtfySurfacePayload({
      event: 'message',
      topic: 'goodvibes',
      message: 'outbound',
      tags: [GOODVIBES_NTFY_OUTBOUND_TAG],
    }, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      acknowledged: true,
      queued: false,
      ignored: 'goodvibes-self-echo',
    });
    expect(calls).toEqual({ authorize: 0, upsert: 0, submit: 0, spawn: 0, queue: 0 });
    expect(isGoodVibesNtfyDeliveryEcho({
      event: 'message',
      topic: 'goodvibes',
      message: 'legacy-looking outbound',
      replyTargetId: 'reply-1',
      click: 'https://example.test/api/control-plane/web',
    })).toBe(false);
  });
});

function makeSurfaceAdapterContext(calls: { authorize: number; upsert: number; submit: number; spawn: number; queue: number }): SurfaceAdapterContext {
  return {
    serviceRegistry: {
      resolveSecret: async () => null,
    },
    configManager: {
      get: () => undefined,
    },
    routeBindings: {
      upsertBinding: async () => {
        calls.upsert++;
        return { id: 'route-1', surfaceId: 'ntfy', channelId: 'goodvibes', externalId: 'goodvibes' };
      },
    },
    sessionBroker: {
      submitMessage: async () => {
        calls.submit++;
        return {
          mode: 'spawn',
          session: { id: 'session-1' },
          task: { id: 'task-1' },
          routeBinding: { id: 'route-1', surfaceId: 'ntfy', channelId: 'goodvibes', externalId: 'goodvibes' },
        };
      },
      bindAgent: async () => {},
    },
    authorizeSurfaceIngress: async () => {
      calls.authorize++;
      return { allowed: true };
    },
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => '',
    performInteractiveSurfaceAction: async () => '',
    trySpawnAgent: () => {
      calls.spawn++;
      return { id: 'agent-1' };
    },
    queueSurfaceReplyFromBinding: () => {
      calls.queue++;
    },
  } as unknown as SurfaceAdapterContext;
}

function makeRoutingContext(options: {
  calls: { authorize: number; submit: number; spawn: number };
  configValues?: Record<string, unknown>;
  sessionBroker?: Record<string, unknown>;
  publishConversationFollowup?: (sessionId: string, envelope: Record<string, unknown>) => void;
  queueNtfyChatReply?: (input: Record<string, unknown>) => void;
  postNtfyRemoteChatMessage?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  trySpawnAgent?: (input: Record<string, unknown>, logLabel: string, sessionId?: string) => { id: string } | Response;
  queueSurfaceReplyFromBinding?: (binding: unknown, input: Record<string, unknown>) => void;
}): SurfaceAdapterContext {
  return {
    serviceRegistry: {
      resolveSecret: async () => null,
    },
    configManager: {
      get: (key: string) => options.configValues?.[key],
    },
    routeBindings: {
      upsertBinding: async () => ({
        id: 'route-1',
        surfaceId: 'ntfy',
        channelId: GOODVIBES_NTFY_AGENT_TOPIC,
        externalId: GOODVIBES_NTFY_AGENT_TOPIC,
      }),
    },
    sessionBroker: {
      findPreferredSession: async () => null,
      appendCompanionMessage: async () => ({}),
      submitMessage: async () => {
        options.calls.submit++;
        return {
          mode: 'spawn',
          session: { id: 'session-1' },
          task: 'agent task',
          routeBinding: { id: 'route-1', surfaceId: 'ntfy', channelId: GOODVIBES_NTFY_AGENT_TOPIC, externalId: GOODVIBES_NTFY_AGENT_TOPIC },
        };
      },
      bindAgent: async () => {},
      ...(options.sessionBroker ?? {}),
    },
    authorizeSurfaceIngress: async () => {
      options.calls.authorize++;
      return { allowed: true };
    },
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => '',
    performInteractiveSurfaceAction: async () => '',
    trySpawnAgent: options.trySpawnAgent ?? (() => {
      options.calls.spawn++;
      return { id: 'agent-1' };
    }),
    queueSurfaceReplyFromBinding: options.queueSurfaceReplyFromBinding ?? (() => {}),
    ...(options.publishConversationFollowup ? { publishConversationFollowup: options.publishConversationFollowup } : {}),
    ...(options.queueNtfyChatReply ? { queueNtfyChatReply: options.queueNtfyChatReply } : {}),
    ...(options.postNtfyRemoteChatMessage ? { postNtfyRemoteChatMessage: options.postNtfyRemoteChatMessage } : {}),
  } as unknown as SurfaceAdapterContext;
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
