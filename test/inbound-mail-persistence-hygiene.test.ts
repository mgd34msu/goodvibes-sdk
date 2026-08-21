/**
 * inbound-mail-persistence-hygiene.test.ts, the four persistence-hygiene
 * findings recorded as M8 in
 * docs/reviews/2026-07-27-inbound-email-medium-findings.md.
 *
 * EVERY ASSERTION HERE IS AGAINST THE FILE ON DISK, not against a store's own
 * read method. That is the whole lesson of finding 1: `list()` filters by age
 * and by count, so it reported two records where the file held ten, and a test
 * written against `list()` would have passed against the defect. Where a test
 * must read through the store (the write-reap tally has no on-disk form) it
 * says so.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundMailStore,
  MAX_LINK_REASON_CHARS,
  MAX_NOTICE_FAILURE_REASON_CHARS,
  validateInboundMailRecord,
  type InboundMailRecordInput,
} from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import {
  DEFAULT_DISCLOSURE_RETENTION_MS,
  InboundMailHousekeeper,
} from '../packages/sdk/src/platform/email/inbound/housekeeping.ts';
import { MailboxCursorStore } from '../packages/sdk/src/platform/email/inbound/cursor-store.ts';
import { PersistedExpectationStore } from '../packages/sdk/src/platform/email/inbound/expectation-store.ts';
import {
  PersistentStore,
  resetPersistentStoreTempSweepThrottle,
} from '../packages/sdk/src/platform/state/persistent-store.ts';
import type { VerificationExpectation } from '../packages/sdk/src/platform/google/verification-expectations.ts';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-hygiene-'));
  storePath = join(dir, 'email-inbound-records.json');
  resetPersistentStoreTempSweepThrottle();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

function input(overrides: Partial<InboundMailRecordInput> = {}): InboundMailRecordInput {
  return {
    source: 'imap',
    account: 'acct-1',
    mailbox: 'INBOX',
    uidValidity: 1,
    uid: 1,
    senderDisplay: 'sender@example.test',
    subject: 'a subject',
    deliveredToAddress: null,
    deliveryEvidenceSource: 'none',
    links: [],
    outcome: 'no-expectation',
    noticeStatus: 'delivered',
    body: '',
    receivedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as InboundMailRecordInput;
}

/** The records array AS THE FILE HOLDS IT, never through the store. */
function recordsOnDisk(path = storePath): unknown[] {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { records: unknown[] };
  return parsed.records;
}

// ---------------------------------------------------------------------------
// 1. Bounds apply on the write, not only on a six-hourly sweep
// ---------------------------------------------------------------------------

describe('record() applies both policy bounds to what it writes', () => {
  test('ten writes under maxRecords: 2 leave TWO records on disk', async () => {
    const store = new InboundMailStore(storePath, {
      policy: { maxRecords: 2 },
      now: () => NOW,
    });
    for (let index = 0; index < 10; index += 1) {
      // Distinct, increasing receipt times, so "which two survived" is a
      // question about RECENCY and not about insertion order. Keeping the
      // oldest two would pass an order-blind assertion.
      await store.record(input({
        uid: 100 + index,
        subject: `msg ${String(index)}`,
        receivedAt: new Date(NOW - (10 - index) * 1_000).toISOString(),
      }));
    }

    // The measured defect: this was 10 while `list()` answered 2.
    expect(recordsOnDisk().length).toBe(2);
    // And the two kept are the NEWEST, by the same oldest-first-goes rule the
    // sweep applies, not an arbitrary two.
    const subjects = recordsOnDisk().map((r) => (r as { subject: string }).subject).sort();
    expect(subjects).toEqual(['msg 8', 'msg 9']);
  });

  test('a record already past retentionMs is not left on disk by its own write', async () => {
    const store = new InboundMailStore(storePath, {
      policy: { retentionMs: 1_000 },
      now: () => NOW,
    });
    await store.record(input({ uid: 1, receivedAt: new Date(NOW - 86_400_000).toISOString() }));

    expect(recordsOnDisk().length).toBe(0);
  });

  test('the age bound binds first, then the count bound', async () => {
    const store = new InboundMailStore(storePath, {
      policy: { maxRecords: 100, retentionMs: 60_000 },
      now: () => NOW,
    });
    await store.record(input({ uid: 1, receivedAt: new Date(NOW - 30_000).toISOString() }));
    await store.record(input({ uid: 2, receivedAt: new Date(NOW - 600_000).toISOString() }));
    await store.record(input({ uid: 3, receivedAt: new Date(NOW).toISOString() }));

    expect(recordsOnDisk().map((r) => (r as { uid: number }).uid).sort()).toEqual([1, 3]);
  });

  test('replacing an existing message in place still bounds the result', async () => {
    const store = new InboundMailStore(storePath, {
      policy: { maxRecords: 3 },
      now: () => NOW,
    });
    for (let index = 0; index < 3; index += 1) {
      await store.record(input({ uid: 200 + index, receivedAt: new Date(NOW - (10 - index) * 1_000).toISOString() }));
    }
    // A retry of the SAME message: one row in, one row out, still three.
    await store.record(input({ uid: 201, noticeStatus: 'pending', receivedAt: new Date(NOW).toISOString() }));

    expect(recordsOnDisk().length).toBe(3);
    const retried = recordsOnDisk().find((r) => (r as { uid: number }).uid === 201) as { noticeStatus: string };
    expect(retried.noticeStatus).toBe('pending');
  });

  test('the write-time reap is DISCLOSED rather than silent', async () => {
    const store = new InboundMailStore(storePath, {
      policy: { maxRecords: 2, retentionMs: 60_000 },
      now: () => NOW,
    });
    for (let index = 0; index < 5; index += 1) {
      await store.record(input({ uid: 300 + index, receivedAt: new Date(NOW - index).toISOString() }));
    }
    await store.record(input({ uid: 999, receivedAt: new Date(NOW - 600_000).toISOString() }));

    const tally = store.getWriteReapTally();
    // Three of the five writes pushed the set past two; the last write was
    // itself past the age window.
    expect(tally.overCap).toBe(3);
    expect(tally.expired).toBe(1);
    expect(tally.since).toBe(NOW);
  });
});

describe('the retention disclosure agrees with the file, not with a filtered view', () => {
  test('count().stored reports what the file holds, including rows a read hides', async () => {
    // Ten rows planted directly, all past the window: exactly the shape a
    // filtered view reported as "2" and the file held as "10".
    writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      records: Array.from({ length: 10 }, (_unused, index) => ({
        id: `seeded-${String(index)}`,
        account: 'acct-1',
        mailbox: 'INBOX',
        source: 'imap',
        uidValidity: 1,
        uid: 400 + index,
        senderDisplay: 'sender@example.test',
        subject: `old ${String(index)}`,
        deliveredToAddress: null,
        deliveryEvidenceSource: 'none',
        links: [],
        outcome: 'no-expectation',
        noticeStatus: 'delivered',
        bodyExcerpt: '',
        receivedAt: new Date(NOW - 86_400_000).toISOString(),
      })),
    }, null, 2)}\n`, 'utf-8');

    const store = new InboundMailStore(storePath, {
      policy: { maxRecords: 2, retentionMs: 1_000 },
      now: () => NOW,
    });

    expect((await store.list()).length).toBe(0);
    const counted = await store.count();
    expect(counted.stored).toBe(recordsOnDisk().length);
    expect(counted.stored).toBe(10);
    expect(counted.live).toBe(0);
  });

  test('a malformed row still counts as something the file holds', async () => {
    writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      records: [{ id: 'torn' }, { nope: true }],
    }, null, 2)}\n`, 'utf-8');
    const store = new InboundMailStore(storePath, { now: () => NOW });

    expect((await store.count()).stored).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. The disclosure log is not a second copy of the expectation store
// ---------------------------------------------------------------------------

function expectation(overrides: Partial<VerificationExpectation> = {}): VerificationExpectation {
  return {
    id: 'exp-survivor-1',
    kind: 'signup',
    serviceDomain: 'example.com',
    recipientAddress: 'alias-survivor@inbox.test',
    purpose: 'signing up for the survivor service',
    openedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    authority: 'evidence-only',
    ...overrides,
  };
}

describe('the housekeeping disclosure log discloses removals, not survivors', () => {
  test('a surviving expectation is NOT duplicated into the log', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    const expectations = new PersistedExpectationStore(join(dir, 'expectations.json'), {
      now: () => new Date(NOW),
    });
    await expectations.replaceAll([expectation()]);

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { now: () => NOW }),
      expectations,
      disclosurePath,
      now: () => NOW,
    });
    const report = await housekeeper.sweep('manual');

    // The in-memory report still carries survivors, the boot hydrator needs
    // them, and that hand-off is same-process.
    expect(report.expectations?.survivors.length).toBe(1);

    // The FILE carries none of it. Asserted on the raw text, because the point
    // is that these strings are not on disk at all, not that some accessor
    // declines to return them.
    const raw = readFileSync(disclosurePath, 'utf-8');
    expect(raw).not.toContain('alias-survivor@inbox.test');
    expect(raw).not.toContain('signing up for the survivor service');
    expect(raw).not.toContain('exp-survivor-1');
    expect(raw).not.toContain('survivors');

    // What a disclosure genuinely needs about the things that stayed: a count.
    const logged = JSON.parse(raw) as { reports: { expectations: { retained: number } }[] };
    expect(logged.reports.at(-1)?.expectations.retained).toBe(1);
  });

  test('a REMOVED expectation is still named — removal is what the log is for', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    writeFileSync(join(dir, 'expectations.json'), `${JSON.stringify({
      version: 1,
      expectations: [expectation({
        id: 'exp-expired-1',
        recipientAddress: 'alias-expired@inbox.test',
        openedAt: new Date(NOW - 600_000).toISOString(),
        expiresAt: new Date(NOW - 60_000).toISOString(),
      })],
    }, null, 2)}\n`, 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { now: () => NOW }),
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      now: () => NOW,
    });
    await housekeeper.sweep('manual');

    expect(readFileSync(disclosurePath, 'utf-8')).toContain('alias-expired@inbox.test');
  });

  test('the itemised removal list is bounded, and says how many there really were', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    // 250 rows past the window, planted so the SWEEP is what removes them.
    writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      records: Array.from({ length: 250 }, (_unused, index) => ({
        id: `bulk-${String(index)}`,
        account: 'acct-1',
        mailbox: 'INBOX',
        source: 'imap',
        uidValidity: 1,
        uid: 5_000 + index,
        senderDisplay: 'sender@example.test',
        subject: `bulk ${String(index)}`,
        deliveredToAddress: null,
        deliveryEvidenceSource: 'none',
        links: [],
        outcome: 'no-expectation',
        noticeStatus: 'delivered',
        bodyExcerpt: '',
        receivedAt: new Date(NOW - 86_400_000).toISOString(),
      })),
    }, null, 2)}\n`, 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { policy: { retentionMs: 1_000 }, now: () => NOW }),
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      now: () => NOW,
    });
    const report = await housekeeper.sweep('manual');
    expect(report.records?.removed.length).toBe(250);

    const logged = JSON.parse(readFileSync(disclosurePath, 'utf-8')) as {
      reports: { records: { removed: unknown[]; removedTotal: number } }[];
    };
    const persisted = logged.reports.at(-1)!.records;
    expect(persisted.removed.length).toBe(100);
    // Bounded, and the count is still true.
    expect(persisted.removedTotal).toBe(250);
  });

  /**
   * The count cap alone reaps by ARRIVALS, and a quiet store has none.
   *
   * Twenty entries look like an age bound on a daemon sweeping every six hours
   *, five days' worth, but that is arithmetic about a busy daemon, not a
   * bound. A mailbox that goes quiet, a surface switched off, a daemon that
   * stops: in each the twentieth entry is the last one written and it stays
   * forever. Proved with a file whose entries are old rather than numerous.
   */
  test('a disclosure entry past the retention window is reaped, not merely hidden', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    const ancient = NOW - (DEFAULT_DISCLOSURE_RETENTION_MS + 86_400_000);
    writeFileSync(disclosurePath, `${JSON.stringify({
      version: 1,
      reports: [
        { sweptAt: ancient, trigger: 'periodic', summary: 'from another season', failures: [], cursors: null, records: null, expectations: null },
        { sweptAt: NOW - 1_000, trigger: 'periodic', summary: 'recent', failures: [], cursors: null, records: null, expectations: null },
      ],
    }, null, 2)}\n`, 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { now: () => NOW }),
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      now: () => NOW,
    });

    expect((await housekeeper.listDisclosures()).map((r) => r.summary)).toEqual(['recent']);

    // And the next sweep REMOVES it from the file rather than leaving a read to
    // keep filtering it, the same "bounds apply on the write" rule as part 1.
    await housekeeper.sweep('manual');
    const raw = readFileSync(disclosurePath, 'utf-8');
    expect(raw).not.toContain('from another season');
    expect(raw).toContain('recent');
  });

  test('a shorter disclosure retention can be asked for, and it binds', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    writeFileSync(disclosurePath, `${JSON.stringify({
      version: 1,
      reports: [
        { sweptAt: NOW - 10_000, trigger: 'periodic', summary: 'older than the window', failures: [], cursors: null, records: null, expectations: null },
        { sweptAt: NOW - 100, trigger: 'periodic', summary: 'inside the window', failures: [], cursors: null, records: null, expectations: null },
      ],
    }, null, 2)}\n`, 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { now: () => NOW }),
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      disclosureRetentionMs: 5_000,
      now: () => NOW,
    });

    expect((await housekeeper.listDisclosures()).map((r) => r.summary)).toEqual(['inside the window']);
  });

  test('reclaiming an orphaned temp file is DISCLOSED, not silent', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    const orphan = `${storePath}.tmp.999999.abandoned`;
    writeFileSync(orphan, 'half a write', 'utf-8');
    const longAgo = Date.now() / 1000 - 3_600;
    utimesSync(orphan, longAgo, longAgo);

    const records = new InboundMailStore(storePath, { now: () => NOW });
    // The write is what reclaims it; the sweep is what says so out loud.
    await records.record(input({ uid: 900 }));
    expect(existsSync(orphan)).toBe(false);

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records,
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      now: () => NOW,
    });
    const report = await housekeeper.sweep('manual');

    expect(report.summary).toContain('orphaned temporary file');
    expect(report.summary).toContain('reclaimed');
  });

  test('listDisclosures() validates by content and drops what does not parse as a report', async () => {
    const disclosurePath = join(dir, 'email-inbound-housekeeping.json');
    writeFileSync(disclosurePath, `${JSON.stringify({
      version: 1,
      reports: [
        { sweptAt: NOW, trigger: 'manual', summary: 'fine', failures: [], cursors: null, records: null, expectations: null },
        { sweptAt: 'not a number', trigger: 'manual', summary: 'torn', failures: [] },
        { sweptAt: NOW, trigger: 'invented-trigger', summary: 'torn', failures: [] },
        'a bare string where a report should be',
      ],
    }, null, 2)}\n`, 'utf-8');

    const housekeeper = new InboundMailHousekeeper({
      cursors: new MailboxCursorStore(join(dir, 'cursors.json')),
      records: new InboundMailStore(storePath, { now: () => NOW }),
      expectations: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => new Date(NOW) }),
      disclosurePath,
      now: () => NOW,
    });

    const disclosures = await housekeeper.listDisclosures();
    expect(disclosures.length).toBe(1);
    expect(disclosures[0]?.summary).toBe('fine');
  });
});

// ---------------------------------------------------------------------------
// 3. File mode, durability, temp-file GC, cross-process safety
// ---------------------------------------------------------------------------

describe('PersistentStore writes owner-only, durably, and leaves no litter', () => {
  test('the file is 0600 and the directory it creates is 0700', async () => {
    const nested = join(dir, 'daemon', 'state.json');
    const store = new PersistentStore<{ value: number }>(nested);
    await store.persist({ value: 1 });

    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'daemon')).mode & 0o777).toBe(0o700);
  });

  test('an existing 0644 file becomes 0600 on its next write', async () => {
    const path = join(dir, 'legacy.json');
    writeFileSync(path, '{"value":0}\n', { encoding: 'utf-8', mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    await new PersistentStore<{ value: number }>(path).persist({ value: 2 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('an orphaned temp file from a crashed write is reaped by the next write', async () => {
    const path = join(dir, 'reaped.json');
    const orphan = `${path}.tmp.999999.abandoned`;
    writeFileSync(orphan, 'half a write', 'utf-8');
    const longAgo = Date.now() / 1000 - 3_600;
    utimesSync(orphan, longAgo, longAgo);

    await new PersistentStore<{ value: number }>(path).persist({ value: 3 });

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("a FRESH temp file is left alone — it may be another writer's, mid-flight", async () => {
    const path = join(dir, 'inflight.json');
    const inFlight = `${path}.tmp.12345.right-now`;
    writeFileSync(inFlight, 'someone is writing this', 'utf-8');

    await new PersistentStore<{ value: number }>(path).persist({ value: 4 });

    expect(existsSync(inFlight)).toBe(true);
  });

  test('a completed write leaves no temp file of its own', async () => {
    const path = join(dir, 'clean.json');
    const store = new PersistentStore<{ value: number }>(path);
    for (let index = 0; index < 5; index += 1) await store.persist({ value: index });

    expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  test('an in-memory store has no lock path to contend on', () => {
    expect(new PersistentStore<{ value: number }>(':memory:').lockPath).toBeNull();
    expect(new PersistentStore<{ value: number }>(join(dir, 'x.json')).lockPath)
      .toBe(`${join(dir, 'x.json')}.lock`);
  });

  /**
   * STRUCTURAL, AND SAID SO.
   *
   * The fsync ordering, write, sync the file, rename, sync the directory,
   * has no observable behavioural consequence that a test on a working machine
   * can distinguish from its absence: what it buys is what survives a power
   * cut, and a power cut is not something this suite can stage. Simulating one
   * would only test the simulation.
   *
   * So this asserts the defining lines are present, in order, in the source.
   * That is a weaker claim than the others in this file and is labelled as
   * such: it catches a removal or a reordering of the durability calls, which
   * is the realistic regression, and it does not and cannot prove durability.
   */
  test('the persist path syncs the file before the rename and the directory after it', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'packages/sdk/src/platform/state/persistent-store.ts'),
      'utf-8',
    );
    // SCOPED TO THE persist BODY, and that scoping is not cosmetic: this test
    // was first written with a bare `source.indexOf('await handle.sync();')`,
    // which matched the sync inside the `syncDirectory` helper defined ABOVE
    // the class. Every ordering assertion then passed for a reason that had
    // nothing to do with persist, and a mutation moving persist's own sync
    // could not have been detected. Anchored on the write that precedes it.
    const body = source.slice(source.indexOf('  async persist(data: T): Promise<void> {'));
    expect(body.length).toBeGreaterThan(0);
    const write = body.indexOf("await handle.writeFile(content, 'utf-8');");
    const syncFile = body.indexOf('await handle.sync();');
    const rename = body.indexOf('await fs.rename(tmpPath, this.filePath);');
    const syncDir = body.indexOf('await syncDirectory(this.dir);');
    expect(write).toBeGreaterThan(-1);
    expect(syncFile).toBeGreaterThan(write);
    expect(rename).toBeGreaterThan(syncFile);
    expect(syncDir).toBeGreaterThan(rename);
  });
});

describe('two independent writers over one record file lose nothing', () => {
  test('two store instances interleaving writes keep every record', async () => {
    // Two instances share no `writeChain`, which is exactly what two daemon
    // processes are, and what left three of six records on disk before the
    // cross-process lock. In one process the lock's own FIFO queue is what
    // orders them; the subprocess test below is the cross-process claim.
    const a = new InboundMailStore(storePath, { now: () => NOW });
    const b = new InboundMailStore(storePath, { now: () => NOW });

    await Promise.all([
      ...Array.from({ length: 3 }, (_unused, index) => a.record(input({ uid: 600 + index }))),
      ...Array.from({ length: 3 }, (_unused, index) => b.record(input({ uid: 700 + index }))),
    ]);

    expect(recordsOnDisk().length).toBe(6);
  });

  test('two OS processes writing the same record file keep every record', async () => {
    const storeModule = join(
      import.meta.dir,
      '..',
      'packages/sdk/src/platform/email/inbound/record-store.ts',
    ).replace(/\\/g, '/');
    const scriptPath = join(dir, 'writer.ts');
    writeFileSync(scriptPath, [
      `import { InboundMailStore } from ${JSON.stringify(storeModule)};`,
      `const path = process.argv[2]!;`,
      `const base = Number(process.argv[3]!);`,
      `const store = new InboundMailStore(path, { now: () => ${String(NOW)} });`,
      `for (let index = 0; index < 6; index += 1) {`,
      `  await store.record({`,
      `    source: 'imap', account: 'acct-1', mailbox: 'INBOX',`,
      `    uidValidity: 1, uid: base + index,`,
      `    senderDisplay: 'sender@example.test', subject: 'from ' + String(base + index),`,
      `    deliveredToAddress: null, deliveryEvidenceSource: 'none', links: [],`,
      `    outcome: 'no-expectation', noticeStatus: 'delivered', body: '',`,
      `    receivedAt: ${JSON.stringify(new Date(NOW).toISOString())},`,
      `  });`,
      `}`,
    ].join('\n'), 'utf-8');

    const exits = await Promise.all([1_000, 2_000].map((base) =>
      Bun.spawn(['bun', scriptPath, storePath, String(base)], {
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited));
    expect(exits).toEqual([0, 0]);

    // Twelve writes by two processes. The measured defect was six writes by
    // two writers leaving three.
    expect(recordsOnDisk().length).toBe(12);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Every persisted field is bounded, not only the record count
// ---------------------------------------------------------------------------

describe('no field on a persisted record is unbounded', () => {
  test('noticeFailureReason — the one field a remote server writes — is clamped at write', async () => {
    const store = new InboundMailStore(storePath, { now: () => NOW });
    await store.record(input({ uid: 800, noticeStatus: 'delivery-failed', noticeFailureReason: 'x'.repeat(1_000_000) }));

    const stored = recordsOnDisk()[0] as { noticeFailureReason: string };
    expect(stored.noticeFailureReason.length).toBe(MAX_NOTICE_FAILURE_REASON_CHARS);
  });

  test('an over-long noticeFailureReason on disk fails validation rather than loading', () => {
    const base = {
      id: 'r1', account: 'a', mailbox: 'INBOX', source: 'imap', uidValidity: 1, uid: 1,
      senderDisplay: 's', subject: 's', deliveredToAddress: null, deliveryEvidenceSource: 'none',
      links: [], outcome: 'no-expectation', noticeStatus: 'delivery-failed', bodyExcerpt: '',
      receivedAt: new Date(NOW).toISOString(),
    };
    expect(validateInboundMailRecord({ ...base, noticeFailureReason: 'x'.repeat(MAX_NOTICE_FAILURE_REASON_CHARS) })).not.toBeNull();
    expect(validateInboundMailRecord({ ...base, noticeFailureReason: 'x'.repeat(MAX_NOTICE_FAILURE_REASON_CHARS + 1) })).toBeNull();
  });

  test('a link verdict reason is bounded per entry, and the entry count is bounded too', async () => {
    const store = new InboundMailStore(storePath, { now: () => NOW });
    await store.record(input({
      uid: 801,
      links: Array.from({ length: 500 }, () => ({
        registrableDomain: 'example.com',
        verdict: 'allowed' as const,
        reason: 'y'.repeat(100_000),
      })),
    }));

    const stored = recordsOnDisk()[0] as { links: { reason: string }[] };
    expect(stored.links.length).toBe(64);
    expect(stored.links.every((link) => link.reason.length === MAX_LINK_REASON_CHARS)).toBe(true);
  });

  /**
   * The bound that matters is on the FILE, so this is measured on the file.
   *
   * Every attacker- or server-influenced string is set to a megabyte at once.
   * If any one of them were unbounded the file would be megabytes; with all of
   * them bounded a single record's ceiling is the SUM OF ITS BOUNDS:
   *
   *   bodyExcerpt 20 000 + subject 998 + senderDisplay 998 + mailbox 512
   *   + noticeFailureReason 512 + deliveredToAddress 320 + account 256
   *   + link reason 256 + id/uid/timestamps ≈ 24 KB
   *
   * 32 KB is that sum with room for JSON punctuation and indentation. The
   * threshold is derived rather than observed: a number picked from a passing
   * run would move silently the next time a bound did.
   */
  test('one record built entirely from megabyte fields stays inside the sum of its bounds', async () => {
    const huge = 'z'.repeat(1_000_000);
    const store = new InboundMailStore(storePath, { now: () => NOW });
    await store.record(input({
      uid: 802,
      account: huge,
      mailbox: huge,
      senderDisplay: huge,
      subject: huge,
      deliveredToAddress: `${huge}@example.test`,
      deliveryEvidenceSource: 'delivered-to-header',
      noticeStatus: 'delivery-failed',
      noticeFailureReason: huge,
      body: huge,
      links: [{ registrableDomain: 'example.com', verdict: 'allowed', reason: huge }],
    }));

    expect(statSync(storePath).size).toBeLessThan(32_768);
    const stored = recordsOnDisk()[0] as { account: string; mailbox: string };
    expect(stored.account.length).toBe(256);
    expect(stored.mailbox.length).toBe(512);
    // And it must still be a record the loader accepts, a bound that produces
    // a row discarded on the next load has moved the loss, not closed it.
    expect(validateInboundMailRecord(recordsOnDisk()[0])).not.toBeNull();
  });

  test('a Gmail record identity is bounded on both of its fields', async () => {
    const store = new InboundMailStore(storePath, { now: () => NOW });
    // resourceId over 256 and a historyId that is not a uint64 must not load.
    expect(validateInboundMailRecord({
      id: 'r', account: 'a', mailbox: 'INBOX', source: 'gmail',
      resourceId: 'r'.repeat(257), historyId: '5',
      senderDisplay: '', subject: '', deliveredToAddress: null, deliveryEvidenceSource: 'none',
      links: [], outcome: 'no-expectation', noticeStatus: 'delivered', bodyExcerpt: '',
      receivedAt: new Date(NOW).toISOString(),
    })).toBeNull();
    await store.record(input({
      source: 'gmail', resourceId: 'abc', historyId: '12345',
      uidValidity: undefined, uid: undefined,
    } as unknown as Partial<InboundMailRecordInput>));
    expect(recordsOnDisk().length).toBe(1);
  });
});

describe('the expectation file is bounded in SIZE, not only in count', () => {
  test('MAX_OPEN_EXPECTATIONS caps the count; the field bounds cap the file', async () => {
    const path = join(dir, 'expectations.json');
    const store = new PersistedExpectationStore(path, { now: () => new Date(NOW) });
    const huge = 'q'.repeat(1_000_000);

    // Forty records, past the count cap, each built from megabyte fields.
    await store.replaceAll(Array.from({ length: 40 }, (_unused, index) => expectation({
      id: `exp-${String(index)}`,
      purpose: huge,
      recipientAddress: `${huge}@inbox.test`,
      serviceDomain: `${huge}.example.com`,
    })));

    // Every one of them fails a FIELD bound, so none is persisted at all,
    // which is the correct answer, and it is the field bounds giving it, not
    // the count bound.
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as { expectations: unknown[] };
    expect(persisted.expectations.length).toBe(0);
    expect(statSync(path).size).toBeLessThan(4_096);
  });

  test('a full, valid expectation file is bounded by count times field size', async () => {
    const path = join(dir, 'expectations-full.json');
    const store = new PersistedExpectationStore(path, { now: () => new Date(NOW) });
    await store.replaceAll(Array.from({ length: 40 }, (_unused, index) => expectation({
      id: `exp-${String(index)}`,
      recipientAddress: `alias-${String(index)}@inbox.test`,
      purpose: 'p'.repeat(512),
      // Distinct open times, increasing, so "which 32 survived" is a question
      // about age and not about array position.
      openedAt: new Date(NOW - (40 - index) * 1_000).toISOString(),
    })));

    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as { expectations: { id: string }[] };
    expect(persisted.expectations.length).toBe(32);
    // The OLDEST eight went, which is the sweep's own precedence.
    expect(persisted.expectations.map((e) => e.id)).not.toContain('exp-0');
    expect(persisted.expectations.map((e) => e.id)).toContain('exp-39');
    // 32 × (512-char purpose + 320-char address + 253-char domain + fixed
    // fields). Comfortably under 64 KB, and it is a CEILING because every
    // contributing field has one.
    expect(statSync(path).size).toBeLessThan(65_536);
  });
});
