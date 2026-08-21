/**
 * inbound-mail-dedup-restart-honesty.test.ts
 *
 * Three places in the tree used to assert that `dedupTtlMinutes` "must exceed a
 * restart cycle", that "an hour covers the auto-update restart", and that the
 * value "has a correctness floor". None of it was true, and no setting could
 * have made it true: `InboundMailSupervisor.runStart()` builds a brand new
 * `createInboundMailDedup(...)`, so a restart DESTROYS the cache rather than
 * expiring it, and `runStart()` runs on a config change and a cluster-gate
 * handoff as well as on a process restart.
 *
 * The live sequence that made it matter: UID 205 is announced, the daemon's
 * hourly auto-update restarts it before the cursor advance lands, the cursor is
 * still at 204, the message is fetched again into an empty cache, and the owner
 * is told a second time.
 *
 * This file pins both halves of the correction.
 *
 *  1. **What the cache genuinely cannot do.** The first test drives a real
 *     supervisor through a restart and shows the same message handled twice.
 *     It is not a fail-first reproduction of a wrong answer, it is a statement
 *     of an ABSENCE OF CAPABILITY, written down so the false comments cannot
 *     come back. It passes before and after the fix, by construction.
 *
 *  2. **What actually covers the restart.** The rest exercise the mechanism
 *     that does: the intake asks the record store whether this exact message
 *     was already announced, and that store is on disk. The failure direction
 *     is checked as carefully as the success one, anything the store cannot
 *     answer leads to announcing, because §6's ruling is that a duplicate beats
 *     silence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailIntake,
  InboundExpectationRegistry,
  InboundMailHousekeeper,
  InboundMailStore,
  InboundMailSupervisor,
  MailboxCursorStore,
  PersistedExpectationStore,
  type InboundMailSourceFactory,
  type InboundMailSupervisorDeps,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { DedupingInboundMailSink } from '../packages/sdk/src/platform/email/inbound/sink.ts';
import type { InboundMailSource } from '../packages/sdk/src/platform/email/inbound/source.ts';
import type {
  ImapInboundMessage,
  InboundCapabilityVerdict,
} from '../packages/sdk/src/platform/email/inbound/ports.ts';

const NOW = new Date('2026-07-28T09:00:00.000Z');
const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-dedup-restart-'));
  dirs.push(dir);
  return dir;
}

function mail(uid = 205, overrides: Partial<ImapInboundMessage> = {}): ImapInboundMessage {
  return {
    source: 'imap',
    account: ACCOUNT,
    mailbox: MAILBOX,
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: `<${String(uid)}@service.test>`,
    deliveredTo: ['signup-9f31@his-catchall.test'],
    unverifiedToHeaderClaim: 'signup-9f31@his-catchall.test',
    uidValidity: 1000,
    uid,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. What the in-memory cache cannot do, stated rather than claimed away
// ---------------------------------------------------------------------------

const HEALTHY: InboundCapabilityVerdict = {
  state: 'healthy',
  reason: 'idle-push',
  detail: 'The server advertised IDLE and is pushing.',
  fix: '',
};

/** A source that hands its sink back so a test can deliver through it. */
class SinkCapturingSource implements InboundMailSource {
  readonly kind = 'imap' as const;
  readonly latency = { kind: 'push' } as const;

  async start(): Promise<InboundCapabilityVerdict> { return HEALTHY; }

  async run(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
  }

  async stop(): Promise<void> { /* nothing to release */ }
}

describe('the dedup cache does not survive a restart, and no TTL changes that', () => {
  test('a config-change restart hands the source a fresh cache, so the same message is handled twice', async () => {
    // Honest framing: this is not a wrong answer being caught. It is the
    // capability the comments claimed and the mechanism does not have, written
    // down so the claim cannot be restated. `start()` is what the cluster gate
    // and a config change both call, and it builds a new cache every time.
    const dir = scratch();
    const sinks: DedupingInboundMailSink[] = [];
    const source = new SinkCapturingSource();
    const sources: InboundMailSourceFactory = {
      create: async (input) => { sinks.push(input.sink); return source; },
    };
    const handled: string[] = [];
    const cursors = new MailboxCursorStore(join(dir, 'cursors.json'), {
      isAccountConfigured: (account) => account === ACCOUNT,
    });
    const records = new InboundMailStore(join(dir, 'records.json'));
    const expectationStore = new PersistedExpectationStore(join(dir, 'expectations.json'), {
      now: () => NOW,
    });
    const supervisor = new InboundMailSupervisor({
      config: {
        get: (key: string) => ({
          'surfaces.email.inbound.enabled': true,
          'surfaces.email.inbound.source': 'imap',
          // The largest value the schema accepts. If the TTL could cover a
          // restart at ANY setting, it would cover it at this one.
          'surfaces.email.inbound.dedupTtlMinutes': 1440,
        } as Record<string, unknown>)[key],
      } as unknown as InboundMailSupervisorDeps['config'],
      account: ACCOUNT,
      mailbox: MAILBOX,
      sources,
      selectionFacts: async () => ({ googleAdopted: false, mailAccountIsGmail: false }),
      cursors,
      records,
      expectations: new InboundExpectationRegistry({ store: expectationStore, now: () => NOW }),
      expectationPolicy: expectationStore,
      housekeeper: new InboundMailHousekeeper({
        cursors,
        records,
        expectations: expectationStore,
        disclosurePath: join(dir, 'housekeeping.json'),
      }),
      handle: async (message) => {
        // Only the IMAP variant has a UID, the Gmail one is keyed on
        // historyId, so the identity is chosen on the discriminant. The old
        // `message.uid ?? 0` read a field that does not exist on half the
        // union, which is a different thing from a UID that is absent.
        const uid = message.source === 'imap' ? message.uid : 0;
        handled.push(`${message.account}:${String(uid)}`);
      },
    });

    try {
      await supervisor.start();
      await sinks[0]!.deliver(mail(205));
      // Within one process the cache does its job.
      await sinks[0]!.deliver(mail(205));
      expect(handled).toHaveLength(1);

      // The restart. Same supervisor, same config, same 1440-minute TTL.
      await supervisor.start();
      expect(sinks).toHaveLength(2);
      await sinks[1]!.deliver(mail(205));
    } finally {
      await supervisor.stop();
    }

    // Handled again. The claim was not expired, the object holding it was
    // replaced. This is the number the three comments said could not happen.
    expect(handled).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. What actually covers the restart: the record store
// ---------------------------------------------------------------------------

function intakeOver(store: InboundMailStore, dir: string, sent: unknown[]) {
  const expectationStore = new PersistedExpectationStore(join(dir, `expect-${String(sent.length)}-${String(Math.random())}.json`), {
    now: () => NOW,
  });
  return createInboundMailIntake({
    expectations: new InboundExpectationRegistry({ store: expectationStore, now: () => NOW }).matcher,
    records: store,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: async (notice) => { sent.push(notice); return { delivered: true }; },
    },
    noticeMode: () => 'all',
    now: () => NOW,
  });
}

describe('a message already announced is not announced again after a restart', () => {
  test('the second process sends nothing for a message its record says was delivered', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');

    // --- daemon run #1: announced, recorded, and then killed before the
    // cursor advance landed, which is why the message comes back at all.
    const first: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, first)(mail(205));
    expect(first).toHaveLength(1);

    // --- daemon run #2: a new process. New dedup cache, new intake, same
    // message above the same unadvanced cursor.
    const second: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, second)(mail(205));

    expect(second).toHaveLength(0);
    const stored = await new InboundMailStore(path).list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('delivered');
  });

  test('a record left at `pending` DOES get announced, because silence is the worse failure', async () => {
    // The safe direction, and the assertion that stops the guard turning into
    // a way to lose mail. A record that never reached `delivered` is not
    // evidence the owner was told, so the message is announced.
    const dir = scratch();
    const path = join(dir, 'records.json');
    const store = new InboundMailStore(path);
    await store.record({
      source: 'imap',
      account: ACCOUNT,
      mailbox: MAILBOX,
      uidValidity: 1000,
      uid: 205,
      senderDisplay: 'verify@service.test',
      subject: 'Confirm your account',
      deliveredToAddress: 'signup-9f31@his-catchall.test',
      deliveryEvidenceSource: 'delivered-to-header',
      links: [],
      outcome: 'no-expectation',
      noticeStatus: 'pending',
      body: '',
      receivedAt: NOW.toISOString(),
    });

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
    expect((await new InboundMailStore(path).list())[0]!.noticeStatus).toBe('delivered');
  });

  test('a record file that cannot be read leads to announcing, not to silence', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');
    writeFileSync(path, '{ this is not json', 'utf-8');
    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
  });

  test('a delivered record for a DIFFERENT mailbox does not suppress this one', async () => {
    // The key is scoped to the mailbox as well as the server-assigned id, and
    // a UID is only unique within its own UIDVALIDITY generation in its own
    // mailbox. A key that ignored either would let one mailbox silence another.
    const dir = scratch();
    const path = join(dir, 'records.json');
    const seed: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, seed)(
      mail(205, { mailbox: 'Archive' }),
    );
    expect(seed).toHaveLength(1);

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, sent)(mail(205));
    expect(sent).toHaveLength(1);
    expect(await new InboundMailStore(path).list()).toHaveLength(2);
  });

  test('a delivered record whose UIDVALIDITY generation changed does not suppress the new one', async () => {
    const dir = scratch();
    const path = join(dir, 'records.json');
    const seed: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, seed)(mail(205));
    expect(seed).toHaveLength(1);

    const sent: unknown[] = [];
    await intakeOver(new InboundMailStore(path), dir, sent)(
      mail(205, { uidValidity: 1001 }),
    );
    expect(sent).toHaveLength(1);
  });
});
