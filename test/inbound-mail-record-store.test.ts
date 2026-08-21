/**
 * inbound-mail-record-store.test.ts
 *
 * The custody rules for the inbound-mail record store (docs/inbound-email.md
 * §9.3): structured fields plus a bounded body excerpt, bounded by BOTH a
 * retention age and a max record count (whichever binds first), validated by
 * content on load, and every sweep itemised.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundMailStore,
  validateInboundMailRecord,
  type InboundMailRecordInput,
} from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { MAX_BODY_EXCERPT_CHARS } from '../packages/sdk/src/platform/email/inbound/types.ts';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-records-'));
  storePath = join(dir, 'inbound-mail-records.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf-8');
}

function readStored(): unknown[] {
  const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as { records: unknown[] };
  return parsed.records;
}

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rec-1',
    account: 'acct-1',
    mailbox: 'INBOX',
    source: 'imap',
    uidValidity: 100,
    uid: 42,
    senderDisplay: 'noreply@github.com',
    subject: 'Verify your email',
    deliveredToAddress: 'owner+alias@example.com',
    deliveryEvidenceSource: 'alias-mailbox',
    links: [{ registrableDomain: 'github.com', verdict: 'allowed' }],
    outcome: 'matched-expectation',
    noticeStatus: 'delivered',
    bodyExcerpt: 'hello world',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * The IMAP arm of `InboundMailRecordInput` specifically.
 *
 * `InboundMailRecordInput` is distributive over
 * `ImapInboundMailRecord | GmailInboundMailRecord`, so a `Partial` of the whole
 * union spread over a literal produces a union TypeScript cannot place in
 * either arm. This helper builds an IMAP record, it sets uidValidity and uid,
 * so naming that arm is both what makes it typecheck and what it always meant.
 */
type ImapRecordInput = Extract<InboundMailRecordInput, { source: 'imap' }>;

function recordInput(overrides: Partial<ImapRecordInput> = {}): ImapRecordInput {
  return {
    account: 'acct-1',
    mailbox: 'INBOX',
    source: 'imap',
    uidValidity: 100,
    uid: 1,
    senderDisplay: 'noreply@github.com',
    subject: 'Verify your email',
    deliveredToAddress: 'owner+alias@example.com',
    deliveryEvidenceSource: 'alias-mailbox',
    links: [],
    outcome: 'matched-expectation',
    noticeStatus: 'delivered',
    body: 'hello world',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Round trip + body excerpt bound
// ---------------------------------------------------------------------------
describe('recording and reading back', () => {
  test('a recorded message round-trips through a fresh store instance', async () => {
    const store = new InboundMailStore(storePath);
    const created = await store.record(recordInput());
    const reopened = new InboundMailStore(storePath);
    const found = await reopened.get(created.id);
    expect(found?.subject).toBe('Verify your email');
    // `get` returns the record union; only the IMAP arm carries a UID.
    expect(found?.source).toBe('imap');
    expect(found != null && found.source === 'imap' ? found.uid : null).toBe(1);
  });

  test('the body excerpt is truncated to the policy cap at write time, mirroring MAX_BODY_EXCERPT_CHARS', async () => {
    const store = new InboundMailStore(storePath);
    const huge = 'x'.repeat(MAX_BODY_EXCERPT_CHARS + 5_000);
    const created = await store.record(recordInput({ body: huge }));
    expect(created.bodyExcerpt.length).toBe(MAX_BODY_EXCERPT_CHARS);
  });

  test('a policy asking for a LARGER excerpt than MAX_BODY_EXCERPT_CHARS is clamped, never honoured', async () => {
    const store = new InboundMailStore(storePath, { policy: { maxBodyExcerptChars: MAX_BODY_EXCERPT_CHARS * 10 } });
    expect(store.getPolicy().maxBodyExcerptChars).toBe(MAX_BODY_EXCERPT_CHARS);
    const created = await store.record(recordInput({ body: 'x'.repeat(MAX_BODY_EXCERPT_CHARS + 1) }));
    expect(created.bodyExcerpt.length).toBe(MAX_BODY_EXCERPT_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Validate by content, never repair
// ---------------------------------------------------------------------------
describe('a torn or oversized record is discarded, not repaired', () => {
  test('validateInboundMailRecord refuses each broken field independently', () => {
    expect(validateInboundMailRecord(null)).toBeNull();
    expect(validateInboundMailRecord(validRaw({ id: '' }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ uidValidity: -1 }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ uid: 0 }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ outcome: 'not-a-real-outcome' }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ noticeStatus: 'not-a-real-status' }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ deliveryEvidenceSource: 'none', deliveredToAddress: 'still-set@example.com' }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ deliveryEvidenceSource: 'alias-mailbox', deliveredToAddress: null }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ links: [{ registrableDomain: 'x', verdict: 'not-a-verdict' }] }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ receivedAt: 'not-a-date' }))).toBeNull();
    // The bound-defining case: a body excerpt over the hard cap is a reason to
    // discard the WHOLE record, never to truncate it again on read.
    expect(validateInboundMailRecord(validRaw({ bodyExcerpt: 'x'.repeat(MAX_BODY_EXCERPT_CHARS + 1) }))).toBeNull();
    expect(validateInboundMailRecord(validRaw({ bodyExcerpt: 'x'.repeat(MAX_BODY_EXCERPT_CHARS) }))).not.toBeNull();
  });

  test('a torn record is dropped on load; the valid sibling survives', async () => {
    seed([{ id: 'torn' }, validRaw({ id: 'ok' })]);
    const store = new InboundMailStore(storePath);
    const live = await store.list();
    expect(live.map((r) => r.id)).toEqual(['ok']);
  });

  test('sweep discloses the malformed count', async () => {
    seed([{ id: 'torn' }, validRaw({ id: 'ok' })]);
    const store = new InboundMailStore(storePath);
    const report = await store.sweep('manual');
    expect(report.removed.some((r) => r.reason === 'malformed')).toBe(true);
    expect(report.retained).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bounded by BOTH age and count
// ---------------------------------------------------------------------------
describe('bounded by age AND count, whichever binds first', () => {
  test('a record past the retention window is reaped regardless of count', async () => {
    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    seed([validRaw({ id: 'old', receivedAt: ancient }), validRaw({ id: 'new', receivedAt: recent })]);
    const store = new InboundMailStore(storePath, { policy: { retentionMs: 30 * 24 * 60 * 60 * 1000 } });
    const report = await store.runRecoverySweep();
    expect(report.removed).toEqual([expect.objectContaining({ id: 'old', reason: 'expired' })]);
    expect((await store.list()).map((r) => r.id)).toEqual(['new']);
  });

  test('a record past the count cap is reaped even though it is well within the age bound', async () => {
    const now = Date.now();
    const seeds = Array.from({ length: 5 }, (_, i) =>
      validRaw({ id: `rec-${String(i)}`, receivedAt: new Date(now - (5 - i) * 1000).toISOString() }));
    seed(seeds);
    const store = new InboundMailStore(storePath, { policy: { maxRecords: 3, retentionMs: 365 * 24 * 60 * 60 * 1000 } });
    const report = await store.sweep('manual');
    expect(report.removed.filter((r) => r.reason === 'over-cap')).toHaveLength(2);
    expect(report.retained).toBe(3);
    const remaining = (await store.list()).map((r) => r.id).sort();
    expect(remaining).toEqual(['rec-2', 'rec-3', 'rec-4']);
  });

  test('the count cap keeps the NEWEST records, dropping the oldest first', async () => {
    const now = Date.now();
    seed([
      validRaw({ id: 'oldest', receivedAt: new Date(now - 3000).toISOString() }),
      validRaw({ id: 'middle', receivedAt: new Date(now - 2000).toISOString() }),
      validRaw({ id: 'newest', receivedAt: new Date(now - 1000).toISOString() }),
    ]);
    const store = new InboundMailStore(storePath, { policy: { maxRecords: 2, retentionMs: 365 * 24 * 60 * 60 * 1000 } });
    await store.sweep('manual');
    expect((await store.list()).map((r) => r.id)).toEqual(['newest', 'middle']);
  });

  test('a read between sweeps never serves a record past either bound (read-time honesty)', async () => {
    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    seed([validRaw({ id: 'old', receivedAt: ancient })]);
    const store = new InboundMailStore(storePath, { policy: { retentionMs: 30 * 24 * 60 * 60 * 1000 } });
    // No sweep run yet.
    expect(await store.list()).toHaveLength(0);
    expect(readStored()).toHaveLength(1); // still on disk until a sweep runs
  });

  test('list() can filter by account', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ account: 'acct-a' }));
    await store.record(recordInput({ account: 'acct-b' }));
    const filtered = await store.list({ account: 'acct-a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.account).toBe('acct-a');
  });
});
