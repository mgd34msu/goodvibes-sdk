/**
 * Transport middleware chain tests.
 *
 * Covers:
 * 1. Middleware execution order (outer-first, onion model)
 * 2. Context mutation propagated through chain
 * 3. Error propagation — middleware error surfaces as SDKError{kind:'unknown'}
 * 4. Signal propagation — signal available in ctx
 * 5. ctx.response / ctx.durationMs / ctx.error set correctly
 * 6. sdk.use() appends to chain, stateless rebuild each call
 */

import { describe, expect, test } from 'bun:test';
import { composeMiddleware, type TransportContext, type TransportMiddleware } from '../packages/transport-core/src/middleware.js';
import { createHttpJsonTransport } from '../packages/transport-http/src/http-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<TransportContext> = {}): TransportContext {
  return {
    method: 'GET',
    url: 'https://example.com/api/test',
    headers: {},
    body: undefined,
    options: {},
    signal: undefined,
    ...overrides,
  };
}

function makeInnerFetch(statusCode = 200, body: unknown = { ok: true }): (ctx: TransportContext) => Promise<Response> {
  return async (_ctx) => {
    return new Response(JSON.stringify(body), { status: statusCode });
  };
}

function createFetchStub(factory: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return factory as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// composeMiddleware: execution order
// ---------------------------------------------------------------------------

describe('composeMiddleware: execution order', () => {
  test('single middleware wraps inner fetch — pre/post hooks fire in correct order', async () => {
    const order: string[] = [];
    const mw: TransportMiddleware = async (ctx, next) => {
      order.push('before');
      await next();
      order.push('after');
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], makeInnerFetch());
    await composed(ctx);
    expect(order[0]).toBe('before');
    expect(order[1]).toBe('after');
    expect(order.length).toBe(2);
  });

  test('three middleware run in order — onion model (outer-first, inner-last)', async () => {
    const order: string[] = [];
    const mw = (label: string): TransportMiddleware => async (ctx, next) => {
      order.push(`${label}:before`);
      await next();
      order.push(`${label}:after`);
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw('A'), mw('B'), mw('C')], makeInnerFetch());
    await composed(ctx);
    expect(order).toEqual([
      'A:before',
      'B:before',
      'C:before',
      'C:after',
      'B:after',
      'A:after',
    ]);
  });

  test('empty middleware array — innerFetch called directly', async () => {
    let called = false;
    const inner = async (_ctx: TransportContext) => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([], inner);
    await composed(ctx);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeMiddleware: ctx mutation
// ---------------------------------------------------------------------------

describe('composeMiddleware: ctx mutation', () => {
  test('middleware can add headers — inner fetch receives mutated headers', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mw: TransportMiddleware = async (ctx, next) => {
      ctx.headers['X-Custom'] = 'middleware-value';
      await next();
    };
    const inner = async (ctx: TransportContext) => {
      capturedHeaders = { ...ctx.headers };
      return new Response('{}', { status: 200 });
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], inner);
    await composed(ctx);
    expect(capturedHeaders?.['X-Custom']).toBe('middleware-value');
  });

  test('ctx.response is set after next() resolves', async () => {
    const mw: TransportMiddleware = async (ctx, next) => {
      expect(ctx.response).toBeUndefined();
      await next();
      expect(ctx.response).toBeDefined();
      expect(ctx.response?.status).toBe(201);
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], makeInnerFetch(201));
    await composed(ctx);
    expect(ctx.response?.status).toBe(201);
  });

  test('ctx.durationMs is a non-negative number after next()', async () => {
    const mw: TransportMiddleware = async (ctx, next) => {
      await next();
      expect(typeof ctx.durationMs).toBe('number');
      // Sanity-bound: must be non-negative and complete within 1 s for a trivial fetch stub
      expect(ctx.durationMs!).toBeGreaterThanOrEqual(0);
      expect(ctx.durationMs!).toBeLessThan(1000);
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], makeInnerFetch());
    await composed(ctx);
  });

  test('ctx.method and ctx.url are accessible in middleware', async () => {
    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    const mw: TransportMiddleware = async (ctx, next) => {
      capturedMethod = ctx.method;
      capturedUrl = ctx.url;
      await next();
    };
    const ctx = makeCtx({ method: 'POST', url: 'https://api.example.com/v1/sessions' });
    const composed = composeMiddleware([mw], makeInnerFetch());
    await composed(ctx);
    expect(capturedMethod).toBe('POST');
    expect(capturedUrl).toBe('https://api.example.com/v1/sessions');
  });
});

// ---------------------------------------------------------------------------
// composeMiddleware: error propagation
// ---------------------------------------------------------------------------

describe('composeMiddleware: error propagation', () => {
  test('inner fetch error propagates — ctx.error is set, error re-thrown', async () => {
    const expectedError = new Error('fetch failed');
    const inner = async (_ctx: TransportContext): Promise<Response> => {
      throw expectedError;
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([], inner);
    let caught: unknown;
    try {
      await composed(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(expectedError);
    expect(ctx.error).toBe(expectedError);
    // Sanity-bound: error path still records a real elapsed duration, bounded to 1 s
    expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    expect(ctx.durationMs).toBeLessThan(1000);
  });

  test('middleware error before next() — propagates, inner fetch not called', async () => {
    let innerCalled = false;
    const inner = async (_ctx: TransportContext): Promise<Response> => {
      innerCalled = true;
      return new Response('{}', { status: 200 });
    };
    const mw: TransportMiddleware = async (_ctx, _next) => {
      throw new Error('middleware blew up');
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], inner);
    let caught: unknown;
    try {
      await composed(ctx);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe('middleware blew up');
    expect(innerCalled).toBe(false);
  });

  test('calling next() twice throws', async () => {
    const mw: TransportMiddleware = async (_ctx, next) => {
      await next();
      await next(); // second call must throw
    };
    const ctx = makeCtx();
    const composed = composeMiddleware([mw], makeInnerFetch());
    let caught: unknown;
    try {
      await composed(ctx);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain('next() called multiple times');
  });
});

// ---------------------------------------------------------------------------
// Signal propagation
// ---------------------------------------------------------------------------

describe('composeMiddleware: signal propagation', () => {
  test('signal in ctx matches signal in requestOptions', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const mw: TransportMiddleware = async (ctx, next) => {
      capturedSignal = ctx.signal;
      await next();
    };
    const ctx = makeCtx({ signal: controller.signal });
    const composed = composeMiddleware([mw], makeInnerFetch());
    await composed(ctx);
    expect(capturedSignal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// sdk.use() facade integration
// ---------------------------------------------------------------------------

describe('transport.use() — appends to chain', () => {
  test('middleware registered via use() fires for each request', async () => {
    const intercepted: string[] = [];
    const fetchStub = createFetchStub(async (input) => {
      return new Response(JSON.stringify({ url: String(input) }), { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });
    transport.use(async (ctx, next) => {
      intercepted.push(ctx.url);
      await next();
    });
    await transport.requestJson('/v1/test');
    await transport.requestJson('/v1/other');
    expect(intercepted.length).toBe(2);
    expect(intercepted[0]).toContain('/v1/test');
    expect(intercepted[1]).toContain('/v1/other');
  });

  test('second use() call appends — both middleware fire in order', async () => {
    const order: string[] = [];
    const fetchStub = createFetchStub(async () => {
      return new Response('{}', { status: 200 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });
    transport.use(async (_ctx, next) => { order.push('first'); await next(); });
    transport.use(async (_ctx, next) => { order.push('second'); await next(); });
    await transport.requestJson('/v1/test');
    expect(order[0]).toBe('first');
    expect(order[1]).toBe('second');
  });

  test('middleware can read ctx.response after next()', async () => {
    let responseStatus: number | undefined;
    const fetchStub = createFetchStub(async () => {
      return new Response(JSON.stringify({ data: 1 }), { status: 202 });
    });
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });
    transport.use(async (ctx, next) => {
      await next();
      responseStatus = ctx.response?.status;
    });
    await transport.requestJson('/v1/test');
    expect(responseStatus).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// MAJOR 3: sdk.use() facade on the full SDK instance
// ---------------------------------------------------------------------------

describe('sdk.use() — full SDK facade integration', () => {
  test('sdk.use() appends middleware that runs on operator transport requests', async () => {
    const { createGoodVibesSdk } = await import('../packages/sdk/src/client.js');
    const intercepted: string[] = [];
    const fetchStub: typeof globalThis.fetch = async (input) => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const sdk = createGoodVibesSdk({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });
    sdk.use(async (ctx, next) => {
      intercepted.push(ctx.url);
      await next();
    });
    // Trigger a request via the operator transport directly to verify middleware ran.
    // We invoke requestJson on the underlying transport (accessible via operator.transport).
    await sdk.operator.transport.requestJson('/v1/test');
    expect(intercepted.length).toBeGreaterThanOrEqual(1);
    expect(intercepted[0]).toContain('/v1/test');
  });

  test('multiple sdk.use() calls compose in order', async () => {
    const { createGoodVibesSdk } = await import('../packages/sdk/src/client.js');
    const order: string[] = [];
    const fetchStub: typeof globalThis.fetch = async () => {
      return new Response('{}', { status: 200 });
    };
    const sdk = createGoodVibesSdk({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });
    sdk.use(async (_ctx, next) => { order.push('first'); await next(); });
    sdk.use(async (_ctx, next) => { order.push('second'); await next(); });
    await sdk.operator.transport.requestJson('/v1/test');
    expect(order[0]).toBe('first');
    expect(order[1]).toBe('second');
  });

  test('middleware option in createGoodVibesSdk is applied on first request', async () => {
    const { createGoodVibesSdk } = await import('../packages/sdk/src/client.js');
    let middlewareRan = false;
    const fetchStub: typeof globalThis.fetch = async () => {
      return new Response('{}', { status: 200 });
    };
    const sdk = createGoodVibesSdk({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
      middleware: [
        async (_ctx, next) => {
          middlewareRan = true;
          await next();
        },
      ],
    });
    await sdk.operator.transport.requestJson('/v1/test');
    expect(middlewareRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MINOR 2: HttpStatusError thrown from middleware is wrapped as SDKError{kind:'unknown'}
// ---------------------------------------------------------------------------

describe('middleware error wrap: HttpStatusError from middleware', () => {
  test('HttpStatusError thrown by middleware surfaces as SDKError with middleware identity in cause', async () => {
    const { createHttpJsonTransport } = await import('../packages/transport-http/src/http-core.js');
    const { HttpStatusError, GoodVibesSdkError } = await import('./helpers/dist-errors.js');

    const fetchStub: typeof globalThis.fetch = async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });

    async function myMw(_ctx: Parameters<typeof transport.use>[0] extends (mw: infer M) => void ? Parameters<M>[0] : never, _next: () => Promise<void>): Promise<void> {
      throw new HttpStatusError('Unauthorized from middleware', {
        category: 'auth',
        source: 'transport',
        recoverable: false,
      });
    }
    transport.use(myMw);

    let caught: unknown;
    try {
      await transport.requestJson('/v1/test');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught instanceof GoodVibesSdkError).toBe(true);
    const err = caught as GoodVibesSdkError;
    expect(err.category).toBe('unknown');
    // cause should include middleware identity
    const cause = (err as { cause?: unknown }).cause as { middleware?: string } | undefined;
    expect(cause?.middleware).toBe('myMw');
  });

  test('non-HttpStatusError thrown by middleware is also wrapped with middleware identity', async () => {
    const { createHttpJsonTransport } = await import('../packages/transport-http/src/http-core.js');
    const { GoodVibesSdkError } = await import('./helpers/dist-errors.js');

    const fetchStub: typeof globalThis.fetch = async () => {
      return new Response('{}', { status: 200 });
    };
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch: fetchStub,
    });

    async function loggerMw(_ctx: unknown, _next: () => Promise<void>): Promise<void> {
      throw new Error('logger blew up');
    }
    transport.use(loggerMw as Parameters<typeof transport.use>[0]);

    let caught: unknown;
    try {
      await transport.requestJson('/v1/test');
    } catch (e) {
      caught = e;
    }

    expect(caught instanceof GoodVibesSdkError).toBe(true);
    const err = caught as GoodVibesSdkError;
    expect(err.category).toBe('unknown');
    const cause = (err as { cause?: unknown }).cause as { middleware?: string } | undefined;
    expect(cause?.middleware).toBe('loggerMw');
  });
});
