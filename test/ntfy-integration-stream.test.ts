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
  isGoodVibesNtfyDeliveryEcho,
  type NtfyMessage,
} from '../packages/sdk/src/_internal/platform/integrations/ntfy.js';
import { handleNtfySurfacePayload } from '../packages/sdk/src/_internal/platform/adapters/ntfy/index.js';
import type { SurfaceAdapterContext } from '../packages/sdk/src/_internal/platform/adapters/types.js';

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
});

describe('ntfy topic routing', () => {
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
      get: () => undefined,
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
