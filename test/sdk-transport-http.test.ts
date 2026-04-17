/**
 * SDK mirror regression test for packages/sdk/src/_internal/transport-http/http.ts
 *
 * Ensures the SDK mirror stays in sync with the canonical transport-http package.
 * If these tests pass in transport-http.test.ts but fail here, the mirror has drifted.
 */
import { describe, expect, test } from 'bun:test';
import { HttpStatusError } from '../packages/sdk/src/_internal/errors/index.js';
import { createHttpTransport } from '../packages/sdk/src/_internal/transport-http/http.js';

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

describe('sdk-mirror: transport-http', () => {
  test('network error has category network with cause preserved', async () => {
    const originalError = new TypeError('fetch failed');
    const transport = createHttpTransport({
      baseUrl: 'http://127.0.0.1:3210',
      fetch: createFetchStub(async () => { throw originalError; }),
    });

    let caught: unknown;
    try {
      await transport.requestJson('/api/accounts');
    } catch (error) {
      caught = error;
    }

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

    let caught: unknown;
    try {
      await transport.requestJson('/api/accounts');
    } catch (error) {
      caught = error;
    }

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

    let caught: unknown;
    try {
      await transport.requestJson('/api/accounts');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.hint).toBe('Use the pairing token from the dashboard');
  });
});
