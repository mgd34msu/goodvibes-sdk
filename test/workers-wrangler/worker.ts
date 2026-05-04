/**
 * Cloudflare Workers test script for @pellux/goodvibes-sdk — wrangler-CLI harness.
 *
 * Mirrors test/workers/worker.ts exactly. This version is bundled by wrangler dev
 * (esbuild pipeline) rather than Miniflare's programmatic API.
 *
 * IMPORTANT: Despite the name, `wrangler dev --local` does NOT use the raw workerd
 * binary directly — it uses Miniflare 4 as its local runtime layer. This means
 * EventSource IS available here (same as the standalone Miniflare harness). The
 * value of this harness is exercising wrangler's esbuild bundling pipeline and CLI
 * config surface, not a different runtime. To verify production-workerd behaviour
 * (where EventSource is truly absent), a real CF deployment is required.
 *
 * Imports resolve against packages/sdk/dist via the relative path from this file.
 * wrangler dev bundles via its own esbuild pipeline before handing to Miniflare 4.
 */

import type { ExportedHandler, ExecutionContext } from '@cloudflare/workers-types';
// @ts-expect-error resolved by wrangler's esbuild pipeline, not tsc
import { createWebGoodVibesSdk } from '../../packages/sdk/dist/web.js';
// @ts-expect-error resolved by wrangler's esbuild pipeline, not tsc
import * as SdkErrors from '../../packages/sdk/dist/errors.js';

interface Env {}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleSmoke(): Response {
  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
  });

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

async function handleTransportSuccess(): Promise<Response> {
  const mockPayload = {
    totals: { sessions: 1, active: 1, closed: 0 },
    sessions: [{
      id: 'session-001',
      title: 'Test Session',
      status: 'active',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      messageCount: 0,
      pendingInputCount: 0,
      routeIds: [],
      surfaceKinds: [],
      participants: [],
      metadata: {},
    }],
  };

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
    retry: { maxAttempts: 1 },
  });

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

  return json({ ok: true, result, kind, ctor });
}

async function handleTransportError(): Promise<Response> {
  const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', code: 'MOCK_500' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://127.0.0.1:9999',
    authToken: 'test-token',
    fetch: mockFetch,
    retry: { maxAttempts: 1 },
  });

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

  return json({ ok: true, result, kind, ctor });
}

function handleErrors(): Response {
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

async function handleCrypto(): Promise<Response> {
  const uuid = crypto.randomUUID();
  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);

  const hasCryptoSubtle = typeof crypto.subtle === 'object';

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
      WebSocket: typeof WebSocket !== 'undefined',
      // wrangler dev --local uses Miniflare 4 internally, which injects EventSource.
      // Both this harness and the standalone Miniflare harness will be true here.
      // Production workerd does NOT inject EventSource — verifiable only via real CF deployment.
      EventSource: typeof EventSource !== 'undefined',
      location: typeof (globalThis as Record<string, unknown>).location !== 'undefined',
      setTimeout: typeof setTimeout === 'function',
      setInterval: typeof setInterval === 'function',
      clearTimeout: typeof clearTimeout === 'function',
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
        case '/health':
          return new Response('ok', { status: 200 });
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
