/**
 * inbound-mail-expectation-consume-durability.test.ts
 *
 * The two halves of "a grant is spent exactly once", which used to fail in
 * opposite directions at the same time.
 *
 * 1. A CONSUMING MATCH REACHES DISK (docs/inbound-email.md §9.2).
 *    `expectation-store.ts`'s header names the three book mutations that must
 *    be mirrored, "open, close, **consuming match**". The registry wrote
 *    through on open, cancel, sweep and hydrate, and on nothing at all on the
 *    match path: `matchCandidate` deleted from the in-memory book and the file
 *    still held the record. The daemon checks for updates hourly and restarts
 *    itself at idle, so `hydrate()` brought the spent grant back, and a second
 *    message to the same alias inside the window satisfied an expectation that
 *    had already been used. A single-use grant, honoured twice, on a schedule
 *    the product itself sets.
 *
 * 2. A PASS THAT DOES NOT COMPLETE SPENDS NOTHING.
 *    `matchCandidate` defaults to `consume: true`, so the intake deleted the
 *    expectation before it had tried to send the notice. On `delivery-failed`
 *   , the one failure the design explicitly retries, the intake threw with
 *    the grant already gone: the sink released its claim, the message was
 *    redelivered exactly as intended, and pass 2 found an empty book and
 *    recorded `no-expectation`. The retry recovered the notice and destroyed
 *    the correlation it was about; the owner was told his own verification
 *    mail was unsolicited.
 *
 * The rule the intake now holds, and what these tests pin: a pass either
 * completes, or it leaves the book exactly as it found it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailIntake,
  InboundExpectationRegistry,
  InboundMailStore,
  PersistedExpectationStore,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { ImapInboundMessage, InboundMailboxMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { StructuredNotice } from '../packages/sdk/src/platform/email/inbound-notice.ts';
import type { SurfaceNoticeDelivery } from '../packages/sdk/src/platform/daemon/types.ts';

const ALIAS = 'signup-a1b2@his-catchall.test';
const NOW = new Date('2026-07-27T10:00:00.000Z');
const WINDOW_MS = 15 * 60_000;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-expect-consume-'));
  dirs.push(dir);
  return dir;
}

// Returns the IMAP variant specifically. It builds one, uidValidity, uid, an
// envelope, so the narrow type is the true one; typing it as the union meant
// every read of `.uid` or `.envelope` downstream needed a cast.
function mail(uid: number): ImapInboundMessage {
  return {
    source: 'imap',
    account: 'acct-1',
    mailbox: 'INBOX',
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Mon, 27 Jul 2026 10:00:00 +0000',
    messageId: `<${String(uid)}@service.test>`,
    // Top-most Delivered-To: the branded correlation key.
    deliveredTo: [ALIAS],
    unverifiedToHeaderClaim: ALIAS,
    uidValidity: 1000,
    uid,
    // A real envelope, not `{} as …`: an empty object asserted into a
    // ten-field type is what let this fixture drift from the real shape.
    envelope: {
      uid,
      from: 'verify@service.test',
      subject: 'Confirm your account',
      date: 'Mon, 27 Jul 2026 10:00:00 +0000',
      messageId: `<${String(uid)}@service.test>`,
      mailbox: 'INBOX',
      deliveredTo: [ALIAS],
      deliveryEvidence: [],
      unverifiedToHeaderClaim: ALIAS,
      authenticationResults: [],
    },
    via: 'poll',
  };
}

function registryAt(path: string): InboundExpectationRegistry {
  return new InboundExpectationRegistry({
    store: new PersistedExpectationStore(path, { now: () => NOW }),
    now: () => NOW,
    defaultWindowMs: WINDOW_MS,
  });
}

function intakeFor(options: {
  readonly registry: InboundExpectationRegistry;
  readonly records: InboundMailStore;
  readonly send?: (notice: StructuredNotice) => Promise<SurfaceNoticeDelivery>;
}): (message: InboundMailboxMessage) => Promise<void> {
  return createInboundMailIntake({
    expectations: options.registry.matcher,
    records: options.records,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: options.send ?? (async () => ({ delivered: true })),
    },
    noticeMode: () => 'all',
    now: () => NOW,
  });
}

describe('a consuming match is written through, so a restart cannot resurrect it', () => {
  test('the store no longer holds the grant the moment the message has consumed it', async () => {
    const dir = scratch();
    const path = join(dir, 'expectations.json');
    const registry = registryAt(path);
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    const records = new InboundMailStore(join(dir, 'records.json'));
    await intakeFor({ registry, records })(mail(101));

    expect(registry.list()).toHaveLength(0);
    expect((await records.list())[0]?.outcome).toBe('matched-expectation');
    // The assertion the defect inverted: memory and disk agree.
    expect(await new PersistedExpectationStore(path, { now: () => NOW }).list()).toHaveLength(0);
  });

  test('a restart between the two messages does not bring the spent grant back', async () => {
    const dir = scratch();
    const path = join(dir, 'expectations.json');

    // --- daemon run #1 ---
    const first = registryAt(path);
    await first.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });
    const records1 = new InboundMailStore(join(dir, 'records1.json'));
    await intakeFor({ registry: first, records: records1 })(mail(101));
    expect((await records1.list())[0]?.outcome).toBe('matched-expectation');

    // --- the hourly update check restarts the daemon ---
    const second = registryAt(path);
    expect((await second.hydrate()).restored).toBe(0);

    // --- a SECOND message to the same alias, inside the same window ---
    const records2 = new InboundMailStore(join(dir, 'records2.json'));
    await intakeFor({ registry: second, records: records2 })(mail(102));
    // Single-use means single-use across a restart too.
    expect((await records2.list())[0]?.outcome).toBe('no-expectation');
  });

  test('an expiry the match path deleted is cleared from the FILE, not just from memory', async () => {
    // The other mutation `matchCandidate` makes: an expectation past its window
    // is deleted on the way to reporting it `expired`, and the no-match path
    // sweeps the rest. Asserted against the raw file on purpose, the store's
    // own read path filters expired records, so every API-level view of this
    // agrees whether or not the write ever happened, and only the bytes on
    // disk distinguish a mirror that is current from one that is stale.
    const dir = scratch();
    const path = join(dir, 'expectations.json');
    const store = new PersistedExpectationStore(path, { now: () => NOW });
    const registry = new InboundExpectationRegistry({
      store, now: () => NOW, defaultWindowMs: WINDOW_MS,
    });
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });
    expect(JSON.parse(readFileSync(path, 'utf-8')).expectations).toHaveLength(1);

    // Asked AFTER the window closed.
    const later = new Date(NOW.getTime() + WINDOW_MS + 60_000);
    const match = await registry.matcher.matchCandidate({
      messageId: '<late@service.test>',
      from: 'verify@service.test',
      deliveredTo: { address: ALIAS, source: 'delivered-to-header' } as never,
      toHeaderClaim: ALIAS,
      subject: 'Confirm your account',
      body: '',
    }, later, { consume: false });
    expect(match.kind).toBe('expired');

    // The book dropped it; the mirror has to have dropped it too.
    expect(JSON.parse(readFileSync(path, 'utf-8')).expectations).toHaveLength(0);
  });

  test('an unspent grant still survives the restart it was persisted for', async () => {
    // The write-through must not have turned into "clear the file on every
    // message", the store exists because an expectation opened at 14:58 has
    // to survive a 15:00 restart.
    const dir = scratch();
    const path = join(dir, 'expectations.json');
    const first = registryAt(path);
    await first.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    // Mail for a DIFFERENT alias: asked about, not matched, nothing spent.
    const records = new InboundMailStore(join(dir, 'records.json'));
    const other = { ...mail(101), deliveredTo: ['someone-else@his-catchall.test'] } as InboundMailboxMessage;
    await intakeFor({ registry: first, records })(other);
    expect((await records.list())[0]?.outcome).toBe('recipient-mismatch');

    const second = registryAt(path);
    expect((await second.hydrate()).restored).toBe(1);
  });
});

describe('a pass that does not complete leaves the book exactly as it found it', () => {
  test('a failed notice keeps the expectation, so the redelivery still correlates', async () => {
    const dir = scratch();
    const registry = registryAt(join(dir, 'expectations.json'));
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    const records = new InboundMailStore(join(dir, 'records.json'));
    let attempt = 0;
    const intake = intakeFor({
      registry,
      records,
      send: async () => {
        attempt += 1;
        // Pass 1: the transport is down, the documented retryable case.
        return attempt === 1
          ? { delivered: false, reason: 'delivery-failed', error: 'socket hang up' }
          : { delivered: true };
      },
    });

    // Pass 1 throws, which is how the claim is released and the message redelivered.
    await expect(intake(mail(101))).rejects.toThrow(/could not be delivered/);
    // Nothing spent, because nothing completed.
    expect(registry.list()).toHaveLength(1);

    // Pass 2: the same message, redelivered exactly as designed.
    await intake(mail(101));
    expect((await records.list())[0]?.outcome).toBe('matched-expectation');
    // And NOW it is spent, once, by the pass that finished.
    expect(registry.list()).toHaveLength(0);
  });

  test('a failed record write also leaves the grant open for the retry', async () => {
    // The other throw on this path. The file header says a failed store write
    // throws "because a retry can genuinely do better", which is only true if
    // the retry still has the expectation to match against.
    const dir = scratch();
    const registry = registryAt(join(dir, 'expectations.json'));
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    let sends = 0;
    const intake = createInboundMailIntake({
      expectations: registry.matcher,
      records: {
        findByMessage: async () => null,
        record: async () => { throw new Error('disk full'); },
      } as never,
      notices: {
        resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
        send: async () => { sends += 1; return { delivered: true }; },
      },
      noticeMode: () => 'all',
      now: () => NOW,
    });

    await expect(intake(mail(101))).rejects.toThrow(/disk full/);
    expect(registry.list()).toHaveLength(1);
    // And the write that failed happened BEFORE the notice, so the owner was
    // not told about a message this pass is going to hand back for retry.
    expect(sends).toBe(0);
  });

  test('a structural refusal DOES complete the pass, so the grant is spent', async () => {
    // The counterpart, so "leaves the book alone" is not read as "never
    // consumes". A refusal that no retry can clear is a finished pass: the
    // message is recorded with its reason and the mailbox drains.
    const dir = scratch();
    const registry = registryAt(join(dir, 'expectations.json'));
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    const records = new InboundMailStore(join(dir, 'records.json'));
    await intakeFor({
      registry,
      records,
      send: async () => ({ delivered: false, reason: 'surface-delivery-disabled' }),
    })(mail(101));

    expect((await records.list())[0]?.outcome).toBe('matched-expectation');
    expect(registry.list()).toHaveLength(0);
  });
});

describe('the port the inbound path holds', () => {
  test('consumeMatch spends only what the book itself handed back', async () => {
    const dir = scratch();
    const registry = registryAt(join(dir, 'expectations.json'));
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });

    // Every non-match kind is a no-op, the caller cannot spend a grant by
    // handing back a verdict that never named one.
    await registry.matcher.consumeMatch({ kind: 'no-expectation', reason: 'none open' });
    expect(registry.list()).toHaveLength(1);

    const match = await registry.matcher.matchCandidate({
      messageId: '<x@service.test>',
      from: 'verify@service.test',
      deliveredTo: { address: ALIAS, source: 'delivered-to-header' } as never,
      toHeaderClaim: ALIAS,
      subject: 'Confirm your account',
      body: '',
    }, NOW, { consume: false });
    expect(match.kind).toBe('matched');
    // Asked without consuming: still open.
    expect(registry.list()).toHaveLength(1);

    await registry.matcher.consumeMatch(match);
    expect(registry.list()).toHaveLength(0);
  });
});
