/**
 * inbound-mail-cursor-store.test.ts
 *
 * The custody rules for the per-mailbox IMAP cursor (docs/inbound-email.md §4,
 * §9.1), proven against the real store on a real temp directory:
 *
 *  - The cursor survives a restart and resumes above `lastSeenUid`.
 *  - A corrupt, oversized, or de-configured-account cursor record is
 *    discarded, NOT repaired.
 *  - A UIDVALIDITY change discards the stored cursor and re-establishes at
 *    the caller-supplied high-water mark rather than replaying the mailbox.
 *  - A first run establishes the mark and reports the skip count rather than
 *    backfilling.
 *  - The cursor only moves when `advance()` is called — a crash between
 *    fetch and completion leaves it where it was, so recovery re-fetches
 *    rather than skips.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAILBOX_CURSOR_POLICY,
  MailboxCursorStore,
  validateMailboxCursor,
  type CursorSweepReport,
} from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import type { MailboxCursor } from '../packages/sdk/src/platform/email/inbound/types.ts';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-cursor-'));
  storePath = join(dir, 'inbound-mail-cursors.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(cursors: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ version: 1, cursors }, null, 2)}\n`, 'utf-8');
}

function readStored(): unknown[] {
  const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as { cursors: unknown[] };
  return parsed.cursors;
}

function validCursor(overrides: Partial<MailboxCursor> = {}): MailboxCursor {
  return {
    account: 'acct-1',
    mailbox: 'INBOX',
    uidValidity: 1000,
    lastSeenUid: 50,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Round-trip across a restart
// ---------------------------------------------------------------------------
describe('the cursor survives a restart', () => {
  test('resumes above lastSeenUid after resolve() + advance(), reopened as a fresh store instance', async () => {
    const first = new MailboxCursorStore(storePath);
    const resolution = await first.resolve({
      account: 'acct-1',
      mailbox: 'INBOX',
      serverUidValidity: 100,
      currentHighestUid: 50,
      currentMessageCount: 50,
    });
    expect(resolution.kind).toBe('first-run');
    await first.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 100, lastSeenUid: 55 });

    // A brand-new store instance over the same file, as a restarted process would be.
    const restarted = new MailboxCursorStore(storePath);
    const cursor = await restarted.get('acct-1', 'INBOX');
    expect(cursor?.lastSeenUid).toBe(55);
    expect(cursor?.uidValidity).toBe(100);
  });

  test('lastSeenUid of 0 is valid and survives — the only honest value for an empty mailbox on first run', async () => {
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolve({
      account: 'acct-empty',
      mailbox: 'INBOX',
      serverUidValidity: 5,
      currentHighestUid: 0,
      currentMessageCount: 0,
    });
    expect(resolution.cursor.lastSeenUid).toBe(0);
    const reopened = new MailboxCursorStore(storePath);
    const cursor = await reopened.get('acct-empty', 'INBOX');
    expect(cursor?.lastSeenUid).toBe(0);
    expect(validateMailboxCursor(cursor)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validate by content — never repair
// ---------------------------------------------------------------------------
describe('a corrupt, oversized, or stale record is discarded, not repaired', () => {
  test('validateMailboxCursor refuses each broken field independently', () => {
    expect(validateMailboxCursor(null)).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), account: '' })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), mailbox: 'x'.repeat(513) })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), uidValidity: 0 })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), uidValidity: -5 })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), uidValidity: 1.5 })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), lastSeenUid: -1 })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), lastSeenUid: 'not-a-number' })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), updatedAt: 'not-a-date' })).toBeNull();
    expect(validateMailboxCursor({ ...validCursor(), updatedAt: 'x'.repeat(100) })).toBeNull();
    // A record coerced to lastSeenUid 0 must never be manufactured by validation —
    // it must be dropped outright, or a corrupt cursor would replay the whole mailbox.
    expect(validateMailboxCursor({ account: 'a', mailbox: 'b', uidValidity: 'garbage', lastSeenUid: 0, updatedAt: new Date().toISOString() })).toBeNull();
  });

  test('a torn record is dropped on load; the valid sibling survives', async () => {
    seed([{ account: 'torn' }, validCursor({ account: 'ok' })]);
    const store = new MailboxCursorStore(storePath);
    const live = await store.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.account).toBe('ok');
  });

  test('sweep discloses the malformed count and never repairs it into a usable cursor', async () => {
    seed([{ account: 'torn', mailbox: 'INBOX', uidValidity: 'nope' }, validCursor({ account: 'ok' })]);
    const store = new MailboxCursorStore(storePath);
    const report = await store.sweep('manual');
    expect(report.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.retained).toBe(1);
    expect(readStored()).toHaveLength(1);
  });

  test('a cursor for an account no longer configured is reaped, not honoured', async () => {
    seed([validCursor({ account: 'gone' }), validCursor({ account: 'kept' })]);
    const store = new MailboxCursorStore(storePath, { isAccountConfigured: (account) => account === 'kept' });
    const report = await store.runRecoverySweep();
    expect(report.removed).toEqual([
      expect.objectContaining({ account: 'gone', reason: 'account-not-configured' }),
    ]);
    expect((await store.list()).map((c) => c.account)).toEqual(['kept']);
  });

  test('the defensive count cap reaps the oldest cursors past the bound', async () => {
    const seeds = Array.from({ length: 5 }, (_, i) =>
      validCursor({ account: `acct-${String(i)}`, updatedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString() }));
    seed(seeds);
    const store = new MailboxCursorStore(storePath, { policy: { maxCursors: 3 } });
    const report: CursorSweepReport = await store.sweep('manual');
    expect(report.removed.filter((r) => r.reason === 'over-cap')).toHaveLength(2);
    expect(report.retained).toBe(3);
    const remaining = (await store.list()).map((c) => c.account).sort();
    expect(remaining).toEqual(['acct-2', 'acct-3', 'acct-4']);
  });
});

// ---------------------------------------------------------------------------
// UIDVALIDITY change and first-run: never replay
// ---------------------------------------------------------------------------
describe('resolve() never replays the mailbox', () => {
  test('a first run establishes the mark at the current high-water mark and reports the skip count', async () => {
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolve({
      account: 'acct-1',
      mailbox: 'INBOX',
      serverUidValidity: 7,
      currentHighestUid: 42,
      currentMessageCount: 42,
    });
    expect(resolution.kind).toBe('first-run');
    expect(resolution.cursor.lastSeenUid).toBe(42);
    expect(resolution.skippedMessageCount).toBe(42);
    expect(resolution.previous).toBeUndefined();
  });

  test('a matching UIDVALIDITY resumes the stored cursor unchanged', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 7, currentHighestUid: 42, currentMessageCount: 42 });
    await store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 7, lastSeenUid: 60 });
    const resolution = await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 7, currentHighestUid: 999, currentMessageCount: 999 });
    expect(resolution.kind).toBe('resumed');
    expect(resolution.cursor.lastSeenUid).toBe(60); // NOT 999 — the stored cursor stands.
    expect(resolution.skippedMessageCount).toBe(0);
  });

  test('a UIDVALIDITY change discards the old cursor and re-establishes at the new high-water mark, never replaying', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 1, currentHighestUid: 100, currentMessageCount: 100 });
    await store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 100 });

    const resolution = await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 2, currentHighestUid: 5, currentMessageCount: 5 });
    expect(resolution.kind).toBe('uid-validity-changed');
    expect(resolution.cursor.uidValidity).toBe(2);
    expect(resolution.cursor.lastSeenUid).toBe(5); // Established fresh, not backfilled from the old 100.
    expect(resolution.skippedMessageCount).toBe(5);
    expect(resolution.previous?.uidValidity).toBe(1);
    expect(resolution.previous?.lastSeenUid).toBe(100);

    // The change is persisted immediately — a fresh instance sees the new cursor, not the old one.
    const reopened = new MailboxCursorStore(storePath);
    const cursor = await reopened.get('acct-1', 'INBOX');
    expect(cursor?.uidValidity).toBe(2);
    expect(cursor?.lastSeenUid).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// advance() is the only thing that moves the cursor
// ---------------------------------------------------------------------------
describe('the cursor advances only after processing completes', () => {
  test('advance() without a prior resolve() is refused rather than silently creating a cursor', async () => {
    const store = new MailboxCursorStore(storePath);
    await expect(store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 10 })).rejects.toThrow('resolve() first');
  });

  test('advance() under a stale UIDVALIDITY is refused rather than silently accepted', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 1, currentHighestUid: 10, currentMessageCount: 10 });
    await expect(store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 2, lastSeenUid: 20 })).rejects.toThrow('UIDVALIDITY mismatch');
  });

  test('a crash between fetch and advance() leaves the cursor where it was, so recovery re-fetches rather than skips', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 1, currentHighestUid: 10, currentMessageCount: 10 });
    // Simulate: new mail (UID 11) was fetched but processing crashed before advance() ran.
    const beforeCrash = await store.get('acct-1', 'INBOX');
    // No advance() call here — this is the crash.
    const afterRestart = new MailboxCursorStore(storePath);
    const cursor = await afterRestart.get('acct-1', 'INBOX');
    expect(cursor?.lastSeenUid).toBe(beforeCrash?.lastSeenUid);
    expect(cursor?.lastSeenUid).toBe(10); // UID 11 was never marked processed — a UID SEARCH UID 11:* refetches it.
  });

  test('advance() never moves the cursor backwards, so a late write cannot resurrect handled mail', async () => {
    // `advance` clamps with Math.max(existing, incoming), and nothing tested
    // that. It is the rule the watcher now depends on rather than recomputing:
    // it takes the store's returned cursor as the answer instead of building
    // `{ ...current, lastSeenUid: uid }` itself, which is what the two
    // declarations used to disagree about.
    //
    // Without the clamp, a write arriving out of order — a retried pass after
    // a reconnect, a slow advance overtaken by a faster one — drags the
    // high-water mark back down, and every message between the two marks is
    // fetched and announced to the owner a second time.
    const store = new MailboxCursorStore(storePath);
    await store.resolve({ account: 'acct-1', mailbox: 'INBOX', serverUidValidity: 1, currentHighestUid: 10, currentMessageCount: 10 });
    await store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 40 });

    const stale = await store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 25 });
    expect(stale.lastSeenUid).toBe(40);
    expect((await store.get('acct-1', 'INBOX'))?.lastSeenUid).toBe(40);

    // And it still moves forward, so the clamp is not merely pinning the cursor.
    const forward = await store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 41 });
    expect(forward.lastSeenUid).toBe(41);
  });
});

describe('the default policy', () => {
  test('is exported for callers to inspect', () => {
    expect(DEFAULT_MAILBOX_CURSOR_POLICY.maxCursors).toBeGreaterThan(0);
  });
});
