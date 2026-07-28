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
    expect(report.cursors.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.records.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.expectations.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.summary).toContain('removed');
  });

  test('a pass that removes nothing still returns a coherent report and a quiet summary', async () => {
    const housekeeper = buildHousekeeper();
    const report = await housekeeper.runRecoverySweep();
    expect(report.cursors.removed).toHaveLength(0);
    expect(report.records.removed).toHaveLength(0);
    expect(report.expectations.removed).toHaveLength(0);
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

  test('start(0) is a no-op rather than a busy loop', () => {
    const housekeeper = buildHousekeeper();
    expect(() => { housekeeper.start(0); }).not.toThrow();
    housekeeper.stop();
  });
});
