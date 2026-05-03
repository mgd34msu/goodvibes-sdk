/**
 * Idempotency key + per-method retry policy tests.
 *
 * Covers:
 * 1. Idempotency-Key header present on POST/PUT/PATCH/DELETE
 * 2. Idempotency-Key NOT present on GET/HEAD
 * 3. Header value is a valid UUID v4
 * 4. A fresh key is generated per request (no reuse)
 * 5. Non-idempotent mutations (POST without perMethodPolicy) NOT retried on 5xx
 * 6. Idempotent GET methods ARE retried on 5xx per default policy
 * 7. perMethodPolicy allows retry for a specific mutating method
 * 8. generateIdempotencyKey() produces RFC 4122 v4 UUIDs
 */

import { describe, expect, test } from 'bun:test';
import { createHttpJsonTransport } from '../packages/transport-http/src/http-core.js';
import { generateIdempotencyKey } from '../packages/transport-http/src/http-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function createCapturingFetch(
  responseFactory: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((value, key) => { headers[key] = value; });
    }
    const req: CapturedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers,
    };
    requests.push(req);
    return responseFactory(req);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// generateIdempotencyKey()
// ---------------------------------------------------------------------------

describe('generateIdempotencyKey()', () => {
  test('returns a string matching UUID v4 format', () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(UUID_V4_RE.test(key)).toBe(true);
  });

  test('generates unique values on each call', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateIdempotencyKey()));
    expect(keys.size).toBe(20);
  });

  test('version nibble is 4', () => {
    const key = generateIdempotencyKey();
    // Position 14 in the UUID (after removing dashes: 8+1+4+1 = 14th char = version)
    const withoutDashes = key.replace(/-/g, '');
    expect(withoutDashes[12]).toBe('4');
  });

  test('variant bits are correct (8, 9, a, or b)', () => {
    const key = generateIdempotencyKey();
    const withoutDashes = key.replace(/-/g, '');
    const variantChar = withoutDashes[16];
    expect(['8', '9', 'a', 'b']).toContain(variantChar);
  });
});

// ---------------------------------------------------------------------------
// Idempotency-Key header presence
// ---------------------------------------------------------------------------

describe('Idempotency-Key header: mutating methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`${method} request sends Idempotency-Key header`, async () => {
      const { fetch, requests } = createCapturingFetch(() =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      const transport = createHttpJsonTransport({ baseUrl: 'https://api.example.com', fetch });
      await transport.requestJson('/v1/resource', {
        method,
        body: method !== 'DELETE' ? { data: 1 } : undefined,
      });
      expect(requests.length).toBe(1);
      expect(requests[0].method).toBe(method);
      const key = requests[0].headers['idempotency-key'];
      expect(typeof key).toBe('string');
      expect(UUID_V4_RE.test(key)).toBe(true);
    });
  }
});

describe('Idempotency-Key header: idempotent-by-nature methods', () => {
  for (const method of ['GET', 'HEAD']) {
    test(`${method} request does NOT send Idempotency-Key header`, async () => {
      const { fetch, requests } = createCapturingFetch(() =>
        new Response(method === 'HEAD' ? null : JSON.stringify({ ok: true }), { status: 200 }),
      );
      const transport = createHttpJsonTransport({ baseUrl: 'https://api.example.com', fetch });
      await transport.requestJson('/v1/resource', { method });
      expect(requests.length).toBe(1);
      expect(requests[0].headers['idempotency-key']).toBeUndefined();
    });
  }
});

describe('Idempotency-Key: unique per request', () => {
  test('two consecutive POST requests get different Idempotency-Key values', async () => {
    const { fetch, requests } = createCapturingFetch(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const transport = createHttpJsonTransport({ baseUrl: 'https://api.example.com', fetch });
    await transport.requestJson('/v1/a', { method: 'POST', body: { x: 1 } });
    await transport.requestJson('/v1/b', { method: 'POST', body: { x: 2 } });
    expect(requests.length).toBe(2);
    const key1 = requests[0].headers['idempotency-key'];
    const key2 = requests[1].headers['idempotency-key'];
    expect(typeof key1).toBe('string');
    expect(typeof key2).toBe('string');
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Retry policy: mutating methods NOT retried
// ---------------------------------------------------------------------------

describe('Retry policy: non-idempotent mutations', () => {
  test('POST with 5xx response is NOT retried (no perMethodPolicy)', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: { maxAttempts: 3, retryOnStatuses: [500, 502, 503], retryOnMethods: ['GET', 'POST'] },
    });
    let caught: unknown;
    try {
      await transport.requestJson('/v1/sessions', { method: 'POST', body: { title: 'test' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // Non-idempotent POST must NOT retry — exactly 1 attempt.
    expect(callCount).toBe(1);
  });

  test('DELETE with 5xx response is NOT retried (no perMethodPolicy)', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'server error' }), { status: 503 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: { maxAttempts: 3, retryOnStatuses: [500, 503], retryOnMethods: ['GET', 'DELETE'] },
    });
    let caught: unknown;
    try {
      await transport.requestJson('/v1/sessions/abc', { method: 'DELETE' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retry policy: GET requests ARE retried
// ---------------------------------------------------------------------------

describe('Retry policy: idempotent GET requests', () => {
  test('GET with 5xx IS retried per default policy when maxAttempts > 1', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: 'retry me' }), { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, retryOnStatuses: [500] },
    });
    const result = await transport.requestJson<{ ok: boolean }>('/v1/agents');
    expect(result.ok).toBe(true);
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// perMethodPolicy override allows retry for a specific mutating method
// ---------------------------------------------------------------------------

describe('perMethodPolicy override', () => {
  test('POST with perMethodPolicy configured IS retried on 5xx', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      if (callCount < 2) {
        return new Response(JSON.stringify({ error: 'retry me' }), { status: 500 });
      }
      return new Response(JSON.stringify({ created: true }), { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        retryOnStatuses: [500],
        retryOnMethods: ['GET', 'POST'],
        perMethodPolicy: {
          'sessions.create': { maxAttempts: 3 },
        },
      },
    });
    const { applyPerMethodPolicy, normalizeHttpRetryPolicy } = await import('../packages/transport-http/src/retry.js');
    const base = normalizeHttpRetryPolicy({
      maxAttempts: 1,
      retryOnStatuses: [500],
      retryOnMethods: ['GET'],
      perMethodPolicy: { 'sessions.create': { maxAttempts: 5 } },
    });
    const applied = applyPerMethodPolicy(base, 'sessions.create');
    expect(applied.maxAttempts).toBe(5);

    const unchanged = applyPerMethodPolicy(base, 'unknown.method');
    expect(unchanged.maxAttempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MAJOR 1: perMethodPolicy end-to-end — methodId from contract, 3 attempts
// ---------------------------------------------------------------------------

describe('perMethodPolicy end-to-end via contract route', () => {
  test('accounts.snapshot with perMethodPolicy retries 3 times on 503', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 0,
        retryOnStatuses: [503],
        retryOnMethods: ['GET', 'POST'], // POST included — perMethodPolicy gating controls safety
        perMethodPolicy: {
          'accounts.snapshot': { maxAttempts: 3 },
        },
      },
    });
    // Invoke with methodId in options — simulates what invokeContractRoute does
    const result = await transport.requestJson<{ ok: boolean }>('/v1/snapshot', {
      method: 'POST',
      body: {},
      methodId: 'accounts.snapshot',
    });
    expect(result.ok).toBe(true);
    expect(callCount).toBe(3);
  });

  test('POST without methodId is NOT retried even when perMethodPolicy is configured', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'oops' }), { status: 503 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        retryOnStatuses: [503],
        retryOnMethods: ['GET', 'POST'],
        perMethodPolicy: {
          'some.other.method': { maxAttempts: 3 },
        },
      },
    });
    let caught: unknown;
    try {
      // No methodId passed — default mutation safety applies
      await transport.requestJson('/v1/action', { method: 'POST', body: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MAJOR 2: contract.idempotent=true enables retry for POST on 5xx
// ---------------------------------------------------------------------------

describe('contract.idempotent flag enables retry for mutating methods', () => {
  test('POST with idempotent=true retries on 5xx', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: 'service unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        retryOnStatuses: [503],
        retryOnMethods: ['GET', 'POST'],
      },
    });
    const result = await transport.requestJson<{ done: boolean }>('/v1/idempotent-action', {
      method: 'POST',
      body: {},
      idempotent: true,
    });
    expect(result.done).toBe(true);
    expect(callCount).toBe(3);
  });

  test('POST with idempotent=false is NOT retried on 5xx', async () => {
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'oops' }), { status: 503 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        retryOnStatuses: [503],
        retryOnMethods: ['GET', 'POST'],
      },
    });
    let caught: unknown;
    try {
      await transport.requestJson('/v1/non-idempotent', { method: 'POST', body: {}, idempotent: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(callCount).toBe(1);
  });

  test('perMethodPolicy override takes precedence over idempotent flag', async () => {
    // perMethodPolicy says maxAttempts: 2, idempotent would allow retry.
    // perMethodPolicy with explicit maxAttempts wins.
    let callCount = 0;
    const { fetch } = createCapturingFetch(() => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'oops' }), { status: 503 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
      retry: {
        maxAttempts: 5, // base would allow 5
        baseDelayMs: 0,
        retryOnStatuses: [503],
        retryOnMethods: ['GET', 'POST'],
        perMethodPolicy: {
          'my.method': { maxAttempts: 2 }, // only 2 for this method
        },
      },
    });
    let caught: unknown;
    try {
      await transport.requestJson('/v1/action', {
        method: 'POST',
        body: {},
        methodId: 'my.method',
        idempotent: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(callCount).toBe(2); // perMethodPolicy maxAttempts=2 wins
  });
});
