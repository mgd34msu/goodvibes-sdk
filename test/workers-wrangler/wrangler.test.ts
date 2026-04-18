/**
 * Real workerd harness — @pellux/goodvibes-sdk Workers parity test.
 *
 * Spawns `wrangler dev --local` against test/workers-wrangler/worker.mjs and
 * exercises the same endpoint surface as the Miniflare harness in
 * test/workers/workers.test.ts. This is the closest you can get to production
 * Cloudflare Workers without an actual deployment.
 *
 * Key differences from the Miniflare harness:
 *   - EventSource is NOT available (Miniflare was polyfilling it; workerd doesn't)
 *   - Real workerd V8 isolate — not Miniflare's simulation layer
 *   - Transport goes through wrangler's esbuild pipeline, not manual esbundle step
 *
 * Run:
 *   bun run build && bun run test:workers:wrangler
 *
 * Prerequisites:
 *   - wrangler must be installed (devDependency)
 *   - SDK must be built (dist/web.js must exist)
 *   - No Cloudflare account or API token required (--local mode)
 *
 * Startup behaviour:
 *   - wrangler dev cold-starts in ~5-15s (downloads workerd binary on first run)
 *   - CI timeout: 120s for the job; wrangler startup timeout here: 60s
 *   - Port: randomised above 10000 to avoid collisions with other test jobs
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(__dirname); // test/workers-wrangler/

// Pick a random port in [12000, 19999] to avoid collisions.
// Not 8787 (wrangler default) or common dev ports.
const PORT = 12000 + Math.floor(Math.random() * 8000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Maximum time to wait for wrangler to report ready (ms).
const STARTUP_TIMEOUT_MS = 60_000;
// Interval between health-check polls (ms).
const POLL_INTERVAL_MS = 500;

let wranglerProcess: ChildProcess;

// ---------------------------------------------------------------------------
// Lifecycle: spawn wrangler dev, poll /health, kill after tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  wranglerProcess = spawn(
    'bunx',
    [
      'wrangler',
      'dev',
      '--local',
      '--port', String(PORT),
      // Suppress interactive prompts — we are non-interactive in CI and tests.
      '--no-bundle=false',
    ],
    {
      cwd: HARNESS_DIR,
      // Inherit stderr so wrangler startup/error output appears in test logs.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Suppress wrangler telemetry and update checks in CI.
        WRANGLER_SEND_METRICS: 'false',
        NO_COLOR: '1',
      },
    },
  );

  // Capture wrangler stderr for diagnostics on failure.
  const stderrLines: string[] = [];
  wranglerProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString());
  });
  wranglerProcess.stdout?.on('data', (chunk: Buffer) => {
    stderrLines.push(chunk.toString());
  });

  // Poll /health until wrangler is ready or timeout.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    // If wrangler exited early, fail immediately with diagnostics.
    if (wranglerProcess.exitCode !== null) {
      const logs = stderrLines.join('');
      throw new Error(
        `wrangler dev exited early (code ${wranglerProcess.exitCode}).\n` +
        `Port: ${PORT}\n` +
        `Output:\n${logs}`,
      );
    }

    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // Not ready yet — keep polling.
    }
  }

  if (!ready) {
    const logs = stderrLines.join('');
    wranglerProcess.kill('SIGKILL');
    throw new Error(
      `wrangler dev did not become ready within ${STARTUP_TIMEOUT_MS}ms on port ${PORT}.\n` +
      `Output:\n${logs}`,
    );
  }
}, STARTUP_TIMEOUT_MS + 5_000);

afterAll(async () => {
  if (wranglerProcess && wranglerProcess.exitCode === null) {
    wranglerProcess.kill('SIGTERM');
    // Give it 3s to clean up before force-killing.
    await sleep(3000);
    if (wranglerProcess.exitCode === null) {
      wranglerProcess.kill('SIGKILL');
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests — mirror the Miniflare harness assertions
// ---------------------------------------------------------------------------

describe('Workers wrangler: smoke', () => {
  test('SDK loads and factory produces a valid sdk object under real workerd', async () => {
    const { status, body } = await get('/smoke');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.hasOperator).toBe(true);
    expect(b.hasAuth).toBe(true);
    expect(b.hasRealtime).toBe(true);

    const keys = b.sdkKeys as string[];
    expect(keys).toContain('operator');
    expect(keys).toContain('auth');
    expect(keys).toContain('realtime');
  }, 15_000);
});

describe('Workers wrangler: auth flow', () => {
  test('auth token is stored and retrievable inside real workerd isolate', async () => {
    const { status, body } = await get('/auth');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.tokenMatches).toBe(true);
    expect(b.storedToken).toBe('workers-auth-token-abc123');
  }, 10_000);
});

describe('Workers wrangler: transport-http round-trip', () => {
  test('success path — mock returns real-shape JSON, result is populated', async () => {
    const { status, body } = await get('/transport-success');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.result).not.toBeNull();

    const result = b.result as Record<string, unknown>;
    expect(result).toHaveProperty('totals');
    expect(result).toHaveProperty('sessions');
    expect(b.kind).toBeNull();
    expect(b.ctor).toBeNull();
  }, 10_000);

  test('error path — mock returns 5xx, errorKind is typed \'server\'', async () => {
    const { status, body } = await get('/transport-error');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.result).toBeNull();

    const validKinds = ['auth', 'config', 'contract', 'network', 'not-found', 'rate-limit', 'server', 'validation', 'unknown'];
    expect(b.kind).toBe('server');
    expect(validKinds).toContain(b.kind as string);
    expect(typeof b.ctor).toBe('string');
    expect((b.ctor as string).length).toBeGreaterThan(0);
  }, 10_000);
});

describe('Workers wrangler: error taxonomy', () => {
  test('errors subpath loads and GoodVibesSdkError is instantiable', async () => {
    const { status, body } = await get('/errors');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.sdkErrorWorks).toBe(true);

    const names = b.errorClassNames as string[];
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('GoodVibesSdkError');
  }, 10_000);
});

describe('Workers wrangler: crypto', () => {
  test('crypto.randomUUID produces valid UUID v4 under real workerd', async () => {
    const { status, body } = await get('/crypto');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    expect(b.ok).toBe(true);
    expect(b.isValidUuid).toBe(true);
    expect(b.hasCryptoSubtle).toBe(true);
    expect(b.sha256HashLength).toBe(64);
  }, 10_000);
});

describe('Workers wrangler: globals audit', () => {
  test('fetch, Request, Response, Headers, URL, crypto are available', async () => {
    const { status, body } = await get('/globals');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    const globals = b.globals as Record<string, boolean>;
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

  // FINDING (discovered during harness implementation 2026-04-17):
  // wrangler dev --local uses Miniflare 4 internally as its local runtime layer.
  // Both this harness and the Miniflare standalone harness share the same
  // Miniflare 4 runtime, which injects EventSource as a simulation artifact.
  // EventSource === true in BOTH harnesses — the gap cannot be exercised locally
  // without a real Cloudflare deployment (CF_API_TOKEN required).
  //
  // See test/workers/FINDINGS.md — "Real workerd harness — EventSource finding"
  // for the full analysis and implications.
  test('EventSource: wrangler dev --local uses Miniflare 4 (EventSource present, same as standalone Miniflare)', async () => {
    const { status, body } = await get('/globals');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    const globals = b.globals as Record<string, boolean>;

    // wrangler dev --local routes through Miniflare 4, which injects EventSource.
    // This matches the standalone Miniflare harness (both true).
    // A real production Workers deployment would return false — not testable locally.
    expect(globals.EventSource).toBe(true);
  }, 10_000);

  test('location is NOT available in real workerd (must pass explicit baseUrl)', async () => {
    const { status, body } = await get('/globals');
    expect(status).toBe(200);

    const b = body as Record<string, unknown>;
    const globals = b.globals as Record<string, boolean>;
    expect(globals.location).toBe(false);
  }, 10_000);
});
