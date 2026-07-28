/**
 * inbound-mail-sender-field-redaction.test.ts
 *
 * §11.0's card redaction applied to the two attacker-written fields it had
 * been left off: `senderDisplay` and `deliveredToAddress`.
 *
 * `record-store.ts` redacted `subject` and `bodyExcerpt` and stated the reason
 * beside the subject — "the subject is persisted alongside the excerpt AND
 * rendered to the owner in the notice, so it is the same exposure by a
 * different field". That reasoning describes three fields and was applied to
 * one of them:
 *
 *  - `senderDisplay` is the `From:` display name, written by whoever sent the
 *    message;
 *  - `deliveredToAddress` is the alias local part, which on a catch-all domain
 *    (§7.1) is likewise chosen by the sender.
 *
 * Both were persisted verbatim for `retentionDays` AND rendered to the owner
 * by `senderField` / `deliveredToField` on every surface a notice can reach.
 * The detector was never the problem: `redactCardShapes` catches the identical
 * string in the subject.
 *
 * Two separate exposures are covered here, because closing one does not close
 * the other: what reaches DISK, and what reaches the OWNER. A notice lands in
 * a message history the daemon does not own and cannot later redact.
 *
 * Also pinned: §11.0's re-clamp hazard. A redaction marker is LONGER than the
 * digits it replaces (`[redacted:security-code]` is twenty-four characters for
 * three), and a `deliveredToAddress` that loses its `@` or exceeds 320
 * characters fails `validateInboundMailRecord` on the next load — which
 * discards the WHOLE record. Redacting a field into oblivion would trade an
 * exposure for a disappearance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundMailStore,
  validateInboundMailRecord,
  type InboundMailRecordInput,
} from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { detectCardShapes } from '../packages/sdk/src/platform/security/card-shapes.ts';
import {
  receiptTimestamp,
  renderInboundMailNotice,
} from '../packages/sdk/src/platform/email/inbound-notice.ts';
import { renderNoticeForSurface } from '../packages/sdk/src/platform/email/inbound-notice-channels.ts';
import type { DeliveredRecipient } from '../packages/sdk/src/platform/google/delivery-evidence.ts';

/** Luhn-valid, the canonical test PAN. */
const PAN = '4111111111111111';

/** Every surface a notice can be rendered for, plus one this build does not map. */
const SURFACES = ['telegram', 'discord', 'slack', 'ntfy', 'some-unmapped-surface'];

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-sender-redaction-'));
  storePath = join(dir, 'email-inbound-records.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseInput(): InboundMailRecordInput {
  return {
    source: 'imap',
    uidValidity: 1000,
    uid: 42,
    account: 'acct-1',
    mailbox: 'INBOX',
    senderDisplay: 'ordinary@sender.test',
    subject: 'ordinary subject',
    deliveredToAddress: 'me@mine.test',
    deliveryEvidenceSource: 'delivered-to-header',
    links: [],
    outcome: 'no-expectation',
    noticeStatus: 'delivered',
    body: '',
    receivedAt: new Date().toISOString(),
  };
}

function delivered(address: string): DeliveredRecipient {
  return { address, source: 'delivered-to-header' } as DeliveredRecipient;
}

describe('what reaches disk', () => {
  test('a PAN in the From display name is redacted before it is persisted', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({ ...baseInput(), senderDisplay: `"${PAN}" <a@b.test>` });

    expect(readFileSync(storePath, 'utf-8')).not.toContain(PAN);
    const [stored] = await store.list();
    expect(stored?.senderDisplay).not.toContain(PAN);
    // Redacted, not deleted: who sent it is still legible.
    expect(stored?.senderDisplay).toContain('[redacted:pan]');
    expect(stored?.senderDisplay).toContain('a@b.test');
  });

  test('a PAN as the alias local part is redacted before it is persisted', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({ ...baseInput(), deliveredToAddress: `${PAN}@his-catchall.test` });

    expect(readFileSync(storePath, 'utf-8')).not.toContain(PAN);
    const [stored] = await store.list();
    expect(stored?.deliveredToAddress).not.toContain(PAN);
    // The domain the message landed on is the correlation fact; it survives.
    expect(stored?.deliveredToAddress).toContain('@his-catchall.test');
  });

  test('the subject and body controls still hold, so this is one rule and not three', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({ ...baseInput(), subject: `Order ${PAN} confirmed` });
    await store.record({
      ...baseInput(),
      source: 'gmail',
      resourceId: 'r1',
      historyId: '99',
      body: `card ${PAN}`,
    } as InboundMailRecordInput);
    expect(readFileSync(storePath, 'utf-8')).not.toContain(PAN);
  });

  test('ordinary values are untouched — this redacts card shapes, not digits', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({
      ...baseInput(),
      senderDisplay: '"Acme Orders 2026" <orders@acme.test>',
      deliveredToAddress: 'signup-a1b2@his-catchall.test',
    });
    const [stored] = await store.list();
    expect(stored?.senderDisplay).toBe('"Acme Orders 2026" <orders@acme.test>');
    expect(stored?.deliveredToAddress).toBe('signup-a1b2@his-catchall.test');
  });
});

describe('the record still survives its own validator — §11.0\'s re-clamp rule', () => {
  test('a redacted record round-trips, rather than being discarded on the next load', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({
      ...baseInput(),
      senderDisplay: `"${PAN}" <a@b.test>`,
      deliveredToAddress: `${PAN}@his-catchall.test`,
    });
    // A fresh store reads the file back through `validateInboundMailRecord`.
    expect(await new InboundMailStore(storePath).list()).toHaveLength(1);
  });

  test('an address whose redaction outgrows the 320-char bound keeps its @ and stays in bounds', async () => {
    // Growth is real: `cvv 123 ` (8 chars) becomes `cvv [redacted:security-code] `.
    // A head-slice would cut the `@` off and the loader would drop the record
    // whole — an exposure traded for a disappearance.
    const stuffed = `${'cvv 123 '.repeat(37)}@his-catchall.test`;
    expect(stuffed.length).toBeLessThanOrEqual(320);

    const store = new InboundMailStore(storePath);
    await store.record({ ...baseInput(), deliveredToAddress: stuffed });

    const [stored] = await store.list();
    expect(stored?.deliveredToAddress).toBeDefined();
    expect(stored!.deliveredToAddress!.length).toBeLessThanOrEqual(320);
    expect(stored!.deliveredToAddress).toContain('@his-catchall.test');
    expect(validateInboundMailRecord(stored)).not.toBeNull();
    // And the record is still there after a reload.
    expect(await new InboundMailStore(storePath).list()).toHaveLength(1);
  });

  test('a sender display long enough to outgrow 998 chars is clamped, not left to fail validation', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({ ...baseInput(), senderDisplay: 'cvv 123 '.repeat(124) });
    const [stored] = await store.list();
    expect(stored!.senderDisplay.length).toBeLessThanOrEqual(998);
    expect(await new InboundMailStore(storePath).list()).toHaveLength(1);
  });

  test('a null delivery address stays null rather than becoming a redacted empty string', async () => {
    const store = new InboundMailStore(storePath);
    await store.record({
      ...baseInput(),
      deliveryEvidenceSource: 'none',
      deliveredToAddress: null,
    });
    expect((await store.list())[0]?.deliveredToAddress).toBeNull();
  });
});

describe('what reaches the owner', () => {
  test('a PAN in the From display name does not reach the notice on any surface', () => {
    const notice = renderInboundMailNotice({
      senderDisplay: `"${PAN}" <a@b.test>`,
      subject: 'ordinary subject',
      deliveredTo: null,
      outcome: { kind: 'inert' },
      links: [],
      receivedAt: receiptTimestamp(new Date()),
    });
    for (const surface of SURFACES) {
      expect(renderNoticeForSurface(notice, surface)).not.toContain(PAN);
    }
  });

  test('a PAN in the alias does not reach the notice on any surface', () => {
    const notice = renderInboundMailNotice({
      senderDisplay: 'verify@service.test',
      subject: 'ordinary subject',
      deliveredTo: delivered(`${PAN}@his-catchall.test`),
      outcome: { kind: 'inert' },
      links: [],
      receivedAt: receiptTimestamp(new Date()),
    });
    for (const surface of SURFACES) {
      expect(renderNoticeForSurface(notice, surface)).not.toContain(PAN);
    }
  });

  test('a PAN in the subject does not reach the notice either', () => {
    const notice = renderInboundMailNotice({
      senderDisplay: 'verify@service.test',
      subject: `Order ${PAN} confirmed`,
      deliveredTo: null,
      outcome: { kind: 'inert' },
      links: [],
      receivedAt: receiptTimestamp(new Date()),
    });
    for (const surface of SURFACES) {
      expect(renderNoticeForSurface(notice, surface)).not.toContain(PAN);
    }
  });

  test('a card number written across two lines is still caught, because stripping runs first', () => {
    // `stripControlAndLineBreaks` rewrites the break as a SPACE, and a space is
    // a separator the detector joins across. Redacting BEFORE stripping would
    // leave two halves too short to detect and pass both through.
    const split = '4111 1111\n1111 1111';
    expect(detectCardShapes(split)).toHaveLength(0); // undetectable as written
    const notice = renderInboundMailNotice({
      senderDisplay: split,
      subject: 'ordinary subject',
      deliveredTo: null,
      outcome: { kind: 'inert' },
      links: [],
      receivedAt: receiptTimestamp(new Date()),
    });
    expect(renderNoticeForSurface(notice, 'telegram')).not.toContain('1111 1111');
  });

  test('an ordinary notice is unchanged — the sender and alias still read normally', () => {
    const notice = renderInboundMailNotice({
      senderDisplay: '"GitHub" <noreply@github.com>',
      subject: 'Verify your email',
      deliveredTo: delivered('signup-a1b2@his-catchall.test'),
      outcome: { kind: 'inert' },
      links: [],
      receivedAt: receiptTimestamp(new Date()),
    });
    const rendered = renderNoticeForSurface(notice, 'ntfy');
    expect(rendered).toContain('GitHub');
    expect(rendered).toContain('Verify your email');
    expect(rendered).toContain('signup-a1b2');
    expect(rendered).not.toContain('[redacted');
  });
});
