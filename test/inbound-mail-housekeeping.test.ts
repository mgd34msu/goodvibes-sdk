/**
 * inbound-mail-housekeeping.test.ts
 *
 * The composed recovery-time and periodic housekeeping pass over all three
 * inbound-mail stores (docs/inbound-email.md §9), following the same shape
 * as `platform/devices/device-housekeeping.ts`'s `DeviceHousekeeper`:
 *  - every sweep returns an itemised report across all three stores;
 *  - the disclosure log is bounded and persisted beside the stores;
 *  - the periodic sweep runs on an unref'd timer without a restart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxCursorStore } from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import { InboundMailStore } from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import {
  InboundMailHousekeeper,
  type InboundMailHousekeepingReport,
} from '../packages/sdk/src/platform/email/inbound/housekeeping.ts';

let dir: string;
let cursorPath: string;
let recordPath: string;
let expectationPath: string;
let disclosurePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-housekeeping-'));
  cursorPath = join(dir, 'inbound-mail-cursors.json');
  recordPath = join(dir, 'inbound-mail-records.json');
  expectationPath = join(dir, 'inbound-mail-expectations.json');
  disclosurePath = join(dir, 'inbound-mail-housekeeping.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildHousekeeper(now?: () => number): InboundMailHousekeeper {
  return new InboundMailHousekeeper({
    cursors: new MailboxCursorStore(cursorPath),
    records: new InboundMailStore(recordPath),
    expectations: new PersistedExpectationStore(expectationPath),
    disclosurePath,
    ...(now ? { now } : {}),
  });
}

function readDisclosures(): InboundMailHousekeepingReport[] {
  if (!existsSync(disclosurePath)) return [];
  const parsed = JSON.parse(readFileSync(disclosurePath, 'utf-8')) as { reports: InboundMailHousekeepingReport[] };
  return parsed.reports;
}

describe('the housekeeper composes all three stores into one itemised report', () => {
  test('runRecoverySweep() aggregates removals from cursors, records, and expectations', async () => {
    writeFileSync(cursorPath, JSON.stringify({ version: 1, cursors: [{ account: 'torn' }] }), 'utf-8');
    writeFileSync(recordPath, JSON.stringify({ version: 1, records: [{ id: 'torn' }] }), 'utf-8');
    writeFileSync(expectationPath, JSON.stringify({ version: 1, expectations: [{ id: 'torn' }] }), 'utf-8');

    const housekeeper = buildHousekeeper();
    const report = await housekeeper.runRecoverySweep();

    expect(report.trigger).toBe('recovery');
    // Each section is `… | null`, null means that store was not swept at all,
    // which for this case would be a different (and worse) outcome than an
    // empty removal list. Asserted rather than narrowed past with `!`.
    expect(report.cursors, 'the cursor store was not swept').not.toBeNull();
    expect(report.records, 'the record store was not swept').not.toBeNull();
    expect(report.expectations, 'the expectation store was not swept').not.toBeNull();
    expect(report.cursors?.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.records?.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.expectations?.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.summary).toContain('removed');
  });

  test('a cursor kept because nobody could confirm its account is named in the summary', async () => {
    // A retained cursor that nothing justified is persisted state held for an
    // unknown reason, and the summary is the only place a person sees it. A
    // count that never falls to zero means a caller that can never answer,
    // which is a fault worth seeing rather than a leak worth ignoring.
    writeFileSync(cursorPath, JSON.stringify({
      version: 1,
      cursors: [{
        account: 'acct-a',
        mailbox: 'INBOX',
        uidValidity: 7,
        lastSeenUid: 900,
        updatedAt: new Date().toISOString(),
      }],
    }), 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(cursorPath, { isAccountConfigured: () => 'unknown' }),
      records: new InboundMailStore(recordPath),
      expectations: new PersistedExpectationStore(expectationPath),
      disclosurePath,
    });
    const report = await housekeeper.runRecoverySweep();

    expect(report.cursors?.unresolvedAccounts).toBe(1);
    expect(report.cursors?.removed).toEqual([]);
    expect(report.summary).toContain('1 cursor(s) were kept because the configured-account answer was not available');
  });

  test('a pass where every account answered says nothing about unresolved ones', async () => {
    // The control: the sentence appears only when there is something to say.
    writeFileSync(cursorPath, JSON.stringify({
      version: 1,
      cursors: [{
        account: 'acct-a',
        mailbox: 'INBOX',
        uidValidity: 7,
        lastSeenUid: 900,
        updatedAt: new Date().toISOString(),
      }],
    }), 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(cursorPath, { isAccountConfigured: () => true }),
      records: new InboundMailStore(recordPath),
      expectations: new PersistedExpectationStore(expectationPath),
      disclosurePath,
    });
    const report = await housekeeper.runRecoverySweep();

    expect(report.cursors?.unresolvedAccounts).toBe(0);
    expect(report.summary).not.toContain('configured-account answer');
  });

  test('a pass that removes nothing still returns a coherent report and a quiet summary', async () => {
    const housekeeper = buildHousekeeper();
    const report = await housekeeper.runRecoverySweep();
    // Same distinction as above: a swept store that removed nothing is the
    // pass here; a store that was never swept is not, and null would be that.
    expect(report.cursors, 'the cursor store was not swept').not.toBeNull();
    expect(report.records, 'the record store was not swept').not.toBeNull();
    expect(report.expectations, 'the expectation store was not swept').not.toBeNull();
    expect(report.cursors?.removed).toHaveLength(0);
    expect(report.records?.removed).toHaveLength(0);
    expect(report.expectations?.removed).toHaveLength(0);
    expect(report.summary).toContain('nothing to reap');
  });

  test('getLastReport() reflects the most recent sweep', async () => {
    const housekeeper = buildHousekeeper();
    expect(housekeeper.getLastReport()).toBeNull();
    const report = await housekeeper.runRecoverySweep();
    expect(housekeeper.getLastReport()).toEqual(report);
  });
});

describe('disclosure is written to disk and stays bounded', () => {
  test('each sweep appends a disclosure entry', async () => {
    const housekeeper = buildHousekeeper();
    await housekeeper.runRecoverySweep();
    await housekeeper.sweep('manual');
    const disclosures = readDisclosures();
    expect(disclosures).toHaveLength(2);
    expect(disclosures[0]?.trigger).toBe('recovery');
    expect(disclosures[1]?.trigger).toBe('manual');
  });

  test('the disclosure log never grows past its bound', async () => {
    const housekeeper = buildHousekeeper();
    for (let i = 0; i < 25; i += 1) {
      await housekeeper.sweep('manual');
    }
    const disclosures = readDisclosures();
    expect(disclosures.length).toBeLessThanOrEqual(20);
  });
});

describe('the periodic sweep runs on a timer without a restart', () => {
  test('start() sweeps again after the interval elapses, and stop() halts it', async () => {
    const housekeeper = buildHousekeeper();
    await housekeeper.runRecoverySweep();
    housekeeper.start(15);
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const disclosures = readDisclosures();
        if (disclosures.some((r) => r.trigger === 'periodic')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      housekeeper.stop();
    }
    const disclosures = readDisclosures();
    expect(disclosures.some((r) => r.trigger === 'periodic')).toBe(true);
  }, 30_000);

  /**
   * `start(0)` used to be asserted with `expect(() => start(0)).not.toThrow()`,
   * which passes WITH the busy loop installed: delete the `intervalMs <= 0`
   * guard and `setInterval(fn, 0)` still does not throw, while running a sweep
   * roughly every millisecond. Not throwing was never the claim, not sweeping
   * was.
   *
   * So the assertion is on the sweeps themselves, over a window long enough
   * that an ungated `setInterval(fn, 0)` would have run dozens of them.
   */
  const NON_INTERVALS: ReadonlyArray<{ label: string; value: number }> = [
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1_000 },
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  ];

  for (const { label, value } of NON_INTERVALS) {
    test(`start(${label}) installs no timer and sweeps nothing`, async () => {
      const housekeeper = buildHousekeeper();
      housekeeper.start(value);
      try {
        // No timer object at all, which is the mechanism; the sweep count
        // below is the consequence, and both are asserted because a timer
        // installed with a different handler would satisfy only one.
        expect((housekeeper as unknown as { timer: unknown }).timer).toBeNull();
        await new Promise((resolve) => { setTimeout(resolve, 120); });
        expect(housekeeper.getLastReport()).toBeNull();
        expect(readDisclosures()).toHaveLength(0);
      } finally {
        housekeeper.stop();
      }
    });
  }

  test('a real interval DOES sweep in the same window, so the check above is not vacuous', async () => {
    // The control. Without it, "no sweeps in 120 ms" could be true because
    // nothing in this harness ever sweeps.
    const housekeeper = buildHousekeeper();
    housekeeper.start(10);
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && housekeeper.getLastReport() === null) {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
    } finally {
      housekeeper.stop();
    }
    expect(housekeeper.getLastReport()?.trigger).toBe('periodic');
  }, 15_000);
});
