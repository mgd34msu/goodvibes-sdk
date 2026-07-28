/**
 * inbound-mail-cursor-store.test.ts
 *
 * The custody rules for the per-mailbox cursor (docs/inbound-email.md §4,
 * §3.4d, §9.1), proven against the real store on a real temp directory:
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
 *  - The Gmail half of the same rules: a `historyId` survives a restart
 *    BYTE-IDENTICAL (it is a uint64 string and a trip through `Number` would
 *    silently move the position), a `history-expired` reset re-establishes
 *    without replaying, and the two shapes are never read as one another.
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
import type { GmailMailboxCursor } from '../packages/sdk/src/platform/email/inbound/source-cursor.ts';

/** The uint64 ceiling. `Number('18446744073709551615')` is 18446744073709552000. */
const UINT64_MAX = '18446744073709551615';
/** 2^53 + 1: the smallest integer a JS number cannot represent. */
const BEYOND_SAFE_INTEGER = '9007199254740993';

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

  /**
   * "The config has not loaded yet" is not "this account is gone".
   *
   * The reap predicate answered `boolean`, so a caller that could not yet know
   * had to pick one — and picking `false` costs mail with no trace. The cursor
   * is reaped; the next `resolve()` answers `first-run` at the mailbox's
   * CURRENT high-water mark; every message in between is skipped, not
   * replayed; and the owner is told the mailbox started fresh, which is
   * exactly what a genuine first run looks like. Seeded at UID 900 against a
   * mailbox at 1500, that is 600 messages nobody ever sees.
   *
   * These drive that whole sequence rather than asserting the predicate in
   * isolation, because the damage is in the sequence.
   */
  describe('an unanswerable configured-account question keeps the cursor', () => {
    test("'unknown' retains the cursor and discloses that it was not confirmed", async () => {
      seed([validCursor({ account: 'acct-a', lastSeenUid: 900 })]);
      const store = new MailboxCursorStore(storePath, { isAccountConfigured: () => 'unknown' });

      const report = await store.runRecoverySweep();

      expect(report.removed).toEqual([]);
      expect(report.retained).toBe(1);
      // Kept, and SAID to have been kept for a reason nobody could confirm.
      expect(report.unresolvedAccounts).toBe(1);
      expect(readStored()).toHaveLength(1);
      expect((await store.list()).map((c) => c.account)).toEqual(['acct-a']);
    });

    test('and the position survives, so resolve() resumes rather than starting fresh', async () => {
      seed([validCursor({ account: 'acct-a', mailbox: 'INBOX', uidValidity: 7, lastSeenUid: 900 })]);
      const store = new MailboxCursorStore(storePath, { isAccountConfigured: () => 'unknown' });
      await store.runRecoverySweep();

      // The mailbox moved on to 1500 while nobody could answer. Resuming means
      // 901..1500 are still to be read; a first run means they are gone, and
      // the two are indistinguishable from the answer alone.
      const resolution = await store.resolve({
        account: 'acct-a',
        mailbox: 'INBOX',
        serverUidValidity: 7,
        currentHighestUid: 1500,
        currentMessageCount: 600,
      });

      expect(resolution.kind).toBe('resumed');
      expect(resolution.cursor.lastSeenUid).toBe(900);
    });

    test('a definite no still reaps, so the sentinel did not disable the rule', async () => {
      seed([validCursor({ account: 'gone' }), validCursor({ account: 'kept' })]);
      const store = new MailboxCursorStore(storePath, {
        isAccountConfigured: (account) => account === 'kept',
      });
      const report = await store.runRecoverySweep();
      expect(report.removed.map((r) => r.account)).toEqual(['gone']);
      expect(report.unresolvedAccounts).toBe(0);
    });

    test('the three answers are three outcomes in one pass', async () => {
      seed([
        validCursor({ account: 'yes' }),
        validCursor({ account: 'no' }),
        validCursor({ account: 'dont-know' }),
      ]);
      const store = new MailboxCursorStore(storePath, {
        isAccountConfigured: (account) => {
          if (account === 'yes') return true;
          if (account === 'no') return false;
          return 'unknown';
        },
      });
      const report = await store.runRecoverySweep();
      expect(report.removed.map((r) => r.account)).toEqual(['no']);
      expect(report.unresolvedAccounts).toBe(1);
      expect((await store.list()).map((c) => c.account).sort()).toEqual(['dont-know', 'yes']);
    });
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

// ---------------------------------------------------------------------------
// The Gmail half — the same rules, a position that is not a number
// ---------------------------------------------------------------------------

function validGmailCursor(overrides: Partial<GmailMailboxCursor> = {}): GmailMailboxCursor {
  return {
    source: 'gmail',
    account: 'acct-1',
    mailbox: 'INBOX',
    historyId: '1234567',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('a Gmail historyId survives a restart byte-identical', () => {
  test('resolveGmail() establishes at the current historyId and re-reads unchanged', async () => {
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolveGmail({
      account: 'acct-1',
      mailbox: 'INBOX',
      currentHistoryId: '987654321',
    });
    expect(resolution.kind).toBe('first-run');
    expect(resolution.cursor.historyId).toBe('987654321');
    expect(resolution.previous).toBeUndefined();

    const reopened = new MailboxCursorStore(storePath);
    const cursor = await reopened.getGmail('acct-1', 'INBOX');
    expect(cursor?.historyId).toBe('987654321');
    expect(cursor?.source).toBe('gmail');
  });

  test.each([
    ['the uint64 maximum', UINT64_MAX],
    ['a value Number() would round off', BEYOND_SAFE_INTEGER],
  ])('%s survives resolve, advance and reload with every digit intact', async (_label, historyId) => {
    // The premise: these are exactly the values a numeric round-trip corrupts.
    // If the store ever parses one, this test tells us which digit moved.
    expect(String(Number(historyId))).not.toBe(historyId);

    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '1' });
    const advanced = await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId });
    expect(advanced.historyId).toBe(historyId);

    // Byte-identical ON DISK, not merely equal after a reparse of our own.
    const raw = readStored()[0] as Record<string, unknown>;
    expect(raw.historyId).toBe(historyId);
    expect(readFileSync(storePath, 'utf-8')).toContain(`"${historyId}"`);

    const reopened = new MailboxCursorStore(storePath);
    expect((await reopened.getGmail('acct-1', 'INBOX'))?.historyId).toBe(historyId);
  });
});

describe('the two shapes are never read as one another', () => {
  test('get() answers null when only a Gmail cursor holds that key', async () => {
    seed([validGmailCursor()]);
    const store = new MailboxCursorStore(storePath);
    expect(await store.get('acct-1', 'INBOX')).toBeNull();
    expect((await store.getGmail('acct-1', 'INBOX'))?.historyId).toBe('1234567');
  });

  test('getGmail() answers null when only an IMAP cursor holds that key', async () => {
    seed([validCursor()]);
    const store = new MailboxCursorStore(storePath);
    expect(await store.getGmail('acct-1', 'INBOX')).toBeNull();
    expect((await store.get('acct-1', 'INBOX'))?.lastSeenUid).toBe(50);
  });

  test('a stored record with no source field reads as IMAP — the one documented leniency', async () => {
    // The only shape that existed before the union. Every IMAP field is still
    // validated on the way in; a Gmail record can never take this path because
    // it carries `source` explicitly.
    const withoutSource = validCursor();
    expect('source' in withoutSource).toBe(false);
    seed([withoutSource]);
    const store = new MailboxCursorStore(storePath);
    const cursor = await store.get('acct-1', 'INBOX');
    expect(cursor?.lastSeenUid).toBe(50);
    expect(cursor?.uidValidity).toBe(1000);
    expect(await store.getGmail('acct-1', 'INBOX')).toBeNull();
  });

  test('a record naming an unknown source is discarded, never coerced into either shape', async () => {
    seed([
      { ...validCursor(), source: 'exchange-ews' },
      { ...validGmailCursor({ account: 'acct-2' }), source: 'jmap' },
      validCursor({ account: 'kept' }),
    ]);
    const store = new MailboxCursorStore(storePath);
    expect((await store.list()).map((c) => c.account)).toEqual(['kept']);
    expect(await store.get('acct-1', 'INBOX')).toBeNull();
    expect(await store.getGmail('acct-2', 'INBOX')).toBeNull();

    const report = await store.sweep('manual');
    expect(report.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.retained).toBe(1);
  });

  test('advance() refuses a key held by a Gmail cursor rather than writing a UID onto it', async () => {
    seed([validGmailCursor()]);
    const store = new MailboxCursorStore(storePath);
    await expect(store.advance({ account: 'acct-1', mailbox: 'INBOX', uidValidity: 1, lastSeenUid: 10 }))
      .rejects.toThrow('resolve() first');
  });

  test('advanceGmail() refuses a key held by an IMAP cursor', async () => {
    seed([validCursor()]);
    const store = new MailboxCursorStore(storePath);
    await expect(store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '99' }))
      .rejects.toThrow('resolveGmail() first');
  });

  test('a write for one source REPLACES the other source\'s record for that key, leaving exactly one', async () => {
    // A mailbox is served by one source at a time, so the loser is a position
    // that names nothing. Keeping it would leave a mark in the file that no
    // code path can honour and that a later switch back would resume from.
    seed([validCursor()]);
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '500' });
    expect(resolution.kind).toBe('first-run'); // Not `history-expired`: there was no Gmail position.
    expect(readStored()).toHaveLength(1);
    expect(await store.get('acct-1', 'INBOX')).toBeNull();
    expect((await store.getGmail('acct-1', 'INBOX'))?.historyId).toBe('500');
  });
});

describe('resolveGmail() never replays', () => {
  test('a first run establishes at the current historyId and does not backfill', async () => {
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '4242' });
    expect(resolution.kind).toBe('first-run');
    expect(resolution.cursor.historyId).toBe('4242'); // Not '0', not '1'.
  });

  test('a stored cursor resumes unchanged even though the mailbox has moved on', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '100' });
    const resolution = await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '999' });
    expect(resolution.kind).toBe('resumed');
    expect(resolution.cursor.historyId).toBe('100'); // NOT 999 — the delta between them is ours to fetch.
    expect(resolution.previous).toBeUndefined();
  });

  test('history-expired re-establishes at the current historyId and does NOT replay', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '100' });
    await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '150' });

    // Gmail answered 404 / resync-required for startHistoryId=150.
    const resolution = await store.resolveGmail({
      account: 'acct-1',
      mailbox: 'INBOX',
      currentHistoryId: '900000',
      historyExpired: true,
    });
    expect(resolution.kind).toBe('history-expired');
    // The new mark is the CURRENT high-water mark. Anything lower would replay
    // a week of mail at the owner because a retention window lapsed.
    expect(resolution.cursor.historyId).toBe('900000');
    expect(resolution.previous?.historyId).toBe('150');

    const reopened = new MailboxCursorStore(storePath);
    expect((await reopened.getGmail('acct-1', 'INBOX'))?.historyId).toBe('900000');
    expect(readStored()).toHaveLength(1);
  });

  test('a historyId that is not decimal digits is refused rather than persisted', async () => {
    const store = new MailboxCursorStore(storePath);
    await expect(store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '1.8e19' }))
      .rejects.toThrow('not a decimal historyId');
    await expect(store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '' }))
      .rejects.toThrow('not a decimal historyId');
  });
});

describe('advanceGmail() stores what it was handed', () => {
  test('every advance in an ascending run is persisted digit-for-digit', async () => {
    const sequence = ['2', '11', '9007199254740993', '18446744073709551614', UINT64_MAX];
    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '1' });
    for (const historyId of sequence) {
      const updated = await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId });
      expect(updated.historyId).toBe(historyId);
      expect((readStored()[0] as Record<string, unknown>).historyId).toBe(historyId);
    }
    const reopened = new MailboxCursorStore(storePath);
    expect((await reopened.getGmail('acct-1', 'INBOX'))?.historyId).toBe(UINT64_MAX);
  });

  test('the cursor never moves backwards, and the comparison is not numeric', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '1' });
    await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '100' });
    // Lexicographically '9' > '100'; numerically it is smaller, and the length
    // check is what makes the store agree with arithmetic here.
    const backwards = await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '9' });
    expect(backwards.historyId).toBe('100');
    // And forwards past the safe-integer boundary, where a parsed comparison
    // would call these two equal and refuse to move.
    await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '9007199254740992' });
    const forward = await store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: BEYOND_SAFE_INTEGER });
    expect(forward.historyId).toBe(BEYOND_SAFE_INTEGER);
  });

  test('a malformed historyId is refused rather than written over a good position', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolveGmail({ account: 'acct-1', mailbox: 'INBOX', currentHistoryId: '77' });
    await expect(store.advanceGmail({ account: 'acct-1', mailbox: 'INBOX' }, { historyId: '0x1f' }))
      .rejects.toThrow('not a decimal historyId');
    expect((await store.getGmail('acct-1', 'INBOX'))?.historyId).toBe('77');
  });
});

describe('sweep() is source-blind', () => {
  test('an unconfigured account is reaped whichever shape its cursor has', async () => {
    seed([
      validCursor({ account: 'gone-imap' }),
      validGmailCursor({ account: 'gone-gmail' }),
      validCursor({ account: 'kept-imap' }),
      validGmailCursor({ account: 'kept-gmail' }),
    ]);
    const store = new MailboxCursorStore(storePath, {
      isAccountConfigured: (account) => account.startsWith('kept-'),
    });
    const report = await store.runRecoverySweep();
    expect(report.removed.map((r) => r.account).sort()).toEqual(['gone-gmail', 'gone-imap']);
    expect(report.removed.every((r) => r.reason === 'account-not-configured')).toBe(true);
    expect((await store.list()).map((c) => c.account).sort()).toEqual(['kept-gmail', 'kept-imap']);
  });

  test('the count cap reaps the oldest past the bound across both shapes', async () => {
    const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    seed([
      validCursor({ account: 'imap-oldest', updatedAt: at(50) }),
      validGmailCursor({ account: 'gmail-older', updatedAt: at(40) }),
      validCursor({ account: 'imap-newer', updatedAt: at(20) }),
      validGmailCursor({ account: 'gmail-newest', updatedAt: at(10) }),
    ]);
    const store = new MailboxCursorStore(storePath, { policy: { maxCursors: 2 } });
    const report = await store.sweep('manual');
    expect(report.removed.filter((r) => r.reason === 'over-cap').map((r) => r.account))
      .toEqual(['imap-oldest', 'gmail-older']);
    expect(report.retained).toBe(2);
    expect((await store.list()).map((c) => c.account)).toEqual(['imap-newer', 'gmail-newest']);
  });

  test('a torn Gmail record is dropped, and a valid one beside it survives', async () => {
    seed([
      // 21 digits: longer than any uint64 Google ever issued, so a torn or
      // hand-edited record rather than a position.
      { source: 'gmail', account: 'torn', mailbox: 'INBOX', historyId: '184467440737095516150', updatedAt: new Date().toISOString() },
      validGmailCursor({ account: 'ok' }),
    ]);
    const store = new MailboxCursorStore(storePath);
    const live = await store.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.account).toBe('ok');
  });
});

describe('the default policy', () => {
  test('is exported for callers to inspect', () => {
    expect(DEFAULT_MAILBOX_CURSOR_POLICY.maxCursors).toBeGreaterThan(0);
  });
});
