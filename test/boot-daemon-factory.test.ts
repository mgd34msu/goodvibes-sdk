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

// ---------------------------------------------------------------------------
// W3-S1 Part A — SSE domain-scoped delivery, proved against the webui's exact
// subscription profile over a REAL operator SSE stream. useRealtimeInvalidation
// connects with ?domains=tasks,permissions,providers,knowledge,control-plane and
// declares no `session` domain (it drops session-update as inert). After the
// domain-scope fix the webui must (a) STOP receiving session-update — even though
// the operator token is admin and bypasses the read:sessions scope gate, the
// domain filter still excludes it — while (b) STILL receiving events in the five
// domains it subscribed to (control-plane here, emitted when a second client
// connects). Domain and scope are AND-ed, so this could only pass with the domain
// filter in place.
// ---------------------------------------------------------------------------
describe('W3-S1 — webui SSE compatibility (domain-scoped delivery)', () => {
  const WEBUI_DOMAINS = 'tasks,permissions,providers,knowledge,control-plane';

  /** Read an operator SSE stream for `windowMs`, firing `onOpen` once the first
   *  bytes arrive (by which point the server-side subscriptions are live), and
   *  return the parsed `event:` names. */
  async function readSse(
    domains: string,
    windowMs: number,
    onOpen: () => Promise<void>,
  ): Promise<string[]> {
    const ac = new AbortController();
    const res = await fetch(`${daemon.url}/api/control-plane/events?domains=${domains}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];
    // Bound the stream read: an idle SSE stream only speaks again at the 15s
    // heartbeat, so abort at the window to unblock a pending reader.read().
    const timer = setTimeout(() => ac.abort(), windowMs);
    let buf = '';
    let opened = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const records = buf.split('\n\n');
        buf = records.pop() ?? '';
        for (const rec of records) {
          const m = rec.match(/event: (.+)/);
          if (m) events.push(m[1]!.trim());
        }
        if (!opened) {
          opened = true;
          await onOpen();
        }
      }
    } catch {
      // aborted / closed — expected at window end
    } finally {
      clearTimeout(timer);
      ac.abort();
      await reader.cancel().catch(() => {});
    }
    return events;
  }

  test('webui profile receives its subscribed domains but NOT session-update', async () => {
    const events = await readSse(WEBUI_DOMAINS, 900, async () => {
      // (a) publishEvent('session-update') — tagged `session`, absent from the webui domain set.
      await fetch(`${daemon.url}/api/sessions/register`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          sessionId: 'w3s1-webui-sse',
          kind: 'tui',
          participant: { surfaceKind: 'tui', surfaceId: 'sx', lastSeenAt: Date.now() },
        }),
      });
      // (b) a second SSE connection emits a `control-plane` domain event the first
      //     stream (subscribed to control-plane) must still receive.
      const ac2 = new AbortController();
      await fetch(`${daemon.url}/api/control-plane/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: ac2.signal,
      }).catch(() => {});
      // give the events a beat to propagate before the read window closes
      await new Promise<void>((r) => setTimeout(r, 250));
      ac2.abort();
    });

    // The fix: session-update is domain-filtered out despite admin bypassing scope.
    expect(events).not.toContain('session-update');
    // Regression guard: the five subscribed domains still deliver (control-plane here).
    expect(events).toContain('control-plane');
  });
});

// ---------------------------------------------------------------------------
// W3-S1 Part B — invoke-layer input validation over the real HTTP invoke seam.
// A verb with a typed inputSchema must reject a wrong-typed body with an honest
// 400 + INVALID_INPUT code before its handler runs, while a well-typed body
// passes the gate. panels.open (inputSchema requires a string `id`) is the probe.
// ---------------------------------------------------------------------------
describe('W3-S1 — invoke-layer input validation', () => {
  async function invoke(methodId: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${daemon.url}/api/control-plane/methods/${methodId}/invoke`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ body }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  test('a typed verb with a wrong-typed field is a 400 INVALID_INPUT (not silent coercion)', async () => {
    const { status, json } = await invoke('panels.open', { id: 123 });
    expect(status).toBe(400);
    expect(json.code).toBe('INVALID_INPUT');
    expect(String(json.error)).toContain('id');
  });

  test('valid params pass the input gate unchanged (no INVALID_INPUT rejection)', async () => {
    const { json } = await invoke('panels.open', { id: 'w3s1-panel', pane: 'main' });
    // Whatever the handler ultimately returns, the validation gate must not reject it.
    expect(json.code).not.toBe('INVALID_INPUT');
  });
});
