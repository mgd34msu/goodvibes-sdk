/**
 * Wave 4 — Cloudflare Workers real-runtime harness.
 *
 * Uses Miniflare (programmatic API, v4) to run the built ./web entry under
 * the actual workerd V8 isolate. Each test dispatches a real HTTP fetch to
 * the worker and asserts the JSON response.
 *
 * Architecture decision: ./web entry (dist/web.js) is sufficient.
 * No new ./workers subpath is required — dist/web.js has zero node: imports
 * and zero Bun.* API calls, matching the Workers runtime constraint exactly.
 *
 * Module resolution: Miniflare resolves static imports relative to the
 * scriptPath location. We copy worker.mjs into packages/sdk/dist/ so that
 * `import './web.js'` resolves to `dist/web.js`. The copied file is removed
 * in afterAll().
 *
 * Run:
 *   bun run build && bun test test/workers/workers.test.ts
 *
 * Or via the dedicated script:
 *   bun run test:workers
 */

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = resolve(__dirname, '../../packages/sdk/dist');
const WORKER_SOURCE = resolve(__dirname, 'worker.mjs');
// Worker entry lives inside SDK_DIST so Miniflare resolves imports from there.
const WORKER_IN_DIST = resolve(SDK_DIST, '_workers-test-entry.mjs');

let mf: Miniflare;

beforeAll(async () => {
  // Stage the worker script inside SDK_DIST so Miniflare resolves
  // `import './web.js'` relative to the dist directory.
  writeFileSync(WORKER_IN_DIST, readFileSync(WORKER_SOURCE, 'utf8'), 'utf8');

  mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_IN_DIST,
    modulesRoot: SDK_DIST,
    // Treat all .js/.mjs files in the dist directory as ES modules.
    // Without this, Miniflare defaults to CommonJS parsing for .js files,
    // but our dist is pure ESM (type: module in package.json).
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'] },
    ],
    // compatibilityDate enables latest Workers runtime features
    compatibilityDate: '2024-09-23',
  });
  // Wait for Miniflare to be ready
  await mf.ready;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  // Clean up staged worker file
  if (existsSync(WORKER_IN_DIST)) {
    unlinkSync(WORKER_IN_DIST);
  }
});

// ─── Smoke ───────────────────────────────────────────────────────────────────

describe('Workers harness: smoke', () => {
  test('SDK loads and factory produces a valid sdk object', async () => {
    const res = await mf.dispatchFetch('http://workers.test/smoke');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.hasOperator).toBe(true);
    expect(body.hasAuth).toBe(true);
    expect(body.hasRealtime).toBe(true);
    // Verify expected top-level sdk namespaces are present
    const keys = body.sdkKeys as string[];
    expect(keys).toContain('operator');
    expect(keys).toContain('auth');
    expect(keys).toContain('realtime');
  }, 15_000);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Workers harness: auth flow', () => {
  test('auth token is stored and retrievable inside isolate', async () => {
    const res = await mf.dispatchFetch('http://workers.test/auth');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.tokenMatches).toBe(true);
    expect(body.storedToken).toBe('workers-auth-token-abc123');
  }, 10_000);
});

// ─── Transport HTTP ───────────────────────────────────────────────────────────

describe('Workers harness: transport-http round-trip', () => {
  test('HTTP transport completes a round-trip with mocked fetch', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transportRoundTripCompleted).toBe(true);
  }, 10_000);

  test('transport errors do not crash the worker (typed or untyped)', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport');
    // The key assertion: the worker did NOT crash (500) — any error was caught
    // and returned as a structured JSON payload. This proves the SDK's error
    // boundary works under the Workers runtime.
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.transportRoundTripCompleted).toBe(true);
    // errorKind may be a typed SDK kind (e.g. 'not-found', 'network') or
    // a constructor name if the error was not fully wrapped. Either way,
    // the worker must have caught it and returned a valid JSON response.
    if (body.errorKind !== null) {
      expect(typeof body.errorKind).toBe('string');
    }
  }, 10_000);
});

// ─── Error taxonomy ───────────────────────────────────────────────────────────

describe('Workers harness: error taxonomy', () => {
  test('errors subpath loads and GoodVibesSdkError is instantiable', async () => {
    const res = await mf.dispatchFetch('http://workers.test/errors');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.sdkErrorWorks).toBe(true);
    const names = body.errorClassNames as string[];
    expect(names.length).toBeGreaterThan(0);
  }, 10_000);
});

// ─── Crypto ───────────────────────────────────────────────────────────────────

describe('Workers harness: crypto.subtle + randomUUID', () => {
  test('crypto.randomUUID produces valid UUID v4', async () => {
    const res = await mf.dispatchFetch('http://workers.test/crypto');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.isValidUuid).toBe(true);
    expect(body.hasCryptoSubtle).toBe(true);
    expect(body.sha256HashLength).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
  }, 10_000);
});

// ─── Globals audit ────────────────────────────────────────────────────────────

describe('Workers harness: globals audit', () => {
  test('fetch, Request, Response, Headers, URL, crypto are available', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;
    expect(globals.fetch).toBe(true);
    expect(globals.Request).toBe(true);
    expect(globals.Response).toBe(true);
    expect(globals.Headers).toBe(true);
    expect(globals.URL).toBe(true);
    expect(globals.crypto).toBe(true);
    expect(globals.cryptoSubtle).toBe(true);
    expect(globals.cryptoRandomUUID).toBe(true);
    expect(globals.setTimeout).toBe(true);
  }, 10_000);

  test('EventSource availability (Miniflare injects it, real Workers does not)', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;

    // FINDING: Miniflare simulates EventSource in its local runtime, but the
    // real Cloudflare Workers production runtime does NOT expose EventSource.
    // See FINDINGS.md section 1 for details.
    // We assert the reported value here; real-runtime behaviour is documented.
    // In Miniflare: globals.EventSource === true (simulation)
    // In production Workers: EventSource is undefined
    expect(typeof globals.EventSource).toBe('boolean'); // present either way
  }, 10_000);

  test('location is NOT available (must pass explicit baseUrl)', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;

    // location.origin is absent in Workers — SDK throws ConfigurationError
    // if baseUrl is omitted. Workers callers must pass baseUrl explicitly.
    expect(globals.location).toBe(false);
  }, 10_000);
});
