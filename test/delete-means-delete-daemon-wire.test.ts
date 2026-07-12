/**
 * delete-means-delete-daemon-wire.test.ts
 *
 * DELETE-MEANS-DELETE, proven over a REAL bootDaemon (isolated home,
 * ephemeral port, token auth — the boot-daemon-factory R1 pattern).
 *
 * PART A — companion-chat close vs delete:
 *   - POST .../close soft-closes (history preserved, still gettable).
 *   - DELETE on an ACTIVE companion session is rejected 409 SESSION_ACTIVE.
 *   - DELETE on a CLOSED companion session hard-removes it: the on-disk
 *     record FILE is gone (not merely closed-and-filtered), it 404s on GET,
 *     and it is absent from the list even with includeClosed=true.
 *   - A second DELETE of the same id is an honest 404, never a 200-noop.
 *
 * PART B — the new spine sessions.delete verb:
 *   - DELETE on an ACTIVE shared session is rejected 409 SESSION_ACTIVE.
 *   - DELETE on a CLOSED shared session hard-removes it: 404 on GET, absent
 *     from the list, and the session-deleted lifecycle event fires on the
 *     real session-update SSE channel.
 *   - Unknown id -> 404; a second delete -> 404 (idempotent-honest).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'delete-means-delete-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'w5s1-home-'));
  work = mkdtempSync(join(tmpdir(), 'w5s1-work-'));
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

function companionFilePath(sessionId: string): string {
  return join(home, '.goodvibes', 'companion-chat', 'sessions', `${sessionId}.json`);
}

// ---------------------------------------------------------------------------
// PART A — companion-chat close vs delete
// ---------------------------------------------------------------------------

describe('companion.chat.sessions close vs delete', () => {
  test('POST /close soft-closes: history preserved, still gettable', async () => {
    const createRes = await fetch(`${daemon.url}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'w5s1-companion-close', provider: 'test-provider', model: 'test-model' }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId } = await createRes.json() as { sessionId: string };
    expect(existsSync(companionFilePath(sessionId))).toBe(true);

    const closeRes = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}/close`, {
      method: 'POST',
      headers: auth(),
    });
    expect(closeRes.status).toBe(200);
    const closeBody = await closeRes.json() as { sessionId: string; status: string };
    expect(closeBody.status).toBe('closed');

    // Preserved — still on disk, still gettable.
    expect(existsSync(companionFilePath(sessionId))).toBe(true);
    const getRes = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, { headers: auth() });
    expect(getRes.status).toBe(200);
  });

  test('DELETE on an ACTIVE companion session is rejected 409 SESSION_ACTIVE', async () => {
    const createRes = await fetch(`${daemon.url}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'w5s1-companion-active-delete', provider: 'test-provider', model: 'test-model' }),
    });
    const { sessionId } = await createRes.json() as { sessionId: string };

    const deleteRes = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(deleteRes.status).toBe(409);
    const body = await deleteRes.json() as { code: string };
    expect(body.code).toBe('SESSION_ACTIVE');

    // Untouched by the rejected delete.
    expect(existsSync(companionFilePath(sessionId))).toBe(true);
  });

  test('DELETE on a CLOSED companion session hard-removes the on-disk file and the record', async () => {
    const createRes = await fetch(`${daemon.url}/api/companion/chat/sessions`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ title: 'w5s1-companion-hard-delete', provider: 'test-provider', model: 'test-model' }),
    });
    const { sessionId } = await createRes.json() as { sessionId: string };
    const filePath = companionFilePath(sessionId);
    expect(existsSync(filePath)).toBe(true);

    await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}/close`, { method: 'POST', headers: auth() });
    expect(existsSync(filePath)).toBe(true); // close alone never removes the file

    const deleteRes = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json() as { sessionId: string; deleted: boolean };
    expect(deleteBody).toEqual({ sessionId, deleted: true });

    // The on-disk record file is GONE, not just closed.
    expect(existsSync(filePath)).toBe(false);

    // Absent outright — not merely filtered.
    const getRes = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, { headers: auth() });
    expect(getRes.status).toBe(404);

    const listRes = await fetch(`${daemon.url}/api/companion/chat/sessions?includeClosed=true`, { headers: auth() });
    const listBody = await listRes.json() as { sessions: Array<{ id: string }> };
    expect(listBody.sessions.some((s) => s.id === sessionId)).toBe(false);

    // A second delete of the same id is an honest 404, never a 200-noop.
    const secondDelete = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(secondDelete.status).toBe(404);
    const secondBody = await secondDelete.json() as { code: string };
    expect(secondBody.code).toBe('SESSION_NOT_FOUND');
  });

  test('DELETE of an unknown companion session id is 404', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/ghost-companion-id`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PART B — sessions.delete (the new spine hard-delete verb)
// ---------------------------------------------------------------------------

describe('sessions.delete (spine hard-delete verb)', () => {
  async function registerSpineSession(sessionId: string): Promise<void> {
    const res = await fetch(`${daemon.url}/api/sessions/register`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        sessionId,
        kind: 'tui',
        participant: { surfaceKind: 'tui', surfaceId: `${sessionId}-surface`, lastSeenAt: Date.now() },
      }),
    });
    expect(res.status).toBe(200);
  }

  test('DELETE on an ACTIVE shared session is rejected 409 SESSION_ACTIVE', async () => {
    await registerSpineSession('w5s1-spine-active');

    const res = await fetch(`${daemon.url}/api/sessions/w5s1-spine-active`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('SESSION_ACTIVE');

    const getRes = await fetch(`${daemon.url}/api/sessions/w5s1-spine-active`, { headers: auth() });
    expect(getRes.status).toBe(200);
  });

  test('DELETE on a CLOSED shared session hard-removes it: 404 on get, absent from the list', async () => {
    await registerSpineSession('w5s1-spine-delete');
    await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete/close`, { method: 'POST', headers: auth() });

    const deleteRes = await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json() as { sessionId: string; deleted: boolean };
    expect(body).toEqual({ sessionId: 'w5s1-spine-delete', deleted: true });

    const getRes = await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete`, { headers: auth() });
    expect(getRes.status).toBe(404);

    const listRes = await fetch(`${daemon.url}/api/sessions`, { headers: auth() });
    const listText = await listRes.text();
    expect(listText.includes('w5s1-spine-delete')).toBe(false);
  });

  test('DELETE of an already-deleted / unknown shared session id is an honest 404', async () => {
    await registerSpineSession('w5s1-spine-delete-twice');
    await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete-twice/close`, { method: 'POST', headers: auth() });
    const first = await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete-twice`, { method: 'DELETE', headers: auth() });
    expect(first.status).toBe(200);

    const second = await fetch(`${daemon.url}/api/sessions/w5s1-spine-delete-twice`, { method: 'DELETE', headers: auth() });
    expect(second.status).toBe(404);
    const secondBody = await second.json() as { code: string };
    expect(secondBody.code).toBe('SESSION_NOT_FOUND');

    const ghost = await fetch(`${daemon.url}/api/sessions/ghost-spine-id`, { method: 'DELETE', headers: auth() });
    expect(ghost.status).toBe(404);
  });

  test('deleting a closed shared session emits session-deleted on the real session-update SSE channel', async () => {
    await registerSpineSession('w5s1-spine-sse-delete');
    await fetch(`${daemon.url}/api/sessions/w5s1-spine-sse-delete/close`, { method: 'POST', headers: auth() });

    const ac = new AbortController();
    const streamRes = await fetch(`${daemon.url}/api/control-plane/events`, {
      headers: auth(),
      signal: ac.signal,
    });
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    let sawDeleted = false;
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      // Fire the delete once the stream is open.
      const deletePromise = fetch(`${daemon.url}/api/sessions/w5s1-spine-sse-delete`, {
        method: 'DELETE',
        headers: auth(),
      });

      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const records = buf.split('\n\n');
        buf = records.pop() ?? '';
        for (const rec of records) {
          const dataLine = rec.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as { event?: string; payload?: { sessionId?: string } };
            if (parsed.event === 'session-deleted' && parsed.payload?.sessionId === 'w5s1-spine-sse-delete') {
              sawDeleted = true;
            }
          } catch {
            // non-JSON frame (heartbeat/ready) — ignore
          }
        }
        if (sawDeleted) break;
      }
      await deletePromise;
    } finally {
      clearTimeout(timer);
      ac.abort();
      await reader.cancel().catch(() => {});
    }

    expect(sawDeleted).toBe(true);
  });
});
