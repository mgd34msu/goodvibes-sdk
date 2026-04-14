import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_EVENT_DOMAINS,
  buildEventSourceUrl,
  buildWebSocketUrl,
  createEventSourceConnector,
  createRemoteDomainEvents,
  createRemoteRuntimeEvents,
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
