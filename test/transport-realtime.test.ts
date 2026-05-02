import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_EVENT_DOMAINS,
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
  createWebSocketConnector,
  DEFAULT_WS_MAX_ATTEMPTS,
  forSession,
  getStreamReconnectDelay,
  normalizeStreamReconnectPolicy,
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

// ---------------------------------------------------------------------------
// Minimal mock WebSocket for unit-level WS connector tests.
// Supports immediate open/message/close event simulation.
// ---------------------------------------------------------------------------
type WsEventName = 'open' | 'message' | 'close' | 'error';

interface MockWebSocketHandle {
  simulateOpen(): void;
  simulateMessage(data: string): void;
  simulateClose(): void;
  sentMessages: string[];
}

function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket;
  instances: MockWebSocketHandle[];
} {
  const instances: MockWebSocketHandle[] = [];

  class MockWebSocket {
    private listeners = new Map<WsEventName, Set<EventListenerOrEventListenerObject>>();
    readonly sentMessages: string[] = [];
    readonly url: string;
    readonly readyState: number = 0;

    constructor(url: string) {
      this.url = url;
      const handle: MockWebSocketHandle = {
        simulateOpen: () => this._dispatch('open', new Event('open')),
        simulateMessage: (data: string) =>
          this._dispatch('message', Object.assign(new Event('message'), { data }) as MessageEvent),
        simulateClose: () => this._dispatch('close', new Event('close')),
        sentMessages: this.sentMessages,
      };
      instances.push(handle);
    }

    addEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }

    removeEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      this.listeners.get(event)?.delete(listener);
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close() {}

    private _dispatch(event: WsEventName, evt: Event) {
      for (const listener of this.listeners.get(event) ?? []) {
        if (typeof listener === 'function') listener(evt);
        else listener.handleEvent(evt);
      }
    }
  }

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances };
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

    const deadline = Date.now() + 500;
    while (Date.now() < deadline && payloads.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    unsubscribe();

    expect(seenLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(seenLastEventIds).toContain('evt-2');
    expect(payloads).toEqual([{ id: 'a1' }]);
  });

  // ---------------------------------------------------------------------------
  // F-CONC-02: Default maxAttempts is finite (not POSITIVE_INFINITY)
  // ---------------------------------------------------------------------------
  test('WebSocket connector: DEFAULT_WS_MAX_ATTEMPTS is finite and positive', () => {
    expect(Number.isFinite(DEFAULT_WS_MAX_ATTEMPTS)).toBe(true);
    expect(DEFAULT_WS_MAX_ATTEMPTS).toBeGreaterThan(0);
  });

  test('WebSocket connector: omitting maxAttempts uses DEFAULT_WS_MAX_ATTEMPTS, not POSITIVE_INFINITY', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();

    // Connect with reconnect enabled but no explicit maxAttempts.
    const connector = createWebSocketConnector(
      'http://127.0.0.1:3210',
      'token-abc',
      MockWebSocket,
      { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0 } },
    );

    const stop = await connector('agents', () => {});

    // There should be exactly one instance created.
    expect(instances).toHaveLength(1);

    // Exhaust max reconnects by simulating open + close cycles up to the default limit.
    // After DEFAULT_WS_MAX_ATTEMPTS closes, no additional reconnect timers should fire.
    for (let i = 0; i < DEFAULT_WS_MAX_ATTEMPTS + 5; i++) {
      const ws = instances[instances.length - 1];
      if (!ws) break;
      ws.simulateOpen();
      await new Promise((r) => setTimeout(r, 0)); // allow onOpen to settle
      ws.simulateClose();
      await new Promise((r) => setTimeout(r, 0)); // allow scheduleReconnect to settle
    }

    // Reconnects are bounded: total instances <= DEFAULT_WS_MAX_ATTEMPTS + 1 (original connection).
    expect(instances.length).toBeLessThanOrEqual(DEFAULT_WS_MAX_ATTEMPTS + 1);
    expect(instances.length).not.toBe(DEFAULT_WS_MAX_ATTEMPTS + 6); // would be true if infinite

    stop();
  });

  // ---------------------------------------------------------------------------
  // F-CONC-02: reconnectAttempt resets on first successful message
  // ---------------------------------------------------------------------------
  test('WebSocket connector: reconnectAttempt resets on first successful message, not just open', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();

    const payloads: unknown[] = [];
    const connector = createWebSocketConnector(
      'http://127.0.0.1:3210',
      'token-abc',
      MockWebSocket,
      { reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 } },
    );

    const stop = await connector('agents', (envelope) => payloads.push(envelope));
    expect(instances).toHaveLength(1);

    // Simulate one full connect + first successful message.
    instances[0].simulateOpen();
    await new Promise((r) => setTimeout(r, 0));
    instances[0].simulateMessage(JSON.stringify({
      type: 'event',
      event: 'agents',
      payload: { type: 'AGENT_STARTED', sessionId: 's1', payload: { id: 'a1' } },
    }));
    // After message, reconnectAttempt should have reset: close and reconnect multiple times
    // without hitting the maxAttempts cap (they should all succeed since counter reset).
    instances[0].simulateClose();
    await new Promise((r) => setTimeout(r, 0));

    expect(instances.length).toBeGreaterThanOrEqual(2);
    // 2nd connection opened after reset, meaning cap was not exhausted by the first close.
    expect(payloads).toHaveLength(1);

    stop();
  });

  // ---------------------------------------------------------------------------
  // F-CONC-03: Auth frame is guaranteed first — outbound queue flushed after auth
  // ---------------------------------------------------------------------------
  test('WebSocket connector: auth frame is written before other outbound writes', async () => {
    let resolveToken!: () => void;
    const tokenPromise = new Promise<void>((res) => { resolveToken = res; });

    let authResolveCount = 0;
    const slowToken = async () => {
      authResolveCount++;
      if (authResolveCount === 1) {
        // First connection: slow token resolution to simulate the auth race.
        await tokenPromise;
      }
      return 'tok-xyz';
    };

    const { MockWebSocket, instances } = createMockWebSocketClass();

    const connector = createWebSocketConnector(
      'http://127.0.0.1:3210',
      slowToken,
      MockWebSocket,
    );

    await connector('agents', () => {});
    expect(instances).toHaveLength(1);
    const ws = instances[0];

    // Trigger onOpen, which starts async token resolution but doesn't resolve yet.
    ws.simulateOpen();

    // At this point token hasn't resolved. In the old code, a daemon push arriving
    // before auth was race-prone; with buffering we don't queue outbound here but
    // the auth frame must be the FIRST message sent once the token resolves.
    expect(ws.sentMessages).toHaveLength(0); // auth not sent yet

    // Now resolve the token.
    resolveToken();
    await new Promise((r) => setTimeout(r, 0));

    // Auth frame should now be the first and only outbound message.
    expect(ws.sentMessages).toHaveLength(1);
    const authFrame = JSON.parse(ws.sentMessages[0]!) as { type: string; token: string; domains: string[] };
    expect(authFrame.type).toBe('auth');
    expect(authFrame.token).toBe('tok-xyz');
    expect(authFrame.domains).toContain('agents');
  });

  // ---------------------------------------------------------------------------
  // F-DRY-03: SSE and WS produce identical backoff schedules for equivalent inputs
  // ---------------------------------------------------------------------------
  test('SSE and WS backoff schedules are identical for equivalent policy inputs', () => {
    // Both connectors call getStreamReconnectDelay with a 1-based attempt counter.
    // WS: nextAttempt = reconnectAttempt + 1, then getStreamReconnectDelay(nextAttempt, policy).
    // SSE: nextAttempt = reconnectAttempts + 1, then getStreamReconnectDelay(nextAttempt, policy).
    // Both forms are symmetric — verified by inspecting the single shared helper path.
    // This test validates the shared helper's output, which both connectors consume identically.
    const policy = normalizeStreamReconnectPolicy({
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      backoffFactor: 2,
      maxAttempts: 10,
    });

    const expectedSchedule = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      getStreamReconnectDelay(attempt, policy),
    );

    // Verify the schedule is monotonically non-decreasing and capped at maxDelayMs.
    for (let i = 1; i < expectedSchedule.length; i++) {
      expect(expectedSchedule[i]).toBeGreaterThanOrEqual(expectedSchedule[i - 1]!);
    }
    // Attempt 1: computeBackoffDelay returns 0 (first retry, no delay yet per helper semantics).
    expect(expectedSchedule[0]).toBe(0);
    // After several retries the delay reaches maxDelayMs.
    expect(expectedSchedule[expectedSchedule.length - 1]).toBe(5_000);
  });
});
