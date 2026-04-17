import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_EVENT_DOMAINS,
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  forSession,
} from '../packages/sdk/dist/index.js';

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

function createSseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

function createOpenSseResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel() {},
  }), {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

describe('transport realtime', () => {
  test('creates generic remote domain feeds', async () => {
    let cleanupCalls = 0;
    let resolveConnect: ((cleanup: () => void) => void) | null = null;

    const events = createRemoteDomainEvents(['alpha', 'beta'] as const, async () => {
      const cleanup = await new Promise<() => void>((resolve) => {
        resolveConnect = resolve;
      });
      return cleanup;
    });

    const unsubscribe = events.alpha.on('ALPHA_READY', () => {});
    unsubscribe();

    expect(resolveConnect).not.toBeNull();
    resolveConnect!(() => {
      cleanupCalls += 1;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(cleanupCalls).toBe(1);
    expect(events.domains).toEqual(['alpha', 'beta']);
  });

  test('creates runtime feeds for the canonical runtime event domains', () => {
    const events = createRemoteRuntimeEvents(async () => () => {});

    expect(events.domains).toEqual(RUNTIME_EVENT_DOMAINS);
    expect(typeof events.agents.on).toBe('function');
    expect(typeof events.domain('knowledge').onEnvelope).toBe('function');
  });

  test('builds stable event transport URLs', () => {
    expect(buildEventSourceUrl('http://127.0.0.1:3210/', 'agents')).toBe(
      'http://127.0.0.1:3210/api/control-plane/events?domains=agents',
    );
    expect(buildWebSocketUrl('https://example.com/root', ['agents', 'knowledge'])).toBe(
      'wss://example.com/api/control-plane/ws?clientKind=web&domains=agents%2Cknowledge',
    );
  });

  describe('forSession', () => {
    test('filters: non-matching sessionId does not fire on callback', async () => {
      const received: unknown[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionEvents = forSession(events, 'session-A');
      sessionEvents.alpha.on('ALPHA_READY', (payload) => received.push(payload));

      await Promise.resolve();
      // Wrong session — should be silently dropped.
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-B', payload: { ok: false } });
      // No sessionId — also dropped.
      dispatch?.({ type: 'ALPHA_READY', payload: { ok: null } });
      // Correct session — should fire.
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: { ok: true } });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ ok: true });
    });

    test('filters: matching sessionId fires onEnvelope', async () => {
      const received: string[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionEvents = forSession(events, 'session-A');

      sessionEvents.alpha.onEnvelope('ALPHA_READY', (e) => {
        received.push(e.sessionId ?? 'none');
      });

      // Trigger one that matches.
      await Promise.resolve();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: { ok: true } });
      // Trigger one that does NOT match — should be silently dropped.
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-B', payload: { ok: false } });
      // Trigger one with no sessionId — also dropped.
      dispatch?.({ type: 'ALPHA_READY', payload: { ok: null } });

      expect(received).toEqual(['session-A']);
    });

    test('filters: matching sessionId fires on (payload only)', async () => {
      const received: unknown[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionEvents = forSession(events, 'session-X');

      sessionEvents.alpha.on('ALPHA_READY', (payload) => received.push(payload));

      await Promise.resolve();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-X', payload: { ok: true } });
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-Y', payload: { ok: false } });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ ok: true });
    });

    test('unsubscribe: stops receiving events', async () => {
      const received: unknown[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionEvents = forSession(events, 'session-A');
      const unsub = sessionEvents.alpha.onEnvelope('ALPHA_READY', (e) => {
        received.push(e.sessionId);
      });

      await Promise.resolve();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} });
      expect(received).toHaveLength(1);

      unsub();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} });
      expect(received).toHaveLength(1); // no new events after unsub
    });

    test('multiple parallel sessions: each receives only its own events', async () => {
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionA = forSession(events, 'session-A');
      const sessionB = forSession(events, 'session-B');

      sessionA.alpha.onEnvelope('ALPHA_READY', (e) => receivedA.push(e.sessionId));
      sessionB.alpha.onEnvelope('ALPHA_READY', (e) => receivedB.push(e.sessionId));

      await Promise.resolve();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} });
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-B', payload: {} });
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} });

      expect(receivedA).toEqual(['session-A', 'session-A']);
      expect(receivedB).toEqual(['session-B']);
    });

    test('domain accessor on filtered view is also filtered', async () => {
      const received: unknown[] = [];
      let dispatch: ((envelope: { type: string; sessionId?: string; payload: unknown }) => void) | null = null;

      const events = createRemoteDomainEvents(['alpha', 'beta'] as const, async (_domain, onEnvelope) => {
        dispatch = onEnvelope as typeof dispatch;
        return () => {};
      });

      const sessionEvents = forSession(events, 'session-A');
      // Use domain() accessor instead of property shorthand.
      sessionEvents.domain('alpha').onEnvelope('ALPHA_READY', (e) => received.push(e.sessionId));

      await Promise.resolve();
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-A', payload: {} });
      dispatch?.({ type: 'ALPHA_READY', sessionId: 'session-Z', payload: {} });

      expect(received).toEqual(['session-A']);
      // domains list is preserved.
      expect(sessionEvents.domains).toEqual(['alpha', 'beta']);
    });
  });

  test('reconnects SSE runtime connectors with Last-Event-ID', async () => {
    const seenLastEventIds: Array<string | null> = [];
    let calls = 0;
    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      'token-123',
      createFetchStub(async (_input, init) => {
        calls += 1;
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        const lastEventId = headers.get('last-event-id');
        seenLastEventIds.push(lastEventId);
        if (calls === 1) {
          return createSseResponse([
            'id: evt-1\n',
            'event: agents\n',
            'data: {"type":"AGENT_STARTED","payload":{"id":"a1"}}\n\n',
          ]);
        }
        if (lastEventId === 'evt-2') {
          return createOpenSseResponse([]);
        }
        return createSseResponse([
          'id: evt-2\n',
          'event: agents\n',
          'data: {"type":"AGENT_COMPLETED","payload":{"id":"a1"}}\n\n',
        ]);
      }),
      {
        reconnect: {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
    );

    const events = createRemoteRuntimeEvents(connector);
    const payloads: unknown[] = [];
    const unsubscribe = events.agents.onEnvelope('AGENT_COMPLETED', (event) => {
      payloads.push(event.payload);
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    unsubscribe();

    expect(seenLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(seenLastEventIds).toContain('evt-2');
    expect(payloads).toEqual([{ id: 'a1' }]);
  });
});
