/**
 * Cloudflare Workers test script for @pellux/goodvibes-sdk.
 *
 * This script runs inside the Miniflare Workers isolate. It exercises the
 * SDK's ./web entry point against mock HTTP responses to prove the bundle
 * loads, initialises, and operates correctly under the Workers V8 runtime.
 *
 * Entry selection: ./web (dist/web.js) — the same entry used by browser
 * consumers. It contains no node: imports and no Bun.* API calls, making it
 * a direct fit for Workers.
 *
 * Static imports: Miniflare 4 requires static import specifiers (no dynamic
 * import with variable paths). We import from relative paths that Miniflare
 * resolves via modulesRoot pointing to packages/sdk/dist.
 *
 * Workers-specific notes embedded in each handler.
 */

import type { ExportedHandler, ExecutionContext } from '@cloudflare/workers-types';
// Static imports resolved via Miniflare modulesRoot -> packages/sdk/dist
// @ts-expect-error resolved by esbuild at bundle time, not tsc
import { createWebGoodVibesSdk } from './web.js';
// @ts-expect-error resolved by esbuild at bundle time, not tsc
import * as SdkErrors from './errors.js';

interface Env {}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * /smoke — SDK import + factory call succeeds in isolate.
 *
 * Workers concern: globalThis.location.origin is undefined in Workers
 * (no browser location object). The SDK's browser.ts resolver throws
 * ConfigurationError when baseUrl is omitted and location.origin is
 * unavailable. We always pass an explicit baseUrl — this is the correct
 * Workers usage pattern.
 */
function handleSmoke(): Response {
  const sdk = createWebGoodVibesSdk({
    // Use localhost URL — normalizeBaseUrl requires https:// or a local
    // (127.x / localhost) host for http://. 'mock-daemon.internal' is neither.
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
  });

  // n-1 guard: typeof x === 'object' returns true for null — check x != null first
  const hasOperator = sdk.operator != null && typeof sdk.operator === 'object';
  const hasAuth = sdk.auth != null && typeof sdk.auth === 'object';
  const hasRealtime = sdk.realtime != null && typeof sdk.realtime === 'object';

  return json({
    ok: true,
    hasOperator,
    hasAuth,
    hasRealtime,
    sdkKeys: Object.keys(sdk).sort(),
  });
}

/**
 * /auth — auth token flow works in Workers isolate.
 *
 * Workers concern: none. Auth is synchronous token storage — no node: or
 * Bun.* surface. crypto.randomUUID() and crypto.subtle are available.
 */
async function handleAuth(): Promise<Response> {
  const token = 'workers-auth-token-abc123';
  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: token,
  });

  const storedToken = await sdk.auth.getToken();
  const tokenMatches = storedToken === token;

  return json({ ok: true, tokenMatches, storedToken });
}

/**
 * /transport-success — HTTP transport round-trip with mocked fetch (success path).
 *
 * Workers concern: setTimeout used in backoff retry is request-scoped.
 * For this test we do NOT retry (maxAttempts: 1) to avoid any
 * cross-request timer issues. Long-running retries with persistent
 * timers across request boundaries would break; see NOTES.md.
 *
 * fetch is native in Workers — no polyfill needed.
 *
 * Route: sdk.operator.sessions.list() sends GET /api/sessions.
 * The mock returns a real-shape JSON response so result is populated.
 */
async function handleTransportSuccess(): Promise<Response> {
  // Real-shape mock payload matching sessions.list output schema.
  const mockPayload = {
    totals: { sessions: 1, active: 1, closed: 0 },
    sessions: [{
      id: 'session-001',
      kind: 'tui',
      title: 'Test Session',
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      lastActivityAt: 1700000000000,
      messageCount: 0,
      pendingInputCount: 0,
      routeIds: [],
      surfaceKinds: [],
      participants: [],
      metadata: {},
    }],
  };

  // Mock fetch matching the real SDK route: GET /api/sessions
  const mockFetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('/api/sessions')) {
      return new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };

  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
    fetch: mockFetch,
    retry: { maxAttempts: 1 }, // no retries: avoid cross-request timer issues
  });

  // sdk.operator.sessions.list() — GET /api/sessions
  let result: unknown = null;
  let kind: string | null = null;
  let ctor: string | null = null;
  try {
    result = await sdk.operator.sessions.list();
  } catch (err: unknown) {
    kind = (err as Record<string, unknown>)?.kind as string ?? null;
    ctor = (err as Record<string, unknown>)?.constructor instanceof Function
      ? ((err as Record<string, unknown>).constructor as { name?: string }).name ?? null
      : null;
  }

  return json({
    ok: true,
    result,
    kind,
    ctor,
  });
}

/**
 * /transport-error — HTTP transport with 5xx response (error path).
 *
 * Mock returns a 500 to verify the SDK's error taxonomy surfaces
 * a typed 'service' error kind rather than a raw runtime crash.
 */
async function handleTransportError(): Promise<Response> {
  // Mock fetch that always returns a 5xx to trigger typed error
  const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', code: 'MOCK_500' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
    fetch: mockFetch,
    retry: { maxAttempts: 1 }, // no retries
  });

  let result: unknown = null;
  let kind: string | null = null;
  let ctor: string | null = null;
  try {
    result = await sdk.operator.sessions.list();
  } catch (err: unknown) {
    // Return kind and ctor as separate fields to avoid conflating
    // typed SDKErrorKind values with raw constructor names.
    kind = (err as Record<string, unknown>)?.kind as string ?? null;
    ctor = (err as Record<string, unknown>)?.constructor instanceof Function
      ? ((err as Record<string, unknown>).constructor as { name?: string }).name ?? null
      : null;
  }

  return json({
    ok: true,
    result,
    kind,
    ctor,
  });
}

/**
 * /errors — error taxonomy is present and typed in Workers isolate.
 *
 * Workers concern: none for pure error class instantiation.
 * The SDK error classes use no node: or Bun.* APIs.
 */
function handleErrors(): Response {
  // Only include actual Error subclasses — not plain functions or non-Error exports.
  const errorClassNames = Object.keys(SdkErrors).filter((k) => {
    const v = (SdkErrors as Record<string, unknown>)[k];
    return typeof v === 'function' && (v as { prototype?: unknown }).prototype instanceof Error;
  });

  let sdkErrorWorks = false;
  const GoodVibesSdkError = (SdkErrors as Record<string, unknown>).GoodVibesSdkError as
    | (new (msg: string, meta: Record<string, unknown>) => Error)
    | undefined;
  if (GoodVibesSdkError) {
    const e = new GoodVibesSdkError('test', {
      kind: 'unknown',
      category: 'internal',
      source: 'transport',
      recoverable: false,
    });
    sdkErrorWorks = e instanceof Error && e.message === 'test';
  }

  return json({ ok: true, errorClassNames, sdkErrorWorks });
}

/**
 * /crypto — verify Workers crypto.subtle and crypto.randomUUID availability.
 *
 * Workers concern: crypto.subtle IS available (no polyfill needed).
 * crypto.randomUUID IS available. This verifies future token-crypto paths
 * will work without extra adapters.
 */
async function handleCrypto(): Promise<Response> {
  const uuid = crypto.randomUUID();
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);

  // Verify crypto.subtle is available
  const hasCryptoSubtle = typeof crypto.subtle === 'object';

  // Quick hash to exercise crypto.subtle
  const encoded = new TextEncoder().encode('goodvibes-workers-test');
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return json({
    ok: true,
    uuid,
    isValidUuid,
    hasCryptoSubtle,
    sha256HashLength: hashHex.length,
  });
}

/**
 * /globals — audit Workers global availability.
 *
 * Reports the globals that define the Workers runtime boundary.
 */
function handleGlobals(): Response {
  return json({
    ok: true,
    globals: {
      fetch: typeof fetch !== 'undefined',
      Request: typeof Request !== 'undefined',
      Response: typeof Response !== 'undefined',
      Headers: typeof Headers !== 'undefined',
      URL: typeof URL !== 'undefined',
      URLSearchParams: typeof URLSearchParams !== 'undefined',
      crypto: typeof crypto !== 'undefined',
      cryptoSubtle: typeof crypto?.subtle !== 'undefined',
      cryptoRandomUUID: typeof crypto?.randomUUID === 'function',
      // NOT available in Workers (server-upgrade only, no client WS)
      WebSocket: typeof WebSocket !== 'undefined',
      // NOT available in production Workers (Miniflare simulates it)
      EventSource: typeof EventSource !== 'undefined',
      // NOT available in Workers (no DOM)
      location: typeof (globalThis as Record<string, unknown>).location !== 'undefined',
      // Timers — available but request-scoped
      setTimeout: typeof setTimeout === 'function',
      setInterval: typeof setInterval === 'function',
      clearTimeout: typeof clearTimeout === 'function',
      // Not available
      process: typeof (globalThis as Record<string, unknown>).process !== 'undefined',
      Buffer: typeof (globalThis as Record<string, unknown>).Buffer !== 'undefined',
    },
  });
}

const handler: ExportedHandler<Env> = {
  async fetch(request, _env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/smoke':
          return handleSmoke();
        case '/auth':
          return await handleAuth();
        case '/transport-success':
          return await handleTransportSuccess();
        case '/transport-error':
          return await handleTransportError();
        case '/errors':
          return handleErrors();
        case '/crypto':
          return await handleCrypto();
        case '/globals':
          return handleGlobals();
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err: unknown) {
      const e = err as { message?: string; stack?: string };
      return new Response(
        JSON.stringify({ error: String(err), stack: e?.stack }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};

export default handler;
