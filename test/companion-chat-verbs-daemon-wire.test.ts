/**
 * companion-chat-verbs-daemon-wire.test.ts
 *
 * The two new companion chat verbs — regenerate (companion.chat.messages.retry)
 * and edit-and-branch (companion.chat.messages.edit) — proven over a REAL
 * bootDaemon (isolated home, ephemeral port, token auth), through BOTH the
 * direct HTTP routes and the generic control-plane invoke endpoint.
 *
 * Because a bootDaemon has no configured model provider, the re-run turn itself
 * cannot produce new assistant text here (that full happy path is proven with a
 * mock provider in companion-chat-branching.test.ts). What this file proves over
 * the wire is the honesty-load-bearing half that runs synchronously, before any
 * turn: the LINEAGE. A seeded on-disk conversation (loaded by the real daemon at
 * boot) is regenerated / edited, and we assert the predecessor is RETAINED —
 * still returned by the messages endpoint, flagged superseded — never silently
 * gone; plus the closed-session and deleted-session refusals carry the honest
 * machine codes.
 *
 * Never touches the user's real daemons on 3421/4444 — ephemeral port 0 only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootedDaemon } from '../packages/sdk/src/platform/daemon/boot.ts';

const TOKEN = 'chat-verbs-token';
let home: string;
let work: string;
let daemon: BootedDaemon;

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...extra };
}

interface SeedMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * Write a companion-chat session file to the daemon's home BEFORE boot, so the
 * real daemon loads it during init() and serves it over the wire. Returns the
 * session id.
 */
function seedSession(sessionId: string, messages: readonly SeedMessage[]): void {
  const dir = join(home, '.goodvibes', 'companion-chat', 'sessions');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const persisted = {
    meta: {
      id: sessionId,
      kind: 'companion-chat',
      title: 'seeded',
      model: 'seed-model',
      provider: 'seed-provider',
      systemPrompt: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      messageCount: messages.length,
    },
    messages: messages.map((m) => ({
      id: m.id,
      sessionId,
      role: m.role,
      content: m.content,
      attachments: [],
      createdAt: now,
    })),
  };
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(persisted, null, 2) + '\n', 'utf-8');
}

interface WireMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly supersededAt?: number;
  readonly supersededReason?: string;
  readonly revisionOf?: string;
}

async function getMessages(sessionId: string): Promise<WireMessage[]> {
  const res = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}/messages`, { headers: auth() });
  expect(res.status).toBe(200);
  const body = await res.json() as { messages: WireMessage[] };
  return body.messages;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'chatverbs-home-'));
  work = mkdtempSync(join(tmpdir(), 'chatverbs-work-'));
  // Seed conversations the real daemon will load at boot.
  seedSession('seed-regen', [
    { id: 'u1', role: 'user', content: 'What is the capital of France?' },
    { id: 'a1', role: 'assistant', content: 'The capital of France is Paris.' },
  ]);
  seedSession('seed-edit', [
    { id: 'u1', role: 'user', content: 'Tell me about cats' },
    { id: 'a1', role: 'assistant', content: 'Cats are small carnivorous mammals.' },
  ]);
  seedSession('seed-regen-invoke', [
    { id: 'u1', role: 'user', content: 'Ping?' },
    { id: 'a1', role: 'assistant', content: 'Pong.' },
  ]);
  seedSession('seed-closed', [
    { id: 'u1', role: 'user', content: 'hi' },
    { id: 'a1', role: 'assistant', content: 'hello' },
  ]);
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

// ---------------------------------------------------------------------------
// regenerate (companion.chat.messages.retry) over the HTTP route
// ---------------------------------------------------------------------------

describe('companion.chat.messages.retry — regenerate over the wire', () => {
  test('the seeded conversation loaded from disk is served', async () => {
    const messages = await getMessages('seed-regen');
    expect(messages.map((m) => m.content)).toEqual([
      'What is the capital of France?',
      'The capital of France is Paris.',
    ]);
  });

  test('regenerate supersedes the prior response (retained, retrievable) — never silently gone', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-regen/messages/retry`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as {
      sessionId: string; regeneratedFrom: string; supersededMessageIds: string[]; turnStarted: boolean;
    };
    expect(body.sessionId).toBe('seed-regen');
    expect(body.regeneratedFrom).toBe('a1');
    expect(body.supersededMessageIds).toContain('a1');
    expect(body.turnStarted).toBe(true);

    // The old response is RETAINED and RETRIEVABLE — still returned, flagged superseded.
    const messages = await getMessages('seed-regen');
    const old = messages.find((m) => m.id === 'a1');
    expect(old).toBeDefined();
    expect(old!.content).toBe('The capital of France is Paris.');
    expect(typeof old!.supersededAt).toBe('number');
    expect(old!.supersededReason).toBe('regenerate');

    // The user prompt is untouched (regenerate re-runs from it).
    const user = messages.find((m) => m.id === 'u1');
    expect(user!.supersededAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// edit-and-branch (companion.chat.messages.edit) over the HTTP route
// ---------------------------------------------------------------------------

describe('companion.chat.messages.edit — edit + branch over the wire', () => {
  test('edit supersedes the original (retained) and appends a branch with revisionOf', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-edit/messages/edit`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ messageId: 'u1', content: 'Tell me about dogs' }),
    });
    expect(res.status).toBe(202);
    const body = await res.json() as {
      sessionId: string; editedFrom: string; messageId: string; supersededMessageIds: string[]; turnStarted: boolean;
    };
    expect(body.editedFrom).toBe('u1');
    expect(body.messageId).not.toBe('u1');
    expect(body.supersededMessageIds).toEqual(expect.arrayContaining(['u1', 'a1']));

    const messages = await getMessages('seed-edit');
    // Original user message retained + superseded — retrievable history.
    const originalUser = messages.find((m) => m.id === 'u1')!;
    expect(originalUser.content).toBe('Tell me about cats');
    expect(typeof originalUser.supersededAt).toBe('number');
    expect(originalUser.supersededReason).toBe('edit');
    // The prior assistant answer is retained too.
    const originalAssistant = messages.find((m) => m.id === 'a1')!;
    expect(typeof originalAssistant.supersededAt).toBe('number');

    // New user message: edited content, linked back to the original.
    const branched = messages.find((m) => m.id === body.messageId)!;
    expect(branched.role).toBe('user');
    expect(branched.content).toBe('Tell me about dogs');
    expect(branched.revisionOf).toBe('u1');
    expect(branched.supersededAt).toBeUndefined();
  });

  test('edit without a messageId is an honest 400 INVALID_INPUT', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-edit/messages/edit`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ content: 'no target' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// The generic control-plane invoke endpoint dispatches the verb by id
// ---------------------------------------------------------------------------

describe('companion.chat.messages.retry — via the control-plane invoke endpoint', () => {
  test('POST /api/control-plane/methods/companion.chat.messages.retry/invoke works and preserves lineage', async () => {
    const res = await fetch(
      `${daemon.url}/api/control-plane/methods/companion.chat.messages.retry/invoke`,
      {
        method: 'POST',
        headers: auth(),
        // The generic invoke endpoint takes the { query?, body } envelope.
        body: JSON.stringify({ body: { sessionId: 'seed-regen-invoke' } }),
      },
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { regeneratedFrom: string; supersededMessageIds: string[] };
    expect(body.regeneratedFrom).toBe('a1');
    expect(body.supersededMessageIds).toContain('a1');

    const messages = await getMessages('seed-regen-invoke');
    const old = messages.find((m) => m.id === 'a1')!;
    expect(typeof old.supersededAt).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// closed / deleted / unknown session refusals with the machine codes
// ---------------------------------------------------------------------------

describe('closed / deleted / unknown session refusals', () => {
  test('regenerate + edit on a CLOSED session are refused 409 SESSION_CLOSED', async () => {
    const closeRes = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-closed/close`, {
      method: 'POST', headers: auth(),
    });
    expect(closeRes.status).toBe(200);

    const retry = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-closed/messages/retry`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(retry.status).toBe(409);
    expect((await retry.json() as { code: string }).code).toBe('SESSION_CLOSED');

    const edit = await fetch(`${daemon.url}/api/companion/chat/sessions/seed-closed/messages/edit`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ messageId: 'u1', content: 'x' }),
    });
    expect(edit.status).toBe(409);
    expect((await edit.json() as { code: string }).code).toBe('SESSION_CLOSED');
  });

  test('regenerate on a DELETED session is refused 404 SESSION_NOT_FOUND', async () => {
    // Create → close → delete a companion session over the wire, then regenerate.
    const createRes = await fetch(`${daemon.url}/api/companion/chat/sessions`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ title: 't', provider: 'p', model: 'm' }),
    });
    const { sessionId } = await createRes.json() as { sessionId: string };
    await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}/close`, { method: 'POST', headers: auth() });
    const del = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}`, { method: 'DELETE', headers: auth() });
    expect(del.status).toBe(200);

    const retry = await fetch(`${daemon.url}/api/companion/chat/sessions/${sessionId}/messages/retry`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(retry.status).toBe(404);
    expect((await retry.json() as { code: string }).code).toBe('SESSION_NOT_FOUND');
  });

  test('regenerate on an UNKNOWN session is refused 404 SESSION_NOT_FOUND', async () => {
    const res = await fetch(`${daemon.url}/api/companion/chat/sessions/ghost-session/messages/retry`, {
      method: 'POST', headers: auth(), body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect((await res.json() as { code: string }).code).toBe('SESSION_NOT_FOUND');
  });
});
