/**
 * inbound-mail-intake.test.ts
 *
 * What the supervisor's sink handler does with a message, and specifically the
 * one decision that decides whether the owner hears about mail at all: which
 * failures put the message back and which declare it done.
 *
 * The sink claims a message BEFORE the work runs, so a thrown error is what
 * releases the claim and leaves the cursor below the message. Throwing is
 * therefore how a message gets another chance, and returning is how it is
 * declared handled. Get that backwards in either direction and the failure is
 * silent: a transport blip that resolves swallows the notice forever, and a
 * structural refusal that throws pins the cursor on a message which fails
 * identically on every future pass while the mailbox never drains.
 *
 * Also covered: a refusal is RECORDED. `InboundNoticeStatus` used to be a
 * hand-written mirror of `SurfaceNoticeRefusal` that omitted `empty-text` and
 * `unsupported-delivery-surface`, so a record carrying either would have been
 * discarded by its own validator on the next load — the one case the owner
 * most needs ("mail arrived and could not be announced") was the case that
 * vanished at restart.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailIntake,
  InboundExpectationRegistry,
  InboundMailStore,
  InboundNoticeTransportError,
  PersistedExpectationStore,
  type InboundNoticeMode,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { GmailInboundMessage, ImapInboundMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { SurfaceNoticeDelivery } from '../packages/sdk/src/platform/daemon/types.ts';

const NOW = new Date('2026-07-27T12:00:00.000Z');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-inbound-intake-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function message(overrides: Partial<ImapInboundMessage> = {}): ImapInboundMessage {
  return {
    source: 'imap',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'noreply@github.com',
    subject: 'Verify your email',
    claimedDate: 'Mon, 27 Jul 2026 11:59:00 +0000',
    messageId: '<abc@github.com>',
    deliveredTo: ['owner+gv-github-com@example.com'],
    unverifiedToHeaderClaim: 'owner@example.com',
    uidValidity: 42,
    uid: 137,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
    ...overrides,
  };
}

/** The resolution a rig with no route answers with. */
const NO_ROUTE = {
  kind: 'unavailable',
  reason: 'no-route-binding',
  detail: 'no channel has ever been connected.',
  fix: 'Connect a channel.',
} as const;

function rig(options: {
  readonly delivery: SurfaceNoticeDelivery;
  readonly mode?: InboundNoticeMode;
  readonly binding?: { readonly surfaceKind: 'telegram' } | null;
}) {
  const sent: string[] = [];
  const records = new InboundMailStore(join(dir, 'records.json'));
  const intake = createInboundMailIntake({
    // The real registry-backed matcher — the same object production wires —
    // with no expectation open: the honest `no-expectation` verdict, which is
    // what most arriving mail produces. Deliberately not a hand-built double:
    // the port carries a write-through obligation on both of its verbs, and a
    // stub satisfies the shape without ever exercising it.
    expectations: new InboundExpectationRegistry({
      store: new PersistedExpectationStore(join(dir, 'expectations.json')),
      authority: { surfaceHasCommandAuthority: () => false },
      now: () => NOW,
    }).matcher,
    records,
    notices: {
      resolveBinding: () => (options.binding === undefined || options.binding !== null
        ? { kind: 'bound' as const, binding: { surfaceKind: 'telegram' as const } }
        : NO_ROUTE),
      send: async (text) => { sent.push(text); return options.delivery; },
    },
    noticeMode: () => options.mode ?? 'all',
    now: () => NOW,
  });
  return { intake, records, sent };
}

describe('which failures put the message back', () => {
  test('a transport failure throws, so the sink releases its claim and the cursor stays put', async () => {
    const { intake, records } = rig({
      delivery: { delivered: false, reason: 'delivery-failed', error: 'socket hang up' },
    });
    await expect(intake(message())).rejects.toBeInstanceOf(InboundNoticeTransportError);
    // The record IS written — it goes in before the notice is attempted, which
    // is what stops a failing store write from re-announcing — and it sits at
    // `pending`, which is the true statement about a notice that never
    // resolved. It used to assert zero records here, back when the notice went
    // first and the record after it.
    const stored = await records.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('pending');
  });

  test('a structural refusal is recorded and does NOT throw, so the mailbox drains', async () => {
    const { intake, records } = rig({
      delivery: { delivered: false, reason: 'surface-delivery-disabled' },
    });
    await intake(message());
    const stored = await records.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('surface-delivery-disabled');
  });

  test('a refusal the old hand-written status list omitted survives a reload', async () => {
    const { intake, records } = rig({
      delivery: { delivered: false, reason: 'unsupported-delivery-surface' },
    });
    await intake(message());
    expect((await records.list())[0]!.noticeStatus).toBe('unsupported-delivery-surface');
    // The validator re-checks every field on load. Before the projection fix
    // this status was not in the accepted set, so the record was discarded
    // here and the owner lost the fact that mail could not be announced.
    const reloaded = new InboundMailStore(join(dir, 'records.json'));
    expect(await reloaded.list()).toHaveLength(1);
    expect((await reloaded.list())[0]!.noticeStatus).toBe('unsupported-delivery-surface');
  });

  test('no notice route is recorded as such, with the message still declared handled', async () => {
    const { intake, records, sent } = rig({ delivery: { delivered: true }, binding: null });
    await intake(message());
    expect(sent).toEqual([]);
    expect((await records.list())[0]!.noticeStatus).toBe('no-route-binding');
  });
});

function gmailMessage(overrides: Partial<GmailInboundMessage> = {}): GmailInboundMessage {
  return {
    source: 'gmail',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'noreply@github.com',
    subject: 'Verify your email',
    claimedDate: 'Mon, 27 Jul 2026 11:59:00 +0000',
    messageId: '<abc@github.com>',
    deliveredTo: ['owner+gv-github-com@example.com'],
    unverifiedToHeaderClaim: 'owner@example.com',
    resourceId: '18f0a2b3c4d5e6f7',
    historyId: '9876543210',
    body: 'Receipt attached.',
    via: 'poll',
    ...overrides,
  };
}

describe('a Gmail message is recorded, not announced-and-forgotten', () => {
  test('it reaches the store with its own identity', async () => {
    // The intake used to return early for Gmail — announced, never recorded —
    // because the store keyed every record on a positive UIDVALIDITY and UID.
    // On the path automatic selection makes the default, that meant §9.3 had
    // nothing to retain and email.inbound.status truthfully reported zero.
    const { intake, records, sent } = rig({ delivery: { delivered: true } });
    await intake(gmailMessage());

    expect(sent).toHaveLength(1);
    const stored = (await records.list())[0]!;
    expect(stored.source).toBe('gmail');
    if (stored.source !== 'gmail') throw new Error('narrowing failed');
    expect(stored.resourceId).toBe('18f0a2b3c4d5e6f7');
    expect(stored.historyId).toBe('9876543210');
    expect(stored.noticeStatus).toBe('delivered');
  });

  test('its body is retained and card-redacted, unlike the IMAP envelope pass', async () => {
    // Gmail's history delta carries the body; IMAP's envelope pass does not.
    // §11.0 redaction runs before persisting, and this is the path that gives
    // it something to redact — it had never executed.
    const { intake, records } = rig({ delivery: { delivered: true } });
    await intake(gmailMessage({
      body: 'Charged card 4111111111111111 today. Thanks.',
      subject: 'Card 4111 1111 1111 1111 charged',
    }));

    const stored = (await records.list())[0]!;
    expect(stored.bodyExcerpt).not.toContain('4111111111111111');
    expect(stored.bodyExcerpt).toContain('Charged card');
    expect(stored.subject).not.toContain('4111 1111 1111 1111');
  });

  test('an IMAP message still retains no body, because none was fetched', async () => {
    const { intake, records } = rig({ delivery: { delivered: true } });
    await intake(message());
    const stored = (await records.list())[0]!;
    expect(stored.bodyExcerpt).toBe('');
  });
});

describe('what is recorded', () => {
  test('a delivered notice records the delivery evidence, never the To: header claim', async () => {
    const { intake, records, sent } = rig({ delivery: { delivered: true } });
    await intake(message());
    expect(sent).toHaveLength(1);
    const stored = (await records.list())[0]!;
    expect(stored.noticeStatus).toBe('delivered');
    expect(stored.deliveredToAddress).toBe('owner+gv-github-com@example.com');
    expect(stored.deliveryEvidenceSource).toBe('delivered-to-header');
    expect(stored.outcome).toBe('no-expectation');
  });

  test('a message with no delivery evidence is recorded as such rather than correlated on To:', async () => {
    const { intake, records } = rig({ delivery: { delivered: true } });
    await intake(message({ deliveredTo: [] }));
    const stored = (await records.list())[0]!;
    expect(stored.deliveredToAddress).toBeNull();
    expect(stored.deliveryEvidenceSource).toBe('none');
    expect(stored.outcome).toBe('no-delivery-evidence');
  });

  test('notice.mode "none" announces nothing and records the suppression', async () => {
    const { intake, records, sent } = rig({ delivery: { delivered: true }, mode: 'none' });
    await intake(message());
    expect(sent).toEqual([]);
    expect((await records.list())[0]!.noticeStatus).toBe('suppressed');
  });

  test('notice.mode "expected-only" stays quiet for unsolicited mail', async () => {
    const { intake, sent } = rig({ delivery: { delivered: true }, mode: 'expected-only' });
    await intake(message());
    expect(sent).toEqual([]);
  });
});
