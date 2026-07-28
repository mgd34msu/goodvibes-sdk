/**
 * inbound-mail-card-redaction.test.ts
 *
 * Card shapes in inbound mail are REDACTED, not refused
 * (docs/inbound-email.md §11.0).
 *
 * Mail is treated differently from a remote messaging channel on purpose. A
 * channel message carrying card shapes is dropped whole; an email is not,
 * because order confirmations legitimately carry long digit runs and they are
 * the consumer the inbound-mail capability exists to serve. Refusing them would
 * break it. So the message is still recorded, still notified, still able to
 * satisfy an expectation — only the digits fail to reach disk.
 *
 * The exposure this closes was introduced by this round's own machinery: the
 * record store persists a bounded body excerpt for thirty days, so a card
 * number in an email would have been written to disk and kept.
 *
 * `4111111111111111` is the published Visa test value. It is not a real card.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundMailStore,
  type InboundMailRecordInput,
} from '../packages/sdk/src/platform/email/inbound/record-store.ts';
import { MAX_BODY_EXCERPT_CHARS } from '../packages/sdk/src/platform/email/inbound/types.ts';

const CARD = '4111111111111111';
const CARD_FRAGMENTS = [CARD, '4111 1111 1111 1111', '411111', '4111'];

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-card-'));
  storePath = join(dir, 'inbound-mail-records.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recordInput(overrides: Partial<InboundMailRecordInput> = {}): InboundMailRecordInput {
  return {
    account: 'acct-1',
    mailbox: 'INBOX',
    uidValidity: 100,
    uid: 1,
    senderDisplay: 'orders@shop.example',
    subject: 'Your order is confirmed',
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

/** The bytes actually on disk — not the returned object, which is easier to get right. */
function rawFile(): string {
  return readFileSync(storePath, 'utf-8');
}

function expectNoCardOnDisk(): void {
  const contents = rawFile();
  for (const fragment of CARD_FRAGMENTS) {
    if (contents.includes(fragment)) {
      throw new Error(`the persisted store contains the card fragment ${JSON.stringify(fragment)}`);
    }
  }
}

describe('a card number in an email never reaches disk', () => {
  test('the persisted body excerpt is redacted', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body: `Thanks! We charged ${CARD} for order 10029384.` }));

    expectNoCardOnDisk();
    expect(rawFile()).toContain('[redacted:pan]');
  });

  test.each([
    ['solid', `We charged ${CARD} today.`],
    ['spaced', 'We charged 4111 1111 1111 1111 today.'],
    ['hyphenated', 'We charged 4111-1111-1111-1111 today.'],
    ['with an expiry right after it', `card ${CARD} 07/29`],
  ])('a card written %s is redacted', async (_label, body) => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body }));
    expectNoCardOnDisk();
  });

  test('a card number in the SUBJECT is redacted too', async () => {
    // The subject is persisted alongside the excerpt and is rendered to the
    // owner in the notice, so it is the same exposure by a different field.
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ subject: `Receipt for card ${CARD}` }));
    expectNoCardOnDisk();
  });

  test('the redaction survives a reload — it was never stored, not merely hidden on read', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body: `charged ${CARD}` }));

    const reloaded = new InboundMailStore(storePath);
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.bodyExcerpt).not.toContain(CARD);
    expect(records[0]!.bodyExcerpt).toContain('[redacted:pan]');
  });

  test('a card straddling the excerpt cap is redacted whole, not truncated into a readable prefix', async () => {
    // Slicing before redacting would keep up to eighteen digits of the card and
    // drop only the tail — which is not a redaction, it is a shorter leak.
    const cap = 200;
    const store = new InboundMailStore(storePath, { policy: { maxBodyExcerptChars: cap } });
    // Positioned so that ten digits of the card fall INSIDE the cap and six
    // fall outside. A slice-then-redact implementation keeps those ten.
    const filler = 'x'.repeat(cap - 15);
    await store.record(recordInput({ body: `${filler}card ${CARD} more text` }));

    expectNoCardOnDisk();
    const records = await store.list();
    expect(records[0]!.bodyExcerpt.length).toBeLessThanOrEqual(cap);
  });
});

describe('mail is redacted, NOT refused', () => {
  test('the message is still recorded, with every structured field intact', async () => {
    const store = new InboundMailStore(storePath);
    const written = await store.record(recordInput({
      body: `Order confirmed. Card ${CARD} charged.`,
      subject: 'Your order is confirmed',
      outcome: 'matched-expectation',
      noticeStatus: 'delivered',
      links: [{ registrableDomain: 'shop.example', verdict: 'allowed' }],
    }));

    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(written.id);
    // Redaction touched the excerpt and nothing else.
    expect(records[0]!.subject).toBe('Your order is confirmed');
    expect(records[0]!.senderDisplay).toBe('orders@shop.example');
    expect(records[0]!.deliveredToAddress).toBe('owner+alias@example.com');
    expect(records[0]!.deliveryEvidenceSource).toBe('alias-mailbox');
    expect(records[0]!.outcome).toBe('matched-expectation');
    expect(records[0]!.noticeStatus).toBe('delivered');
    expect(records[0]!.links).toEqual([{ registrableDomain: 'shop.example', verdict: 'allowed' }]);
  });

  test('a record whose outcome is matched-expectation still reports as matched', async () => {
    // The expectation mechanism reads the LIVE message body, not this excerpt,
    // so redacting the excerpt cannot change a verdict. What it could break is
    // the record of that verdict, and it does not.
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ outcome: 'matched-expectation', body: `code inside, card ${CARD}` }));
    const records = await store.list();
    expect(records[0]!.outcome).toBe('matched-expectation');
  });

  test('an ordinary order confirmation is stored verbatim — long digit runs and all', async () => {
    // The consumer this capability exists to serve. Refusing or mangling this
    // is the failure mode redaction-instead-of-refusal is chosen to avoid.
    const body = [
      'Order 10029384 confirmed.',
      'Tracking 1Z999AA10123456784.',
      'Item 8823641 x2, total 129.99, delivery by 08/26.',
      'Questions? Call 555 123 4567 or 555 987 6543.',
    ].join('\n');
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body }));

    const records = await store.list();
    expect(records[0]!.bodyExcerpt).toBe(body);
    expect(records[0]!.bodyExcerpt).not.toContain('[redacted');
  });

  test('a verification code is not mistaken for a security code and destroyed', async () => {
    const body = 'Your verification code is 481902. It expires in 10 minutes.';
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body }));
    expect((await store.list())[0]!.bodyExcerpt).toBe(body);
  });

  test('a four-digit code in a message that also mentions a card is redacted from the excerpt only', async () => {
    // In card context a bare four-digit run DOES count, so it is redacted here.
    // That is the intended trade for the stored copy; the live body the
    // expectation matcher reads is a different string and is untouched.
    const body = 'Your card verification code is 1234.';
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body }));
    const excerpt = (await store.list())[0]!.bodyExcerpt;
    expect(excerpt).toContain('[redacted:security-code]');
    expect(excerpt).toContain('Your card verification code is');
  });
});

describe('the excerpt stays within its bounds after redaction', () => {
  test('redaction never pushes the excerpt past the policy cap', async () => {
    const store = new InboundMailStore(storePath, { policy: { maxBodyExcerptChars: 120 } });
    // Many short runs in card context: each redaction marker is longer than the
    // digits it replaces, so this is the case that would overflow a naive
    // redact-after-slice.
    const body = `card ${'123 '.repeat(200)}`;
    await store.record(recordInput({ body }));
    const records = await store.list();
    expect(records[0]!.bodyExcerpt.length).toBeLessThanOrEqual(120);
  });

  test('a redacted subject stays within the length the validator accepts', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ subject: `card ${'123 '.repeat(300)}` }));
    const reloaded = new InboundMailStore(storePath);
    const records = await reloaded.list();
    // A subject that grew past 998 chars would fail validateInboundMailRecord
    // on load and take the whole record with it.
    expect(records).toHaveLength(1);
    expect(records[0]!.subject.length).toBeLessThanOrEqual(998);
  });

  test('the hard excerpt cap still binds', async () => {
    const store = new InboundMailStore(storePath);
    await store.record(recordInput({ body: 'y'.repeat(MAX_BODY_EXCERPT_CHARS + 5_000) }));
    const records = await store.list();
    expect(records[0]!.bodyExcerpt.length).toBe(MAX_BODY_EXCERPT_CHARS);
  });
});
