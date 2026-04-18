/**
 * Cloudflare Workers test script for @pellux/goodvibes-sdk — real workerd harness.
 *
 * Mirrors test/workers/worker.mjs exactly. This version is bundled by wrangler dev
 * (real workerd/esbuild pipeline) rather than Miniflare's programmatic API.
 *
 * The key difference: wrangler uses the real workerd binary for V8 isolation.
 * Globals that Miniflare simulates (notably EventSource) are absent here.
 *
 * Imports resolve against packages/sdk/dist via the relative path from this file.
 * wrangler dev bundles via its own esbuild pipeline before handing to workerd.
 */

import { createWebGoodVibesSdk } from '../../packages/sdk/dist/web.js';
import * as SdkErrors from '../../packages/sdk/dist/errors.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/health':
          return new Response('ok', { status: 200 });
        case '/smoke':
          return handleSmoke();
        case '/auth':
          return handleAuth();
        case '/transport-success':
          return handleTransportSuccess();
        case '/transport-error':
          return handleTransportError();
        case '/errors':
          return handleErrors();
        case '/crypto':
          return handleCrypto();
        case '/globals':
          return handleGlobals();
        default:
          return new Response('Not Found', { status: 404 });
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err), stack: err?.stack }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  },
};

function handleSmoke() {
  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://mock-daemon.internal',
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

async function handleAuth() {
  const token = 'workers-auth-token-abc123';
  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://mock-daemon.internal',
    authToken: token,
  });

  const storedToken = await sdk.auth.getToken();
  const tokenMatches = storedToken === token;

  return json({ ok: true, tokenMatches, storedToken });
}

async function handleTransportSuccess() {
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

  const mockFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/sessions')) {
      return new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  };

  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://mock-daemon.internal',
    authToken: 'test-token',
    fetch: mockFetch,
    retry: { maxAttempts: 1 },
  });

  let result = null;
  let kind = null;
  let ctor = null;
  try {
    result = await sdk.operator.sessions.list();
  } catch (err) {
    kind = err?.kind ?? null;
    ctor = err?.constructor?.name ?? null;
  }

  return json({ ok: true, result, kind, ctor });
}

async function handleTransportError() {
  const mockFetch = async () => {
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', code: 'MOCK_500' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const sdk = createWebGoodVibesSdk({
    baseUrl: 'http://mock-daemon.internal',
    authToken: 'test-token',
    fetch: mockFetch,
    retry: { maxAttempts: 1 },
  });

  let result = null;
  let kind = null;
  let ctor = null;
  try {
    result = await sdk.operator.sessions.list();
  } catch (err) {
    kind = err?.kind ?? null;
    ctor = err?.constructor?.name ?? null;
  }

  return json({ ok: true, result, kind, ctor });
}

function handleErrors() {
  const errorClassNames = Object.keys(SdkErrors).filter((k) => {
    const v = SdkErrors[k];
    return typeof v === 'function' && v.prototype instanceof Error;
  });

  let sdkErrorWorks = false;
  if (SdkErrors.GoodVibesSdkError) {
    const e = new SdkErrors.GoodVibesSdkError('test', {
      kind: 'unknown',
      category: 'internal',
      source: 'transport',
      recoverable: false,
    });
    sdkErrorWorks = e instanceof Error && e.message === 'test';
  }

  return json({ ok: true, errorClassNames, sdkErrorWorks });
}

async function handleCrypto() {
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

function handleGlobals() {
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
      // Real workerd does NOT inject EventSource (Miniflare was simulating it)
      EventSource: typeof EventSource !== 'undefined',
      location: typeof globalThis.location !== 'undefined',
      setTimeout: typeof setTimeout === 'function',
      setInterval: typeof setInterval === 'function',
      clearTimeout: typeof clearTimeout === 'function',
      process: typeof process !== 'undefined',
      Buffer: typeof Buffer !== 'undefined',
    },
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
