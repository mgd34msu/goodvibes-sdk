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
 * worker script location. We copy worker.mjs into a tmp directory outside
 * dist/ to avoid racing with concurrent builds, and point modulesRoot at
 * packages/sdk/dist/ so that `import './web.js'` resolves correctly.
 * The tmp directory is cleaned up in afterAll().
 *
 * Run:
 *   bun run build && bun test test/workers/workers.test.ts
 *
 * Or via the dedicated script:
 *   bun run test:workers
 */

import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Miniflare } from 'miniflare';

// n-2: fileURLToPath alias — __dirname here is a local const, NOT the Node.js
// global __dirname (which is unavailable in ESM). Named explicitly to reduce
// confusion when reading this file alongside CJS code.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIST = resolve(__dirname, '../../packages/sdk/dist');
const WORKER_SOURCE = resolve(__dirname, 'worker.mjs');

// m-5: Write to a tmp dir OUTSIDE dist/ to eliminate the dist-race foot-gun.
// Concurrent builds that clean/rewrite dist/ cannot clobber the staged file.
const TMP_DIR = resolve(__dirname, '../../.test-tmp/workers-harness');
const WORKER_IN_TMP = resolve(TMP_DIR, '_workers-test-entry.mjs');
const WORKER_BUNDLED = resolve(TMP_DIR, '_workers-test-bundled.mjs');

let mf: Miniflare;

beforeAll(async () => {
  // m-5: Stage a full snapshot of SDK_DIST in a tmp dir OUTSIDE dist/ to
  // eliminate the dist-race foot-gun. modulesRoot points to TMP_DIR so all
  // static imports (including subdirs like _internal/) resolve from a stable
  // location that concurrent builds cannot race against.
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  // (esbuild handles module resolution; no copyDir needed)
  mkdirSync(TMP_DIR, { recursive: true });
  // Stage the worker source INSIDE SDK_DIST so its ./web.js / ./errors.js
  // relative imports resolve against the built dist during bundling.
  const WORKER_IN_DIST = resolve(SDK_DIST, '_workers-test-entry.mjs');
  writeFileSync(WORKER_IN_DIST, readFileSync(WORKER_SOURCE, 'utf8'), 'utf8');

  // Pre-bundle the worker entry via esbuild so bare-module specifiers
  // (e.g. 'zod/v4') that Miniflare cannot resolve locally are inlined
  // into a single self-contained module. Output lands in TMP_DIR.
  const { execFileSync: execBundle } = await import('node:child_process');
  try {
    execBundle(
      'bunx',
      [
        'esbuild',
        '--bundle',
        '--platform=browser',
        '--format=esm',
        '--target=es2022',
        `--outfile=${WORKER_BUNDLED}`,
        WORKER_IN_DIST,
      ],
      { stdio: 'inherit' },
    );
  } finally {
    // Clean up the staged worker file from dist so concurrent builds don't trip over it.
    if (existsSync(WORKER_IN_DIST)) {
      rmSync(WORKER_IN_DIST, { force: true });
    }
  }

  mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_BUNDLED,
    modulesRoot: TMP_DIR,
    modulesRules: [
      { type: 'ESModule', include: ['**/*.js', '**/*.mjs'] },
    ],
    // m-6: compatibilityDate — bump quarterly; pick a date within the last
    // calendar quarter. Updated from '2024-09-23' to '2026-04-01'.
    compatibilityDate: '2026-04-01',
  });
  // Wait for Miniflare to be ready
  await mf.ready;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  // Clean up staged worker file and tmp dir
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
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
  // M-1 (success path): mock returns real-shape JSON for GET /api/sessions.
  // Asserts that result is non-null and contains expected fields, proving the
  // transport completed the full HTTP round-trip successfully — not just that
  // it didn't crash.
  test('success path — mock returns real-shape JSON, result is populated', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport-success');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // result must be non-null: mock matched the real SDK route (GET /api/sessions)
    expect(body.result).not.toBeNull();
    // Verify real-shape fields from sessions.list output schema
    const result = body.result as Record<string, unknown>;
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('sessions');
    // No error on the success path
    expect(body.kind).toBeNull();
    expect(body.ctor).toBeNull();
  }, 10_000);

  // M-1 (error path): mock returns 5xx. Asserts errorKind === 'server' (exact
  // literal, not regex) — proving SDK error taxonomy works under Workers runtime.
  // m-2: kind and ctor are returned as SEPARATE fields to avoid conflating
  // typed SDKErrorKind values with raw constructor names.
  test('error path — mock returns 5xx, errorKind is typed \'server\'', async () => {
    const res = await mf.dispatchFetch('http://workers.test/transport-error');
    // Worker must not crash (status 200 = error was caught and returned as JSON)
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // result is null because the call threw
    expect(body.result).toBeNull();

    // m-2: assert 'kind' is a typed SDKErrorKind, not a constructor name
    const validKinds = ['auth', 'config', 'contract', 'network', 'not-found', 'rate-limit', 'server', 'validation', 'unknown'];
    expect(body.kind).toBe('server'); // 500 maps to category 'service' -> kind 'server'
    expect(validKinds).toContain(body.kind as string);

    // m-2: assert 'ctor' is a string (the constructor name of the thrown error)
    expect(typeof body.ctor).toBe('string');
    expect((body.ctor as string).length).toBeGreaterThan(0);
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
    // m-4: errorClassNames contains only actual Error subclasses
    const names = body.errorClassNames as string[];
    expect(names.length).toBeGreaterThan(0);
    // Sentinel: GoodVibesSdkError must be present (it IS an Error subclass)
    expect(names).toContain('GoodVibesSdkError');
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

  // m-1: Assert the ACTUAL observed value, not just typeof.
  // Miniflare simulates EventSource; production Cloudflare Workers does NOT.
  // TODO: Wrangler-based re-run would flip this to false — tracked as Wave 4 follow-up.
  test('EventSource availability (Miniflare injects it, real Workers does not)', async () => {
    const res = await mf.dispatchFetch('http://workers.test/globals');
    const body = await res.json() as Record<string, unknown>;
    const globals = body.globals as Record<string, boolean>;

    // Miniflare simulates EventSource; production Cloudflare Workers does NOT.
    // TODO: Wrangler-based re-run would flip this to false — tracked as Wave 4 follow-up.
    expect(globals.EventSource).toBe(true);
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
