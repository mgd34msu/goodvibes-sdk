import { describe, expect, test } from 'bun:test';
import { ContractError, HttpStatusError } from '../packages/errors/dist/index.js';
import { createHttpTransport, openServerSentEventStream } from '../packages/transport-http/dist/index.js';

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
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

describe('transport-http', () => {
  test('normalizes failed JSON requests into structured HTTP errors', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({
        error: 'Authentication failed',
        hint: 'wrong token',
        category: 'authentication',
      }, 401)),
    });

    await expect(transport.requestJson('/api/accounts')).rejects.toBeInstanceOf(HttpStatusError);
    await expect(transport.requestJson('/api/accounts')).rejects.toMatchObject({
      message: 'Authentication failed',
      status: 401,
      hint: 'wrong token',
      category: 'authentication',
      transport: {
        status: 401,
        url: 'http://127.0.0.1:3210/api/accounts',
        method: 'GET',
        body: {
          error: 'Authentication failed',
          hint: 'wrong token',
          category: 'authentication',
        },
      },
    });
  });

  test('normalizes missing contract parameters into contract errors', () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({ ok: true })),
    });

    expect(() => transport.resolveContractRequest('GET', '/api/sessions/{sessionId}', {})).toThrow(ContractError);
  });

  test('opens SSE streams through the transport wrapper', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      authToken: 'token-123',
      fetch: createFetchStub(async (input, init) => {
        calls.push({ url: String(input), init });
        return createSseResponse([
          'event: ready\n',
          'data: {"ok":true}\n\n',
          'event: telemetry\n',
          'data: {"type":"tool"}\n\n',
        ]);
      }),
    });

    const readyPayloads: unknown[] = [];
    const events: Array<{ eventName: string; payload: unknown }> = [];
    const stop = await openServerSentEventStream(transport, '/api/v1/telemetry/stream', {
      onReady: (payload) => {
        readyPayloads.push(payload);
      },
      onEvent: (eventName, payload) => {
        events.push({ eventName, payload });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();

    const headers = calls[0]?.init?.headers instanceof Headers ? calls[0].init.headers : new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3210/api/v1/telemetry/stream');
    expect(headers.get('authorization')).toBe('Bearer token-123');
    expect(readyPayloads).toEqual([{ ok: true }]);
    expect(events).toEqual([{
      eventName: 'telemetry',
      payload: { type: 'tool' },
    }]);
  });

  test('resolves auth tokens dynamically for each request', async () => {
    let currentToken = 'token-1';
    const seenAuth: string[] = [];
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      getAuthToken: async () => currentToken,
      fetch: createFetchStub(async (_input, init) => {
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        seenAuth.push(headers.get('authorization') ?? '');
        return createJsonResponse({ ok: true });
      }),
    });

    await transport.requestJson('/api/accounts');
    currentToken = 'token-2';
    await transport.requestJson('/api/accounts');

    expect(seenAuth).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });

  test('retries safe requests on transient failures', async () => {
    let calls = 0;
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
      fetch: createFetchStub(async () => {
        calls += 1;
        if (calls < 3) {
          return createJsonResponse({ error: 'service unavailable' }, 503);
        }
        return createJsonResponse({ ok: true });
      }),
    });

    await expect(transport.requestJson('/api/accounts')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });
});
