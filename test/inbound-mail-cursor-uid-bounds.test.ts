/**
 * inbound-mail-cursor-uid-bounds.test.ts
 *
 * The UPPER bound on an IMAP position, at every point one can enter the system
 * (docs/inbound-email.md §9.1 rule 2, RFC 3501 §2.3.1.1).
 *
 * `uidValidity` and `lastSeenUid` used to be bounded only by SIGN. That is a
 * one-way trap rather than an ordinary validation gap, and the asymmetry is
 * why this file exists:
 *
 *   - `lastSeenUid` is a high-water mark and `advance()` moves it with
 *     `Math.max`, so it only ever climbs;
 *   - `resolve()` answers `resumed` on a UIDVALIDITY match without ever
 *     comparing the stored mark to the mailbox's real one;
 *   - `sweep()` has no range rule, so nothing reaps it;
 *   - and `UID SEARCH UID <cursor+1>:*` filtered to `uid > lastSeenUid` then
 *     discards every message the mailbox holds.
 *
 * One absurd value therefore ends inbound mail permanently while the drain
 * reports `complete, found: 0` and the watcher reports healthy, silence that
 * announces itself as success. Nothing short of deleting the file recovers it.
 *
 * Three doors are checked, because closing one is not closing the room:
 * validation on LOAD, refusal on WRITE, and the ceiling on the wire read that
 * feeds the write. Out-of-range is DISCARDED or REFUSED, never clamped down,
 * a clamped cursor is a position the daemon never actually reached, and
 * resuming from one skips the mailbox just as silently as the bad value did.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MailboxCursorStore,
  validateMailboxCursor,
} from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import {
  isImapUid,
  isImapUidValidity,
  MAX_IMAP_UID,
  validateInboundSourceCursor,
} from '../packages/sdk/src/platform/email/inbound/source-cursor.ts';
import { parseSearchNumbers } from '../packages/sdk/src/platform/email/imap-headers.ts';
import { searchAboveCursor } from '../packages/sdk/src/platform/email/inbound/poll-loop.ts';
import type { MailboxWire } from '../packages/sdk/src/platform/email/inbound/ports.ts';

/** `Number.MAX_SAFE_INTEGER`, a valid JS integer, and not a UID any server can issue. */
const ABSURD_UID = 9_007_199_254_740_991;

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-cursor-uid-bounds-'));
  storePath = join(dir, 'inbound-mail-cursors.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(cursors: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ version: 1, cursors }, null, 2)}\n`, 'utf-8');
}

function storedCursor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: 'acct-1',
    mailbox: 'INBOX',
    uidValidity: 1000,
    lastSeenUid: 42,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('the range itself', () => {
  test('the ceiling is 2^32 - 1, the value RFC 3501 §2.3.1.1 defines', () => {
    expect(MAX_IMAP_UID).toBe(4_294_967_295);
  });

  test('a UID may be 0 — the honest first-run value for an empty mailbox — but never above the ceiling', () => {
    expect(isImapUid(0)).toBe(true);
    expect(isImapUid(MAX_IMAP_UID)).toBe(true);
    expect(isImapUid(MAX_IMAP_UID + 1)).toBe(false);
    expect(isImapUid(ABSURD_UID)).toBe(false);
    expect(isImapUid(-1)).toBe(false);
    expect(isImapUid(1.5)).toBe(false);
  });

  test('UIDVALIDITY is non-zero, so 0 is refused where a UID is accepted', () => {
    expect(isImapUidValidity(0)).toBe(false);
    expect(isImapUidValidity(1)).toBe(true);
    expect(isImapUidValidity(MAX_IMAP_UID)).toBe(true);
    expect(isImapUidValidity(MAX_IMAP_UID + 1)).toBe(false);
    expect(isImapUidValidity(ABSURD_UID)).toBe(false);
  });
});

describe('door 1 — a stored record outside the range is discarded on load', () => {
  test('an out-of-range lastSeenUid fails validation', () => {
    expect(validateMailboxCursor(storedCursor({ lastSeenUid: ABSURD_UID }))).toBeNull();
    expect(validateMailboxCursor(storedCursor({ lastSeenUid: MAX_IMAP_UID + 1 }))).toBeNull();
    // The boundary itself still validates: this bounds the record, it does not
    // narrow the protocol.
    expect(validateMailboxCursor(storedCursor({ lastSeenUid: MAX_IMAP_UID }))).not.toBeNull();
  });

  test('an out-of-range uidValidity fails validation', () => {
    expect(validateMailboxCursor(storedCursor({ uidValidity: ABSURD_UID }))).toBeNull();
    expect(validateMailboxCursor(storedCursor({ uidValidity: MAX_IMAP_UID + 1 }))).toBeNull();
    expect(validateMailboxCursor(storedCursor({ uidValidity: MAX_IMAP_UID }))).not.toBeNull();
  });

  test('the discriminated-union validator agrees, so the two cannot drift', () => {
    expect(validateInboundSourceCursor(storedCursor({ source: 'imap', lastSeenUid: ABSURD_UID }))).toBeNull();
    expect(validateInboundSourceCursor(storedCursor({ source: 'imap' }))).not.toBeNull();
  });

  test('resolve() treats it as absent and re-establishes at the real high-water mark, rather than resuming from it', async () => {
    seed([storedCursor({ lastSeenUid: ABSURD_UID })]);
    const store = new MailboxCursorStore(storePath);
    const resolution = await store.resolve({
      account: 'acct-1',
      mailbox: 'INBOX',
      serverUidValidity: 1000,
      currentHighestUid: 42,
      currentMessageCount: 42,
    });
    // Not `resumed`. The torn record is gone and the mailbox starts from where
    // the server says it actually is, which is the whole recovery path.
    expect(resolution.kind).toBe('first-run');
    expect(resolution.cursor.lastSeenUid).toBe(42);
  });

  test('sweep() reaps it and DISCLOSES the drop, so a mailbox that reset is explicable', async () => {
    seed([storedCursor({ lastSeenUid: ABSURD_UID })]);
    const store = new MailboxCursorStore(storePath, { isAccountConfigured: () => true });
    const report = await store.sweep('recovery');
    expect(report.retained).toBe(0);
    expect(report.removed.map((entry) => entry.reason)).toContain('malformed');
  });

  test('the file is recoverable without being deleted by hand — the property the old behaviour lacked', async () => {
    seed([storedCursor({ lastSeenUid: ABSURD_UID })]);
    const store = new MailboxCursorStore(storePath);
    await store.resolve({
      account: 'acct-1',
      mailbox: 'INBOX',
      serverUidValidity: 1000,
      currentHighestUid: 42,
      currentMessageCount: 42,
    });
    const after = await store.advance({
      account: 'acct-1', mailbox: 'INBOX', uidValidity: 1000, lastSeenUid: 43,
    });
    expect(after.lastSeenUid).toBe(43);
  });
});

describe('door 2 — an out-of-range position is refused on the way in, not persisted', () => {
  test('advance() refuses rather than storing a value the next load would drop', async () => {
    const store = new MailboxCursorStore(storePath);
    await store.resolve({
      account: 'acct-1', mailbox: 'INBOX',
      serverUidValidity: 1000, currentHighestUid: 42, currentMessageCount: 42,
    });
    await expect(store.advance({
      account: 'acct-1', mailbox: 'INBOX', uidValidity: 1000, lastSeenUid: ABSURD_UID,
    })).rejects.toThrow(/Refusing to advance/);
    // And the refusal left the good cursor untouched.
    expect((await store.get('acct-1', 'INBOX'))?.lastSeenUid).toBe(42);
  });

  test('resolve() refuses an out-of-range high-water mark from the server', async () => {
    const store = new MailboxCursorStore(storePath);
    await expect(store.resolve({
      account: 'acct-1', mailbox: 'INBOX',
      serverUidValidity: 1000, currentHighestUid: ABSURD_UID, currentMessageCount: 1,
    })).rejects.toThrow(/Refusing to establish/);
  });

  test('resolve() refuses an out-of-range UIDVALIDITY from the server', async () => {
    const store = new MailboxCursorStore(storePath);
    await expect(store.resolve({
      account: 'acct-1', mailbox: 'INBOX',
      serverUidValidity: MAX_IMAP_UID + 1, currentHighestUid: 1, currentMessageCount: 1,
    })).rejects.toThrow(/Refusing to establish/);
  });

  test('the refusal names the range, so the message explains itself', async () => {
    const store = new MailboxCursorStore(storePath);
    await expect(store.resolve({
      account: 'acct-1', mailbox: 'INBOX',
      serverUidValidity: 1000, currentHighestUid: ABSURD_UID, currentMessageCount: 1,
    })).rejects.toThrow(/4294967295/);
  });
});

describe('door 3 — the wire cannot hand one up in the first place', () => {
  test('parseSearchNumbers drops a token above the 32-bit space instead of parseInt-ing it to 1e20', () => {
    expect(parseSearchNumbers(['* SEARCH 99999999999999999999'])).toEqual([]);
    expect(parseSearchNumbers([`* SEARCH ${String(MAX_IMAP_UID + 1)}`])).toEqual([]);
  });

  test('real UIDs either side of the ceiling still come through', () => {
    expect(parseSearchNumbers([`* SEARCH 40 41 ${String(MAX_IMAP_UID)}`]))
      .toEqual([40, 41, MAX_IMAP_UID]);
  });

  test('a mixed line keeps the usable UIDs and drops only the impossible one', () => {
    expect(parseSearchNumbers(['* SEARCH 40 99999999999999999999 41'])).toEqual([40, 41]);
  });
});

describe('the silent-stall consequence is loud if it is ever reached at all', () => {
  const wire = {
    sendCommand: async (_command: string) => 'A1',
    awaitTag: async () => ['* SEARCH 40 41 42 43', 'A1 OK SEARCH completed'],
  } as unknown as MailboxWire;

  test('searching above an impossible cursor is a read failure, not an empty result', async () => {
    // The old behaviour returned [] here, which the drain reported as
    // `complete, found: 0`, four live messages skipped, and called success.
    await expect(searchAboveCursor(wire, ABSURD_UID, {
      timeoutMs: 1000,
      signal: new AbortController().signal,
    })).rejects.toThrow(/Refusing to search above UID/);
  });

  test('a real cursor still searches normally — the guard costs the healthy path nothing', async () => {
    expect(await searchAboveCursor(wire, 39, {
      timeoutMs: 1000,
      signal: new AbortController().signal,
    })).toEqual([40, 41, 42, 43]);
  });
});
