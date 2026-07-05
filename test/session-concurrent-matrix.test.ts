/**
 * session-concurrent-matrix.test.ts
 *
 * D7c — CONCURRENT SESSIONS ARE A MUST-HAVE. N sessions across N surfaces coexist
 * on ONE daemon: starting one never disturbs another, heartbeats are independent,
 * closing ONE closes only that one, and a daemon restart survives all of them.
 *
 * Matrix: two TUI-class sessions (different projects) + one agent-class + one
 * webui-class, all live against one real bootDaemon over the HTTP wire.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'concurrent-matrix-token';

function auth(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
}

interface WireSession {
  readonly id: string;
  readonly kind: string;
  readonly project: string;
  readonly status: string;
  readonly participants: readonly { readonly surfaceId?: string; readonly lastSeenAt: number }[];
}

async function listSessions(url: string): Promise<WireSession[]> {
  const res = await fetch(`${url}/api/sessions?includeClosed=true`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { sessions: WireSession[] };
  return body.sessions;
}

async function register(
  url: string,
  input: { sessionId: string; kind: string; project: string; surfaceId: string; lastSeenAt: number },
): Promise<Response> {
  return fetch(`${url}/api/sessions/register`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      sessionId: input.sessionId,
      kind: input.kind,
      project: input.project,
      participant: { surfaceKind: input.kind, surfaceId: input.surfaceId, lastSeenAt: input.lastSeenAt },
    }),
  });
}

const MATRIX = [
  { sessionId: 'tui-proj-alpha', kind: 'tui', project: '/alpha', surfaceId: 'surface:tui-a' },
  { sessionId: 'tui-proj-beta', kind: 'tui', project: '/beta', surfaceId: 'surface:tui-b' },
  { sessionId: 'agent-worker-1', kind: 'agent', project: '/alpha', surfaceId: 'surface:agent-1' },
  { sessionId: 'webui-client-1', kind: 'webui', project: '/beta', surfaceId: 'surface:webui-1' },
] as const;

describe('D7c — N concurrent sessions across surfaces on one daemon', () => {
  let home: string | null = null;
  let work: string | null = null;
  let daemon: BootedDaemon | null = null;

  afterEach(async () => {
    if (daemon) await daemon.stop();
    if (home) rmSync(home, { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
    daemon = home = work = null;
  });

  test('all four register, list live together, heartbeat independently, close in isolation, and survive restart', async () => {
    home = mkdtempSync(join(tmpdir(), 'matrix-home-'));
    work = mkdtempSync(join(tmpdir(), 'matrix-work-'));
    const daemonHomeDir = join(home, 'daemon');
    daemon = await bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir, port: 0, host: '127.0.0.1', token: TOKEN });

    // --- All four register and coexist in sessions.list ---
    const base = 1_000_000;
    for (const s of MATRIX) {
      const res = await register(daemon.url, { ...s, lastSeenAt: base });
      expect(res.status).toBe(200);
    }
    let sessions = await listSessions(daemon.url);
    for (const s of MATRIX) {
      const rec = sessions.find((r) => r.id === s.sessionId);
      expect(rec, `session ${s.sessionId} must be listed`).toBeTruthy();
      expect(rec!.kind).toBe(s.kind);
      expect(rec!.status).toBe('active');
    }
    expect(sessions.filter((r) => MATRIX.some((m) => m.sessionId === r.id))).toHaveLength(4);

    // --- Heartbeats are INDEPENDENT: beat only tui-proj-alpha; nobody else moves ---
    const before = new Map(sessions.map((r) => [r.id, r.participants[0]?.lastSeenAt ?? 0]));
    await register(daemon.url, { ...MATRIX[0], lastSeenAt: base + 50_000 });
    sessions = await listSessions(daemon.url);
    const afterAlpha = sessions.find((r) => r.id === 'tui-proj-alpha')!.participants[0]?.lastSeenAt ?? 0;
    expect(afterAlpha).toBeGreaterThan(before.get('tui-proj-alpha')!);
    for (const id of ['tui-proj-beta', 'agent-worker-1', 'webui-client-1']) {
      const now = sessions.find((r) => r.id === id)!.participants[0]?.lastSeenAt ?? 0;
      expect(now, `${id} lastSeenAt must be untouched by alpha's heartbeat`).toBe(before.get(id)!);
    }

    // --- Closing ONE (the agent) affects ONLY that one ---
    const closeRes = await fetch(`${daemon.url}/api/sessions/agent-worker-1/close`, { method: 'POST', headers: auth() });
    expect(closeRes.status).toBe(200);
    sessions = await listSessions(daemon.url);
    expect(sessions.find((r) => r.id === 'agent-worker-1')!.status).toBe('closed');
    for (const id of ['tui-proj-alpha', 'tui-proj-beta', 'webui-client-1']) {
      expect(sessions.find((r) => r.id === id)!.status, `${id} must stay active`).toBe('active');
    }

    // --- Restart the daemon (same home): all four survive with their status ---
    await daemon.stop();
    daemon = await bootDaemon({ homeDirectory: home, workingDir: work, daemonHomeDir, port: 0, host: '127.0.0.1', token: TOKEN });
    const restored = await listSessions(daemon.url);
    for (const s of MATRIX) {
      const rec = restored.find((r) => r.id === s.sessionId);
      expect(rec, `session ${s.sessionId} must survive restart`).toBeTruthy();
      expect(rec!.kind).toBe(s.kind);
    }
    expect(restored.find((r) => r.id === 'agent-worker-1')!.status).toBe('closed');
    for (const id of ['tui-proj-alpha', 'tui-proj-beta', 'webui-client-1']) {
      expect(restored.find((r) => r.id === id)!.status, `${id} must survive restart active`).toBe('active');
    }
  });
});
