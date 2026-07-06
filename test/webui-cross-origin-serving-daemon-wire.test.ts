/**
 * webui-cross-origin-serving-daemon-wire.test.ts
 *
 * Proves the opt-in same-origin bundle serving + cross-origin (CORS) capabilities
 * against a REAL daemon booted on an ephemeral port with an isolated home. Never
 * touches the operator's real daemons (127.0.0.1:3421 / 0.0.0.0:4444).
 *
 * Coverage (per the SDK-DEPLOY brief):
 *   1. Both capabilities OFF (default): GET / and OPTIONS behave exactly as today
 *      (401 without a token, 404 with one), and no Access-Control-Allow-Origin is
 *      ever emitted — byte-parity with the pre-change daemon.
 *   2. Serving ON: GET / serves the bundle index.html same-origin without a token,
 *      hashed assets serve, and SPA navigation routes fall back to index.html.
 *   3. API precedence holds: /api/* is dispatched to the API, never served as a
 *      static file, and still requires auth (no-token -> 401) with serving ON.
 *   4. CORS preflight from an allowlisted origin returns 2xx with an echoed
 *      Access-Control-Allow-Origin + Allow-Headers that includes Authorization.
 *   5. A non-allowlisted origin is refused honestly (403 preflight, no ACAO; actual
 *      request carries no ACAO).
 *   6. No credentialed wildcard is possible: ACAO is always the exact origin, never
 *      '*', and Allow-Credentials rides only with a specific origin.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'test-webui-serving-token';
const ALLOWED_ORIGIN = 'http://localhost:5173';
const OTHER_ORIGIN = 'http://evil.example.com';

const INDEX_HTML = '<!doctype html><html><head><title>bundle</title></head><body><div id="root"></div><script src="/assets/app-deadbeef.js"></script></body></html>';
const APP_JS = 'console.log("goodvibes web ui bundle");';

let onHome: string;
let onWork: string;
let offHome: string;
let offWork: string;
let bundleDir: string;
let servingOn: BootedDaemon;
let servingOff: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  // A minimal built bundle: index.html + a hashed asset under /assets.
  bundleDir = mkdtempSync(join(tmpdir(), 'webui-bundle-'));
  mkdirSync(join(bundleDir, 'assets'), { recursive: true });
  writeFileSync(join(bundleDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(bundleDir, 'assets', 'app-deadbeef.js'), APP_JS);

  // Daemon with BOTH capabilities enabled.
  onHome = mkdtempSync(join(tmpdir(), 'webui-on-home-'));
  onWork = mkdtempSync(join(tmpdir(), 'webui-on-work-'));
  const onConfig = new ConfigManager({ workingDir: onWork, homeDir: onHome, surfaceRoot: 'goodvibes' });
  onConfig.set('controlPlane.webui.serve', true);
  onConfig.set('controlPlane.webui.bundleDir', bundleDir);
  onConfig.set('controlPlane.cors.enabled', true);
  onConfig.set('controlPlane.cors.allowedOrigins', ALLOWED_ORIGIN);
  servingOn = await bootDaemon({
    homeDirectory: onHome,
    workingDir: onWork,
    daemonHomeDir: join(onHome, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    configManager: onConfig,
  });

  // Daemon with defaults (both capabilities OFF) for byte-parity checks.
  offHome = mkdtempSync(join(tmpdir(), 'webui-off-home-'));
  offWork = mkdtempSync(join(tmpdir(), 'webui-off-work-'));
  servingOff = await bootDaemon({
    homeDirectory: offHome,
    workingDir: offWork,
    daemonHomeDir: join(offHome, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await servingOn?.stop();
  await servingOff?.stop();
  for (const dir of [onHome, onWork, offHome, offWork, bundleDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('capabilities OFF — byte-parity with today', () => {
  test('GET / without a token is 401 (unchanged) and emits no allow-origin', async () => {
    const res = await fetch(`${servingOff.url}/`);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.body?.cancel();
  });

  test('GET / with a token is 404 (no bundle configured)', async () => {
    const res = await fetch(`${servingOff.url}/`, { headers: auth() });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  test('OPTIONS with an origin is 401 (unchanged) and emits no allow-origin', async () => {
    const res = await fetch(`${servingOff.url}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.body?.cancel();
  });
});

describe('bundle serving ON — same-origin, public, SPA fallback', () => {
  test('GET / serves index.html without a token', async () => {
    const res = await fetch(`${servingOn.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<div id="root"></div>');
  });

  test('a hashed asset serves with an immutable cache and JS content-type', async () => {
    const res = await fetch(`${servingOn.url}/assets/app-deadbeef.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('javascript');
    expect(res.headers.get('cache-control') ?? '').toContain('immutable');
    const body = await res.text();
    expect(body).toContain('goodvibes web ui bundle');
  });

  test('an unknown navigation route falls back to index.html (SPA)', async () => {
    const res = await fetch(`${servingOn.url}/sessions/abc`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<div id="root"></div>');
  });

  test('a missing concrete asset is an honest 404, not the HTML shell', async () => {
    const res = await fetch(`${servingOn.url}/assets/does-not-exist.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<div id="root"></div>');
  });

  test('a traversal-shaped request never leaks a file outside the bundle', async () => {
    // The URL layer collapses every `..` (literal or percent-encoded) before the
    // daemon sees it, so a traversal attempt can only ever resolve inside the
    // bundle root — it must return the app shell / 404, never system file bytes.
    const res = await fetch(`${servingOn.url}/%2e%2e/%2e%2e/etc/passwd`);
    const body = await res.text();
    expect(body).not.toContain('root:');
    expect([200, 404]).toContain(res.status);
  });
});

describe('API precedence + auth hold with serving ON', () => {
  test('GET /api/sessions is dispatched to the API, not served as a file (no token -> 401)', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`);
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  test('GET /api/sessions with a token reaches the sessions surface (200 JSON)', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

describe('CORS preflight + emission (allowlist-gated, no wildcard)', () => {
  test('preflight from an allowlisted origin returns 204 with echoed ACAO + Authorization in Allow-Headers', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('authorization');
    expect(res.headers.get('vary') ?? '').toContain('Origin');
    await res.body?.cancel();
  });

  test('an allowlisted actual request carries an echoed ACAO (never a wildcard)', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`, { headers: auth({ origin: ALLOWED_ORIGIN }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    await res.json();
  });

  test('preflight from a non-allowlisted origin is refused (403, no ACAO)', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: OTHER_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.body?.cancel();
  });

  test('a non-allowlisted actual request is processed but carries no ACAO', async () => {
    const res = await fetch(`${servingOn.url}/api/sessions`, { headers: auth({ origin: OTHER_ORIGIN }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.json();
  });
});
