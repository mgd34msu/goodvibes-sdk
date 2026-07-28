/**
 * Three behaviours that were correct and unguarded — each proven by mutation:
 * revert the code, and the whole suite stayed green.
 *
 *   1. `record-store.ts` reads through `loadOrDiscard`, not `load`. Nothing
 *      wrote a corrupt `records.json`, so swapping it back to the throwing
 *      `load()` reddened nothing at all.
 *   2. `expectation-store.ts`, identically, for `expectations.json`.
 *   3. `housekeeping.ts` sweeps each store through `attempt()`, so one store's
 *      failure is not the other two's. `report.failures` was asserted NOWHERE,
 *      and came back `[]` in every corruption scenario the suite had — because
 *      a sweep that reads through `loadOrDiscard` cannot throw, so no test ever
 *      produced a failing sweep at all. `InboundMailSweepFailure`, `attempt()`,
 *      `failures` and `retention.lastSweep.failures` were collectively
 *      untested.
 *
 * The third needs a sweep that genuinely throws, and the honest way to get one
 * is not a stub that rejects — it is a store whose file cannot be WRITTEN. A
 * directory where the JSON should be makes `persist()` fail with EISDIR inside
 * the real class, which is the same shape as the full disk and the
 * replaced-state-directory the design is written against.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLocalFailure } from '../packages/sdk/src/platform/email/inbound/capability.ts';
import { MailboxCursorStore } from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import { InboundMailHousekeeper } from '../packages/sdk/src/platform/email/inbound/housekeeping.ts';
import { InboundMailStore } from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';

const NOW = new Date('2026-07-27T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-store-guards-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function paths(): {
  readonly cursors: string;
  readonly records: string;
  readonly expectations: string;
  readonly disclosure: string;
} {
  return {
    cursors: join(dir, 'cursors.json'),
    records: join(dir, 'records.json'),
    expectations: join(dir, 'expectations.json'),
    disclosure: join(dir, 'inbound-mail-housekeeping.json'),
  };
}

// ---------------------------------------------------------------------------
// 1 & 2. One unreadable byte is discarded and disclosed, not a hard failure
// ---------------------------------------------------------------------------

describe('a corrupt records.json is discarded and disclosed, never thrown', () => {
  test('list() answers empty instead of failing', async () => {
    writeFileSync(paths().records, '{"version":1,"records":[{"id":"a"', 'utf-8');
    const store = new InboundMailStore(paths().records, { now: () => NOW.getTime() });

    // The guard: reading through `load()` throws here and every later read.
    expect(await store.list()).toEqual([]);
  });

  test('the unreadable file is REPORTED — discarded is not the same as absent', async () => {
    writeFileSync(paths().records, 'not json at all', 'utf-8');
    const store = new InboundMailStore(paths().records, { now: () => NOW.getTime() });

    const report = await store.sweep('recovery');
    const unreadable = report.removed.filter((entry) => entry.reason === 'file-unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.note).toContain('could not be read');
    expect(store.getCorruption()).not.toBeNull();
    expect(store.getCorruption()?.filePath).toBe(paths().records);
  });

  test('a file that parses to a non-object is corrupt, not empty', async () => {
    // The failure mode the discard path exists to prevent: `[]` and `"x"` are
    // valid JSON and would read as "no records" rather than "unreadable".
    writeFileSync(paths().records, '["not", "an", "object"]', 'utf-8');
    const store = new InboundMailStore(paths().records, { now: () => NOW.getTime() });

    const report = await store.sweep('recovery');
    expect(report.removed.some((entry) => entry.reason === 'file-unreadable')).toBe(true);
  });

  test('the store keeps working after the corrupt file is replaced', async () => {
    writeFileSync(paths().records, '{ broken', 'utf-8');
    const store = new InboundMailStore(paths().records, { now: () => NOW.getTime() });
    await store.sweep('recovery');
    expect(await store.list()).toEqual([]);
  });
});

describe('a corrupt expectations.json is discarded and disclosed, never thrown', () => {
  test('list() answers empty instead of failing', async () => {
    writeFileSync(paths().expectations, '{"version":1,"expectations":[', 'utf-8');
    const store = new PersistedExpectationStore(paths().expectations, { now: () => NOW });

    expect(await store.list()).toEqual([]);
  });

  test('the unreadable file is REPORTED', async () => {
    writeFileSync(paths().expectations, 'nope', 'utf-8');
    const store = new PersistedExpectationStore(paths().expectations, { now: () => NOW });

    const report = await store.sweep('recovery');
    const unreadable = report.removed.filter((entry) => entry.reason === 'file-unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.note).toContain('could not be read');
    expect(store.getCorruption()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. One store's failure is not the other two's
// ---------------------------------------------------------------------------

describe('housekeeping sweeps each store independently and names the ones that failed', () => {
  /** A path that cannot be written to, because a directory is sitting on it. */
  function blockWrite(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  test('a store that cannot be swept is REPORTED, and the other two are still swept', async () => {
    const p = paths();
    blockWrite(p.records);
    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(p.cursors, { now: () => NOW.getTime() }),
      records: new InboundMailStore(p.records, { now: () => NOW.getTime() }),
      expectations: new PersistedExpectationStore(p.expectations, { now: () => NOW }),
      disclosurePath: p.disclosure,
      now: () => NOW.getTime(),
    });

    const report = await housekeeper.runRecoverySweep();

    // The failure is named rather than swallowed...
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.store).toBe('records');
    expect(report.failures[0]?.detail.length).toBeGreaterThan(0);
    expect(report.records).toBeNull();

    // ...and the other two ran anyway, which is the whole point of `attempt`.
    expect(report.cursors).not.toBeNull();
    expect(report.expectations).not.toBeNull();
  });

  test('the disclosure sentence says NOT SWEPT rather than omitting the store', async () => {
    // An absent line reads as "nothing to report", and "nothing to report" is
    // precisely the wrong thing to say about a file nobody could sweep.
    const p = paths();
    blockWrite(p.expectations);
    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(p.cursors, { now: () => NOW.getTime() }),
      records: new InboundMailStore(p.records, { now: () => NOW.getTime() }),
      expectations: new PersistedExpectationStore(p.expectations, { now: () => NOW }),
      disclosurePath: p.disclosure,
      now: () => NOW.getTime(),
    });

    const report = await housekeeper.runRecoverySweep();

    expect(report.summary).toContain('expectations NOT SWEPT');
    expect(report.summary).toContain('store(s) could not be swept');
    expect(report.summary).toContain('expectations (');
  });

  test('the pass still produces a report when TWO stores cannot be swept', async () => {
    const p = paths();
    blockWrite(p.records);
    blockWrite(p.expectations);
    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(p.cursors, { now: () => NOW.getTime() }),
      records: new InboundMailStore(p.records, { now: () => NOW.getTime() }),
      expectations: new PersistedExpectationStore(p.expectations, { now: () => NOW }),
      disclosurePath: p.disclosure,
      now: () => NOW.getTime(),
    });

    const report = await housekeeper.runRecoverySweep();

    expect(report.failures.map((failure) => failure.store).sort())
      .toEqual(['expectations', 'records']);
    expect(report.cursors).not.toBeNull();
    expect(report.trigger).toBe('recovery');
  });

  test('a healthy pass reports no failures at all', async () => {
    const p = paths();
    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(p.cursors, { now: () => NOW.getTime() }),
      records: new InboundMailStore(p.records, { now: () => NOW.getTime() }),
      expectations: new PersistedExpectationStore(p.expectations, { now: () => NOW }),
      disclosurePath: p.disclosure,
      now: () => NOW.getTime(),
    });

    const report = await housekeeper.runRecoverySweep();

    expect(report.failures).toEqual([]);
    expect(report.summary).not.toContain('NOT SWEPT');
    expect(report.records).not.toBeNull();
  });

  test('the failure survives into the disclosure log on disk', async () => {
    // `retention.lastSweep.failures` is read from this log, and it was as
    // untested as the field it carries.
    const p = paths();
    blockWrite(p.records);
    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(p.cursors, { now: () => NOW.getTime() }),
      records: new InboundMailStore(p.records, { now: () => NOW.getTime() }),
      expectations: new PersistedExpectationStore(p.expectations, { now: () => NOW }),
      disclosurePath: p.disclosure,
      now: () => NOW.getTime(),
    });

    await housekeeper.runRecoverySweep();
    const disclosures = await housekeeper.listDisclosures();

    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]?.failures).toHaveLength(1);
    expect(disclosures[0]?.failures[0]?.store).toBe('records');
  });
});

// ---------------------------------------------------------------------------
// The errno classification the EISDIR scenario only ever used as a mechanism
// ---------------------------------------------------------------------------

/**
 * The tests above force a sweep to throw by putting a directory where the JSON
 * belongs. That is EISDIR used as a MECHANISM — nothing above asserts what the
 * daemon then decides about it, so the errno set could be edited without a
 * single test noticing.
 *
 * The consequence of dropping one is real but bounded, which is why this is a
 * gap rather than a blocker: `classifyLocalFailure` escalates on
 * `permanent || exhausted`, so an errno that falls out of the permanent set is
 * still escalated once the consecutive count reaches the ceiling. Slower, not
 * silent — the owner is still told, ten attempts later instead of at once.
 * These assertions pin the distinction so a change to it has to be deliberate.
 */
describe('a local failure is classified by errno, and the set is not editable in silence', () => {
  function errored(code: string): Error {
    return Object.assign(new Error(`sweep failed: ${code}`), { code });
  }

  test('a permanent store errno is terminal on the FIRST attempt', () => {
    // No amount of retrying reverses a directory sitting where a file belongs,
    // or a permission somebody set.
    for (const code of ['EISDIR', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENAMETOOLONG']) {
      const { verdict, terminal } = classifyLocalFailure(errored(code), 1, 10);
      expect({ code, terminal, reason: verdict.reason }).toEqual({
        code, terminal: true, reason: 'local-store-unwritable',
      });
    }
  });

  test('a transient storage errno waits, then escalates at the ceiling', () => {
    // A full disk during a log rotation clears on its own; the tenth one has
    // been disproved by the machine.
    const first = classifyLocalFailure(errored('ENOSPC'), 1, 10);
    expect(first.terminal).toBe(false);
    expect(first.verdict.reason).toBe('reconnecting');
    expect(first.verdict.detail).toContain('Attempt 1 of 10');

    const last = classifyLocalFailure(errored('ENOSPC'), 10, 10);
    expect(last.terminal).toBe(true);
    expect(last.verdict.reason).toBe('local-store-unwritable');
  });

  test('an errno that is not storage at all keeps its own name at the ceiling', () => {
    // Sending an owner to check disk space over an unrelated bug is the same
    // class of mistake as calling a connection limit a bad password.
    const { verdict, terminal } = classifyLocalFailure(errored('ECONNRESET'), 10, 10);
    expect(terminal).toBe(true);
    expect(verdict.reason).toBe('watcher-stopped-unexpectedly');
  });

  test('a failure that merely mentions the cursor is treated as store-unwritable', () => {
    const { verdict } = classifyLocalFailure(new Error('the cursor could not be written'), 10, 10);
    expect(verdict.reason).toBe('local-store-unwritable');
  });

  test('every permanent errno is also a storage errno — the sets cannot drift apart', () => {
    // `STORAGE_ERRNOS` is built by spreading `PERMANENT_STORE_ERRNOS`, so a
    // permanent errno that did not name `local-store-unwritable` would mean
    // the two had been split by hand.
    for (const code of ['EISDIR', 'EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENAMETOOLONG']) {
      expect(classifyLocalFailure(errored(code), 10, 10).verdict.reason)
        .toBe('local-store-unwritable');
    }
  });
});
