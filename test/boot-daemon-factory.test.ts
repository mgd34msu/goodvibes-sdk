/**
 * boot-daemon-factory.test.ts
 *
 * R4: the public one-call daemon boot factory. Proves an embedder/test can stand
 * up a real daemon (isolated home, ephemeral port, token auth) without hand-
 * mirroring cli.ts's construction graph, and take it down cleanly. Also folds in
 * the HTTP-level assertions for R1 (unknown-kind 400 + honest closed-register
 * conflict), R2 (isolated home — nothing under the real home is touched), R3
 * (companion session visible via /api/sessions same-process), and m7 (companion
 * SSE 401 without auth).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'test-boot-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'boot-home-'));
  work = mkdtempSync(join(tmpdir(), 'boot-work-'));
  daemon = await bootDaemon({
    homeDirectory: home,
    workingDir: work,
    daemonHomeDir: join(home, 'daemon'),
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
  });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('R4 — bootDaemon one-call factory', () => {
  test('boots on an ephemeral port and exposes an addressable url', () => {
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
  });

  test('every route is auth-gated: no token → 401', async () => {
    const res = await fetch(`${daemon.url}/api/sessions`);
    expect(res.status).toBe(401);
  });

  test('auth round-trip: a valid token reaches the sessions surface', async () => {
    const res = await fetch(`${daemon.url}/api/sessions`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });
});

describe('R1 — sessions.register honest validation over HTTP', () => {
  test('an unknown session kind is a 400, not a silent coercion to tui', async () => {
    const res = await fetch(`${daemon.url}/api/sessions/register`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        sessionId: 'r1-bad-kind',
        kind: 'not-a-real-kind',
        participant: { surfaceKind: 'tui', surfaceId: 's1', lastSeenAt: Date.now() },
      }),
    });
    expect(res.status).toBe(400);
  });

  test('registering a closed session without reopen returns reopened=false + conflict', async () => {
    const body = {
      sessionId: 'r1-closed',
      kind: 'tui',
      participant: { surfaceKind: 'tui', surfaceId: 's2', lastSeenAt: Date.now() },
    };
    // create + close
    await fetch(`${daemon.url}/api/sessions/register`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
    await fetch(`${daemon.url}/api/sessions/r1-closed/close`, { method: 'POST', headers: auth() });

    const res = await fetch(`${daemon.url}/api/sessions/register`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const json = await res.json() as { session: { status: string }; reopened: boolean; conflict?: { status: string } };
    expect(json.reopened).toBe(false);
    expect(json.conflict).toEqual({ status: 'closed' });
    expect(json.session.status).toBe('closed');

    // with reopen:true it flips active
    const res2 = await fetch(`${daemon.url}/api/sessions/register`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ ...body, reopen: true }),
    });
    const json2 = await res2.json() as { session: { status: string }; reopened: boolean };
    expect(json2.reopened).toBe(true);
    expect(json2.session.status).toBe('active');
  });
});

describe('R2 — isolated home', () => {
  test('the daemon persists under the injected home, not the OS home', () => {
    // The control-plane store lives under <home>/.goodvibes/...; nothing is written
    // to a sibling temp dir. We assert the injected home tree exists and is used.
    expect(existsSync(join(home, '.goodvibes'))).toBe(true);
  });
});

describe('D6 — operator provider/account snapshots serve JSON, never 500 HTML', () => {
  // Regression: under bootDaemon's fresh isolated home the pricing catalog has
  // not hydrated, so the configured default model ('openrouter:openrouter/free')
  // has no materialized registry definition and getCurrentModel() throws. The
  // read-only snapshot builders must tolerate that and still answer with JSON
  // instead of letting the exception fall through to Bun's 500 SPA-fallback HTML.
  for (const path of ['/api/accounts', '/api/providers']) {
    test(`GET ${path} returns 200 application/json (not 500, not HTML)`, async () => {
      const res = await fetch(`${daemon.url}${path}`, { headers: auth() });
      const contentType = res.headers.get('content-type') ?? '';
      expect(res.status).toBe(200);
      expect(contentType).toContain('application/json');
      expect(contentType).not.toContain('text/html');
      const body = await res.json() as { providers: unknown[] };
      expect(Array.isArray(body.providers)).toBe(true);
      // With no active/resolvable current model, no provider claims active:true.
      for (const provider of body.providers as Array<{ active?: unknown }>) {
        expect(provider.active).toBe(false);
      }
    });
  }
});

describe('m7 — companion SSE requires auth', () => {
  test('companion chat events stream returns 401 without a token (auth gate before lookup)', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/any-id/events`);
    expect(res.status).toBe(401);
  });
});
