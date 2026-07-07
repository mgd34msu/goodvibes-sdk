import { describe, expect, test } from 'bun:test';
import type { AutomationRouteBinding } from '../packages/sdk/src/platform/automation/routes.js';
import { HomeAssistantConversationRoutes } from '../packages/sdk/src/platform/daemon/http/homeassistant-routes.js';
import {
  CompanionChatManager,
  type CompanionLLMProvider,
  type CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type { CompanionChatTurnEvent } from '../packages/sdk/src/platform/companion/companion-chat-types.js';

function parseSseFrames(body: string): Array<{ readonly event: string; readonly data: Record<string, unknown> }> {
  return body
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
    });
}

function buildStreamingRoutes(
  postMessageAndWaitForReply: (
    sessionId: string,
    content: string,
    clientId: string,
    options: { readonly onTurnEvent?: (event: CompanionChatTurnEvent) => void },
  ) => Promise<{ messageId: string; assistantMessageId?: string; response?: string; error?: string }>,
): HomeAssistantConversationRoutes {
  const sessions = new Map<string, Record<string, unknown>>();
  const chatManager = {
    init: async () => undefined,
    getSession: (id: string) => sessions.get(id) ?? null,
    createSession: (input: Record<string, unknown>) => {
      const session = { id: 'ha-stream-session', status: 'active', title: String(input.title), updatedAt: Date.now() };
      sessions.set(session.id, session);
      return session;
    },
    updateSession: (id: string, input: Record<string, unknown>) => {
      const session = { ...(sessions.get(id) ?? {}), ...input, updatedAt: Date.now() };
      sessions.set(id, session);
      return session;
    },
    postMessageAndWaitForReply,
    postMessage: async () => 'user-msg-1',
    closeSession: () => null,
  };
  return new HomeAssistantConversationRoutes({
    configManager: {
      get(key: string): unknown {
        return ({
          'surfaces.homeassistant.enabled': true,
          'surfaces.homeassistant.defaultConversationId': 'goodvibes',
          'surfaces.homeassistant.remoteSessionTtlMs': 20 * 60_000,
        } as Record<string, unknown>)[key];
      },
    },
    routeBindings: {
      start: async () => undefined,
      upsertBinding: async (input: Partial<AutomationRouteBinding>) => ({
        id: 'route-ha-stream',
        kind: 'channel',
        surfaceKind: 'homeassistant',
        surfaceId: String(input.surfaceId),
        externalId: String(input.externalId),
        channelId: String(input.channelId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
        metadata: input.metadata ?? {},
      } as AutomationRouteBinding),
      patchBinding: async () => null,
    },
    chatManager,
    parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
    resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
  } as ConstructorParameters<typeof HomeAssistantConversationRoutes>[0]);
}

function makeRoutesForCancel(hooks: {
  cancelTurn: (sessionId: string) => Promise<{ sessionId: string; turnId: string; cancelled: true; partialPersisted: boolean }>;
  closeSession: (sessionId: string) => null;
}): HomeAssistantConversationRoutes {
  const chatManager = {
    init: async () => undefined,
    getSession: (id: string) => ({ id, status: 'active', title: 'HA chat', updatedAt: Date.now() }),
    createSession: () => ({ id: 'unused', status: 'active', title: 'unused', updatedAt: Date.now() }),
    updateSession: (id: string) => ({ id, status: 'active', updatedAt: Date.now() }),
    postMessageAndWaitForReply: async () => ({ messageId: 'unused' }),
    postMessage: async () => 'unused',
    cancelTurn: hooks.cancelTurn,
    closeSession: hooks.closeSession,
  };
  return new HomeAssistantConversationRoutes({
    configManager: {
      get(key: string): unknown {
        return ({
          'surfaces.homeassistant.enabled': true,
          'surfaces.homeassistant.defaultConversationId': 'goodvibes',
          'surfaces.homeassistant.remoteSessionTtlMs': 20 * 60_000,
        } as Record<string, unknown>)[key];
      },
    },
    routeBindings: {
      start: async () => undefined,
      upsertBinding: async (input: Partial<AutomationRouteBinding>) => ({
        id: 'route-ha-cancel',
        kind: 'channel',
        surfaceKind: 'homeassistant',
        surfaceId: String(input.surfaceId),
        externalId: String(input.externalId),
        channelId: String(input.channelId),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
        metadata: input.metadata ?? {},
      } as AutomationRouteBinding),
      patchBinding: async () => null,
    },
    chatManager,
    parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
    resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
  } as ConstructorParameters<typeof HomeAssistantConversationRoutes>[0]);
}

describe('Home Assistant conversation stream deltas', () => {
  test('emits incremental delta frames as the model streams, then one terminal final frame', async () => {
    const routes = buildStreamingRoutes(async (sessionId, _content, _clientId, options) => {
      // The platform's turn machinery fires turn.delta events as the model streams;
      // the route bridges them into SSE delta frames.
      options.onTurnEvent?.({ type: 'turn.delta', sessionId, turnId: 't1', delta: 'The lights ' });
      options.onTurnEvent?.({ type: 'turn.delta', sessionId, turnId: 't1', delta: 'are ' });
      options.onTurnEvent?.({ type: 'turn.delta', sessionId, turnId: 't1', delta: 'on.' });
      return { messageId: 'user-msg-1', assistantMessageId: 'assistant-1', response: 'The lights are on.' };
    });

    const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'are the lights on?', conversationId: 'assist-home', messageId: 'ha-msg-1' }),
    }));
    expect(response!.headers.get('Content-Type')).toContain('text/event-stream');

    const frames = parseSseFrames(await response!.text());
    const deltaFrames = frames.filter((frame) => frame.event === 'delta');
    const terminalFrames = frames.filter((frame) => frame.event === 'final' || frame.event === 'error');

    // Incremental deltas arrived in order, each carrying the running accumulation.
    expect(deltaFrames.map((frame) => frame.data.delta)).toEqual(['The lights ', 'are ', 'on.']);
    expect(deltaFrames.at(-1)?.data.text).toBe('The lights are on.');
    expect(deltaFrames.every((frame) => frame.data.conversationId === 'assist-home')).toBe(true);

    // Exactly one terminal frame, preserving the pre-existing contract.
    expect(terminalFrames).toHaveLength(1);
    expect(terminalFrames[0]?.event).toBe('final');
    expect(terminalFrames[0]?.data.status).toBe('completed');
    expect((terminalFrames[0]?.data.assistant as Record<string, unknown>).text).toBe('The lights are on.');
    // The terminal frame is last.
    expect(frames.at(-1)?.event).toBe('final');
  });

  test('a turn that fails still ends with exactly one terminal error frame', async () => {
    const routes = buildStreamingRoutes(async (sessionId, _content, _clientId, options) => {
      options.onTurnEvent?.({ type: 'turn.delta', sessionId, turnId: 't2', delta: 'partial' });
      return { messageId: 'user-msg-1', error: 'model exploded' };
    });

    const response = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'hi', conversationId: 'assist-home' }),
    }));
    const frames = parseSseFrames(await response!.text());
    expect(frames.filter((frame) => frame.event === 'delta')).toHaveLength(1);
    const terminal = frames.filter((frame) => frame.event === 'final' || frame.event === 'error');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.event).toBe('error');
    expect(terminal[0]?.data.status).toBe('failed');
  });

  test('the chat manager forwards real turn.delta events to an onTurnEvent listener', async () => {
    const provider: CompanionLLMProvider = {
      // eslint-disable-next-line require-yield
      chatStream: async function* (): AsyncIterable<CompanionProviderChunk> {
        yield { type: 'text_delta', delta: 'Hello ' };
        yield { type: 'text_delta', delta: 'world' };
        yield { type: 'done' };
      },
    };
    const manager = new CompanionChatManager({
      provider,
      eventPublisher: { publishEvent: () => undefined },
      persist: false,
    });
    try {
      await manager.init();
      const session = manager.createSession({ title: 'stream test' });
      const events: CompanionChatTurnEvent[] = [];
      const reply = await manager.postMessageAndWaitForReply(session.id, 'hi', 'client-1', {
        timeoutMs: 5_000,
        onTurnEvent: (event) => events.push(event),
      });

      const deltas = events.filter((event) => event.type === 'turn.delta');
      expect(deltas.map((event) => (event as { delta: string }).delta)).toEqual(['Hello ', 'world']);
      expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
      expect(reply.response).toBe('Hello world');
    } finally {
      manager.dispose();
    }
  });
});

describe('conversation cancel keeps the session (turns.cancel, not close)', () => {
  test('cancel stops the turn, the session stays open, and nothing-running is a success', async () => {
    const cancelCalls: string[] = [];
    const closeCalls: string[] = [];
    const routes = makeRoutesForCancel({
      cancelTurn: async (sessionId: string) => {
        cancelCalls.push(sessionId);
        return { sessionId, turnId: 't1', cancelled: true as const, partialPersisted: true };
      },
      closeSession: (sessionId: string) => {
        closeCalls.push(sessionId);
        return null;
      },
    });

    const res = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ha-live-session' }),
    }));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('cancelled');
    // The precise verb ran; the session-closing hammer did NOT.
    expect(cancelCalls).toEqual(['ha-live-session']);
    expect(closeCalls).toEqual([]);
  });

  test('cancel with no turn in flight is still ok:true (the stop intent is already true)', async () => {
    const routes = makeRoutesForCancel({
      cancelTurn: async () => {
        throw Object.assign(new Error('No turn is in flight'), { code: 'NO_ACTIVE_TURN', status: 404 });
      },
      closeSession: () => null,
    });
    const res = await routes.handle(new Request('http://daemon.local/api/homeassistant/conversation/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'ha-live-session' }),
    }));
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('cancelled');
  });
});
