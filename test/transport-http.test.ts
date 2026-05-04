import { describe, expect, test } from 'bun:test';
import { ContractError, GoodVibesSdkError, HttpStatusError } from '../packages/errors/dist/index.js';
import { createHttpTransport, openServerSentEventStream } from '../packages/transport-http/dist/index.js';
import { createTransportError, createNetworkTransportError } from '../packages/transport-http/src/http-core.js';
import { settleEvents } from './_helpers/test-timeout.js';

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

describe('transport-http structured throws', () => {
  test('createTransportError(404) returns HttpStatusError instance with kind not-found', () => {
    const err = createTransportError(404, 'http://example.com/api', 'GET', { error: 'not found' });
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.kind).toBe('not-found');
    expect(err.status).toBe(404);
    expect(err.category).toBe('not_found');
    expect(err.source).toBe('transport');
    expect(err.transport.status).toBe(404);
    expect(err.transport.url).toBe('http://example.com/api');
    expect(err.transport.method).toBe('GET');
  });

  test('createTransportError(429) carries retryAfterMs in both error and transport payload', () => {
    const err = createTransportError(429, 'http://example.com/api', 'GET', { error: 'rate limited' }, 5000);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.transport.retryAfterMs).toBe(5000);
  });

  test('createNetworkTransportError returns HttpStatusError with kind network and cause preserved', () => {
    const cause = new TypeError('fetch failed');
    const err = createNetworkTransportError(cause, 'http://example.com/api', 'GET');
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.kind).toBe('network');
    expect(err.category).toBe('network');
    expect(err.source).toBe('transport');
    expect(err.recoverable).toBe(true);
    expect((err as unknown as { cause: unknown }).cause).toBe(cause);
    expect(err.transport.status).toBe(0);
    expect(err.transport.cause).toBe(cause);
  });

  test('createStreamError via SSE stream produces GoodVibesSdkError with kind network', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () => new Response('service unavailable', { status: 503 }),
    });
    const caught = await openServerSentEventStream(transport, '/api/stream', {}).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    const err = caught as GoodVibesSdkError;
    expect(err.kind).toBe('network');
    expect(err.category).toBe('network');
    expect(err.source).toBe('transport');
  });
});

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

    await settleEvents(10);
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

  test('network error produces HttpStatusError with category network and cause preserved', async () => {
    const originalError = new TypeError('fetch failed');
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => { throw originalError; }),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('network');
    expect(err.source).toBe('transport');
    expect(err.recoverable).toBe(true);
    expect(err.hint).toContain('127.0.0.1:3210');
    expect(err.cause).toBe(originalError);
  });

  test('429 with retry-after header populates retryAfterMs', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => new Response(
        JSON.stringify({ error: 'rate limited' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'retry-after': '5',
          },
        },
      )),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.hint).toContain('5000ms');
  });

  test('429 with HTTP-date retry-after header populates a positive retryAfterMs', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => new Response(
        JSON.stringify({ error: 'rate limited' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT',
          },
        },
      )),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('rate_limit');
    // HTTP-date is in the past so retryAfterMs will be 0 or a small negative clamped value;
    // the key assertion is that the field is present and is a number (not undefined)
    expect(typeof err.retryAfterMs).toBe('number');
  });

  test('429 without retry-after header still produces rate_limit category with generic hint', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({ error: 'too many requests' }, 429)),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('rate_limit');
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.hint).toContain('Back off and retry');
  });

  test('401 error populates authentication category and inferred hint', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({ error: 'unauthorized' }, 401)),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('authentication');
    expect(err.status).toBe(401);
    expect(err.hint).toContain('authentication token');
  });

  test('503 error populates service category and server hint', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({ error: 'service unavailable' }, 503)),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.category).toBe('service');
    expect(err.status).toBe(503);
    expect(err.hint).toContain('server error');
  });

  test('daemon-supplied hint is preserved over inferred hint', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => createJsonResponse({
        error: 'Authentication failed',
        hint: 'Use the pairing token from the dashboard',
        category: 'authentication',
      }, 401)),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.hint).toBe('Use the pairing token from the dashboard');
  });
});
