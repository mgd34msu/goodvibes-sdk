/**
 * Transport HTTP tests for the canonical transport package.
 *
 * Ensures structured transport errors keep the shared SDK error taxonomy.
 */
import { describe, expect, test } from 'bun:test';
import { GoodVibesSdkError, HttpStatusError } from '../packages/errors/src/index.js';
import { createHttpTransport } from '../packages/transport-http/src/http.js';
import { createTransportError, createNetworkTransportError } from '../packages/transport-http/src/http-core.js';
import { openServerSentEventStream } from '../packages/transport-http/src/sse-stream.js';

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('transport-http structured throws', () => {
  test('createTransportError(404) returns HttpStatusError with kind not-found', () => {
    const err = createTransportError(404, 'http://example.com/api', 'GET', { error: 'not found' });
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.kind).toBe('not-found');
    expect(err.transport.status).toBe(404);
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
  });

  test('createStreamError via SSE produces GoodVibesSdkError with kind network', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: async () => new Response('service unavailable', { status: 503 }),
    });
    const caught = await openServerSentEventStream(transport.fetchImpl, transport.buildUrl('/api/stream'), {}).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(GoodVibesSdkError);
    const err = caught as GoodVibesSdkError;
    expect(err.kind).toBe('network');
    expect(err.category).toBe('network');
    expect(err.source).toBe('transport');
  });
});

describe('transport-http', () => {
  test('network error has category network with cause preserved', async () => {
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

  test('daemon-supplied hint is preserved over inferred hint', async () => {
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => new Response(
        JSON.stringify({
          error: 'Authentication failed',
          hint: 'Use the pairing token from the dashboard',
          category: 'authentication',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      )),
    });

    const caught = await transport.requestJson('/api/accounts').catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.hint).toBe('Use the pairing token from the dashboard');
  });
});
