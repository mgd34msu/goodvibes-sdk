/**
 * A record's identity is discriminated on the source that found the message.
 *
 * Before this, `validateInboundMailRecord` required a positive `uidValidity`
 * and `uid` unconditionally, so EVERY Gmail message failed validation and was
 * dropped — on the path automatic source selection makes the default once
 * Google is adopted. Mail arrived, was matched, was announced, and nothing was
 * ever written: §9.3's thirty-day retention had nothing to retain, §11.0's
 * card redaction had nothing to redact, and `email.inbound.status` truthfully
 * reported zero records, which reads as "no mail" rather than "cannot store
 * mail".
 *
 * The first test here is the one that fails without the fix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundMailStore,
  describeRecordIdentity,
  validateInboundMailRecord,
} from '../packages/sdk/src/platform/email/inbound/record-store.ts';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'goodvibes-record-union-'));
  storePath = join(dir, 'records.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A uint64 that does NOT survive a round trip through a JS double. */
const HUGE_HISTORY_ID = '18446744073709551615';

function gmailInput(overrides: Record<string, unknown> = {}) {
  return {
    source: 'gmail' as const,
    resourceId: '18f0a2b3c4d5e6f7',
    historyId: '9876543210',
    account: 'acct-1',
    mailbox: 'INBOX',
    senderDisplay: 'noreply@github.com',
    subject: 'Verify your email',
    deliveredToAddress: 'owner+alias@example.com',
    deliveryEvidenceSource: 'alias-mailbox' as const,
    links: [],
    outcome: 'matched-expectation' as const,
    noticeStatus: 'delivered' as const,
    body: 'hello world',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('a Gmail message can be recorded at all', () => {
  test('it round-trips through a fresh store instance', async () => {
    // THE point. This is the case that was silently dropped.
    const store = new InboundMailStore(storePath);
    const written = await store.record(gmailInput());

    expect(written.source).toBe('gmail');

    const reopened = new InboundMailStore(storePath);
    const all = await reopened.list();
    expect(all).toHaveLength(1);
    const read = all[0]!;
    expect(read.source).toBe('gmail');
    if (read.source !== 'gmail') throw new Error('narrowing failed');
    expect(read.resourceId).toBe('18f0a2b3c4d5e6f7');
    expect(read.historyId).toBe('9876543210');
    expect(read.subject).toBe('Verify your email');
  });

  test('an IMAP message still round-trips unchanged', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({
      source: 'imap',
      uidValidity: 100,
      uid: 42,
      account: 'acct-1',
      mailbox: 'INBOX',
      senderDisplay: 'noreply@github.com',
      subject: 'Verify your email',
      deliveredToAddress: 'owner+alias@example.com',
      deliveryEvidenceSource: 'alias-mailbox',
      links: [],
      outcome: 'matched-expectation',
      noticeStatus: 'delivered',
      body: 'hello world',
      receivedAt: new Date().toISOString(),
    });

    const read = (await new InboundMailStore(storePath).list())[0]!;
    expect(read.source).toBe('imap');
    if (read.source !== 'imap') throw new Error('narrowing failed');
    expect(read.uidValidity).toBe(100);
    expect(read.uid).toBe(42);
  });

  test('both sources coexist in one store', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(gmailInput());
    await store.record({
      source: 'imap', uidValidity: 100, uid: 42,
      account: 'acct-1', mailbox: 'INBOX',
      senderDisplay: 'a@b.test', subject: 's', deliveredToAddress: null,
      deliveryEvidenceSource: 'none', links: [], outcome: 'no-expectation',
      noticeStatus: 'delivered', body: '', receivedAt: new Date().toISOString(),
    });
    const all = await new InboundMailStore(storePath).list();
    expect(all.map((r) => r.source).sort()).toEqual(['gmail', 'imap']);
  });
});

describe('a uint64 historyId survives intact', () => {
  test('it is stored and read back as the exact string, never a number', async () => {
    // 18446744073709551615 becomes 18446744073709552000 through a JS double.
    // A position that silently shifts is a position that re-reads or skips
    // history, which is why the cursor made this shape impossible and why the
    // record must not reintroduce it.
    expect(String(Number(HUGE_HISTORY_ID))).not.toBe(HUGE_HISTORY_ID);

    const store = new InboundMailStore(storePath);
    await store.record(gmailInput({ historyId: HUGE_HISTORY_ID }));

    const read = (await new InboundMailStore(storePath).list())[0]!;
    if (read.source !== 'gmail') throw new Error('narrowing failed');
    expect(read.historyId).toBe(HUGE_HISTORY_ID);
    expect(typeof read.historyId).toBe('string');
  });

  test('a historyId that is not a decimal uint64 is refused', () => {
    for (const bad of ['1.8446744073709552e19', '-1', '01', '', 'abc', '184467440737095516150']) {
      expect(validateInboundMailRecord({
        ...gmailInput({ historyId: bad }), id: 'rec-1', bodyExcerpt: '',
      })).toBeNull();
    }
  });
});

describe('a record is discarded when its payload does not match its declared source', () => {
  test('a record declaring gmail but carrying an IMAP identity is discarded, not coerced', () => {
    // §9: a torn record is dropped rather than repaired. Coercion here is the
    // specific repair that caused the original bug, in reverse.
    expect(validateInboundMailRecord({
      id: 'rec-1', account: 'acct-1', mailbox: 'INBOX',
      source: 'gmail', uidValidity: 100, uid: 42,
      senderDisplay: 'a@b.test', subject: 's', deliveredToAddress: null,
      deliveryEvidenceSource: 'none', links: [], outcome: 'no-expectation',
      noticeStatus: 'delivered', bodyExcerpt: '', receivedAt: new Date().toISOString(),
    })).toBeNull();
  });

  test('a record declaring imap but carrying a Gmail identity is discarded', () => {
    expect(validateInboundMailRecord({
      id: 'rec-1', account: 'acct-1', mailbox: 'INBOX',
      source: 'imap', resourceId: '18f0a', historyId: '99',
      senderDisplay: 'a@b.test', subject: 's', deliveredToAddress: null,
      deliveryEvidenceSource: 'none', links: [], outcome: 'no-expectation',
      noticeStatus: 'delivered', bodyExcerpt: '', receivedAt: new Date().toISOString(),
    })).toBeNull();
  });

  test('a record naming a source this build does not know is discarded', () => {
    expect(validateInboundMailRecord({
      id: 'rec-1', account: 'acct-1', mailbox: 'INBOX',
      source: 'exchange', uidValidity: 100, uid: 42,
      senderDisplay: 'a@b.test', subject: 's', deliveredToAddress: null,
      deliveryEvidenceSource: 'none', links: [], outcome: 'no-expectation',
      noticeStatus: 'delivered', bodyExcerpt: '', receivedAt: new Date().toISOString(),
    })).toBeNull();
  });

  test('a record with NO source is read as IMAP, so the existing store survives', () => {
    // Backward compatibility, deliberately asymmetric: every record written
    // before the union existed is an IMAP record, and discarding them all on
    // first load would be a worse bug than the one being fixed. Gmail is never
    // inferred from absence — it must say so.
    const read = validateInboundMailRecord({
      id: 'rec-1', account: 'acct-1', mailbox: 'INBOX',
      uidValidity: 100, uid: 42,
      senderDisplay: 'a@b.test', subject: 's', deliveredToAddress: null,
      deliveryEvidenceSource: 'none', links: [], outcome: 'no-expectation',
      noticeStatus: 'delivered', bodyExcerpt: '', receivedAt: new Date().toISOString(),
    });
    expect(read?.source).toBe('imap');
  });
});

describe('card-shape redaction runs on a Gmail record', () => {
  test('the body excerpt and the subject are both redacted before persisting', async () => {
    // §11.0. This path had never executed on Gmail: the record was discarded
    // before it could be stored, so the redaction it depends on was untested
    // for the source that will be the default.
    const store = new InboundMailStore(storePath);
    await store.record(gmailInput({
      subject: 'Your card 4111 1111 1111 1111 was charged',
      body: 'Receipt for card 4111111111111111 ending today. Thanks.',
    }));

    const read = (await new InboundMailStore(storePath).list())[0]!;
    expect(read.subject).not.toContain('4111 1111 1111 1111');
    expect(read.bodyExcerpt).not.toContain('4111111111111111');
    // Redacted, not deleted — the owner can still see what the mail was about.
    expect(read.subject).toContain('was charged');
    expect(read.bodyExcerpt).toContain('Receipt for card');
  });
});

describe('a sweep report names which message went, whatever found it', () => {
  test('the identity is readable for both sources', () => {
    expect(describeRecordIdentity({
      source: 'imap', uidValidity: 100, uid: 42,
    } as never)).toBe('imap:100:42');
    expect(describeRecordIdentity({
      source: 'gmail', resourceId: '18f0a',
    } as never)).toBe('gmail:18f0a');
  });

  test('an expired Gmail record is reported with its own identity, not a zeroed uid', async () => {
    // The discard used to carry `uid: number`, which for a Gmail record could
    // only ever be 0 — a report that looks like it told the owner which
    // message went while telling him nothing.
    const store = new InboundMailStore(storePath, { policy: { retentionMs: 1 } });
    await store.record(gmailInput());
    await new Promise((resolve) => setTimeout(resolve, 5));

    const report = await store.sweep('manual');
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]!.messageRef).toBe('gmail:18f0a2b3c4d5e6f7');
  });
});
