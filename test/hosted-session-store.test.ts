/**
 * hosted-session-store.test.ts
 *
 * The durability half of the hosted-session engine, against a real directory.
 *
 * What is checked is the standing treatment for anything persisted, one
 * property per test: a bound that actually bounds, a validator that rejects
 * what cannot be rebuilt (and keeps it where it can be looked at), a sweep that
 * retires what is past its retention, and a load report that says what happened
 * instead of leaving it in a log line.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HostedSessionStore,
  boundMessages,
  describeInvalidPersistedHostedSession,
} from '../packages/sdk/src/platform/hosted-sessions/store.ts';
import type { HostedSessionRecord } from '../packages/sdk/src/platform/hosted-sessions/types.ts';

let dir: string;

const LIMITS = {
  maxSessions: 3,
  maxMessagesPerSession: 4,
  terminatedRetentionMs: 1_000,
};

function record(overrides: Partial<HostedSessionRecord> & { id: string }): HostedSessionRecord {
  return {
    workspaceRoot: '/tmp/workspace',
    title: 'a session',
    status: 'idle',
    detachPolicy: null,
    effectiveDetachPolicy: 'kill',
    attachedClients: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    turnCount: 0,
    messageCount: 0,
    restoredFromDisk: false,
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hosted-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a persisted transcript is bounded to the most recent messages', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  const messages = [1, 2, 3, 4, 5, 6].map((n) => ({ role: 'user', content: `m${n}` }));
  await store.save(record({ id: 'a' }), { messages, title: 'a session' });

  const loaded = await store.load(1_000);
  expect(loaded.restored).toHaveLength(1);
  const persisted = loaded.restored[0]!.conversation as { messages: { content: string }[] };
  // The TAIL is what a reattach needs, so the tail is what survives.
  expect(persisted.messages.map((m) => m.content)).toEqual(['m3', 'm4', 'm5', 'm6']);
});

test('boundMessages keeps everything when it is already within the bound', () => {
  const messages = [1, 2].map((n) => ({ n }));
  expect(boundMessages(messages, 4)).toBe(messages);
  expect(boundMessages(messages, 0)).toBe(messages);
});

test('a conversation payload the store does not understand passes through untouched', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await store.save(record({ id: 'a' }), 'not an object');
  const loaded = await store.load(1_000);
  expect(loaded.restored[0]!.conversation).toBe('not an object');
});

test('an unusable file is rejected with a reason and moved aside rather than dropped', async () => {
  writeFileSync(join(dir, 'broken.json'), '{ this is not json');
  writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ version: 1, record: { id: 'x' } }));
  writeFileSync(join(dir, 'old-version.json'), JSON.stringify({ version: 99, record: record({ id: 'y' }), conversation: null }));

  const store = new HostedSessionStore(dir, LIMITS);
  const loaded = await store.load(1_000);

  expect(loaded.restored).toHaveLength(0);
  expect(loaded.rejected.map((entry) => entry.file).sort()).toEqual(['broken.json', 'old-version.json', 'wrong-shape.json']);
  // Every rejection names WHY, not just that it happened.
  for (const entry of loaded.rejected) expect(entry.reason.length).toBeGreaterThan(0);
  // And the bytes are still there to look at.
  const remaining = readdirSync(dir).sort();
  expect(remaining).toEqual(['broken.json.rejected', 'old-version.json.rejected', 'wrong-shape.json.rejected']);
});

test('the validator names the specific thing that is wrong', () => {
  expect(describeInvalidPersistedHostedSession(null)).toBe('not a JSON object');
  expect(describeInvalidPersistedHostedSession({ version: 2 })).toContain('unsupported version');
  expect(describeInvalidPersistedHostedSession({ version: 1 })).toContain('missing the session record');
  expect(describeInvalidPersistedHostedSession({ version: 1, record: { id: '../escape' } }))
    .toContain('not a safe file name');
  expect(describeInvalidPersistedHostedSession({ version: 1, record: { id: 'ok' } }))
    .toContain('workspace root');
  expect(describeInvalidPersistedHostedSession({ version: 1, record: { id: 'ok', workspaceRoot: '/w', status: 'weird' } }))
    .toContain('unknown session status');
  expect(describeInvalidPersistedHostedSession({ version: 1, record: { id: 'ok', workspaceRoot: '/w', status: 'idle' } }))
    .toContain('timestamps');
  expect(describeInvalidPersistedHostedSession({
    version: 1,
    record: { id: 'ok', workspaceRoot: '/w', status: 'idle', createdAt: 1, updatedAt: 1 },
  })).toBeNull();
});

test('a session id that is not a safe file name is refused at the write, not at the read', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await expect(store.save(record({ id: '../../etc/passwd' }), null)).rejects.toThrow(/not a safe file name/);
  expect(readdirSync(dir)).toHaveLength(0);
});

test('terminated sessions past their retention are swept and reported', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await store.save(record({ id: 'fresh', status: 'terminated', terminatedAt: 5_000 }), null);
  await store.save(record({ id: 'stale', status: 'terminated', terminatedAt: 1_000 }), null);

  const loaded = await store.load(5_500);
  expect(loaded.swept).toEqual(['stale']);
  expect(loaded.restored.map((s) => s.record.id)).toEqual(['fresh']);
  expect(existsSync(join(dir, 'stale.json'))).toBe(false);
});

test('a live session is never swept, however old it is', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await store.save(record({ id: 'ancient', status: 'idle', updatedAt: 1 }), null);
  const loaded = await store.load(10_000_000);
  expect(loaded.swept).toEqual([]);
  expect(loaded.restored.map((s) => s.record.id)).toEqual(['ancient']);
});

test('the directory is bounded, and terminated records are evicted before live ones', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  // Four files against a cap of three. The terminated one is the oldest kind of
  // history, so it goes first even though it was touched most recently.
  await store.save(record({ id: 'live-old', updatedAt: 10 }), null);
  await store.save(record({ id: 'live-mid', updatedAt: 20 }), null);
  await store.save(record({ id: 'live-new', updatedAt: 30 }), null);
  await store.save(record({ id: 'done', status: 'terminated', terminatedAt: 9_999, updatedAt: 40 }), null);

  const loaded = await store.load(10_000);
  expect(loaded.evicted).toEqual(['done']);
  expect(loaded.restored.map((s) => s.record.id).sort()).toEqual(['live-mid', 'live-new', 'live-old']);
  expect(existsSync(join(dir, 'done.json'))).toBe(false);
});

test('an unreadable directory loads as empty rather than throwing', async () => {
  const store = new HostedSessionStore(join(dir, 'a-file-not-a-dir', 'nested'), LIMITS);
  writeFileSync(join(dir, 'a-file-not-a-dir'), 'blocking the path');
  const loaded = await store.load(1_000);
  expect(loaded.restored).toEqual([]);
  expect(loaded.rejected).toEqual([]);
});

test('the explicit sweep retires exactly the terminated records past retention', async () => {
  const store = new HostedSessionStore(dir, LIMITS);
  await store.save(record({ id: 'a', status: 'terminated', terminatedAt: 1_000 }), null);
  await store.save(record({ id: 'b', status: 'idle' }), null);

  const retired = await store.sweep([
    record({ id: 'a', status: 'terminated', terminatedAt: 1_000 }),
    record({ id: 'b', status: 'idle' }),
  ], 5_000);
  expect(retired).toEqual(['a']);
  expect(existsSync(join(dir, 'a.json'))).toBe(false);
  expect(existsSync(join(dir, 'b.json'))).toBe(true);
});
