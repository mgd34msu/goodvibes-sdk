/**
 * inbound-mail-notice-before-record.test.ts
 *
 * The one step in the intake that cannot be undone is the notice: a message on
 * the owner's phone is not retractable. So it has to be the LAST thing that can
 * happen, and everything that might fail has to happen in front of it.
 *
 * It was the first thing. `notices.send` ran, `records.record` then threw, the
 * intake threw, the sink released its claim, the cursor stayed below the
 * message, and the watcher fetched it again — and announced it again, on every
 * pass, for as long as the store kept failing. Dedup could not suppress any of
 * it, because releasing the claim is exactly how the retry is enabled: the
 * guard against duplicate notices was the mechanism producing them.
 *
 * These drive the REAL sink around the REAL intake, because the defect only
 * exists at that seam. An intake called directly throws once and looks fine;
 * what makes it a defect is the redelivery the sink and the cursor are designed
 * to produce, so the redelivery is what these reproduce.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInboundMailDedup,
  createInboundMailIntake,
  DedupingInboundMailSink,
  InboundExpectationRegistry,
  InboundMailStore,
  PersistedExpectationStore,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { ImapInboundMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import type { SurfaceNoticeDelivery } from '../packages/sdk/src/platform/daemon/types.ts';
import type { InboundMailMessageKey, InboundMailRecordInput } from '../packages/sdk/src/platform/email/inbound/record-store.ts';

const NOW = new Date('2026-07-28T09:00:00.000Z');
const ALIAS = 'signup-9f31@his-catchall.test';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-notice-order-'));
  dirs.push(dir);
  return dir;
}

function mail(uid = 205): ImapInboundMessage {
  return {
    source: 'imap',
    account: 'primary',
    mailbox: 'INBOX',
    from: 'verify@service.test',
    subject: 'Confirm your account',
    claimedDate: 'Tue, 28 Jul 2026 08:59:00 +0000',
    messageId: `<${String(uid)}@service.test>`,
    deliveredTo: [ALIAS],
    unverifiedToHeaderClaim: ALIAS,
    uidValidity: 1000,
    uid,
    envelope: {} as ImapInboundMessage['envelope'],
    via: 'idle',
  };
}

function registryAt(dir: string): InboundExpectationRegistry {
  return new InboundExpectationRegistry({
    store: new PersistedExpectationStore(join(dir, 'expectations.json'), { now: () => NOW }),
    now: () => NOW,
  });
}

/**
 * The watcher's actual shape: a sink around the intake, driven repeatedly.
 *
 * A pass that rejects is what releases the claim and leaves the cursor below
 * the message, so `pass()` swallowing the rejection and being called again IS
 * the redelivery. Nothing here simulates the duplicate — it is produced by the
 * same mechanism production uses.
 */
function watcher(options: {
  readonly records: Parameters<typeof createInboundMailIntake>[0]['records'];
  readonly registry: InboundExpectationRegistry;
  readonly send: () => Promise<SurfaceNoticeDelivery>;
  readonly consumeThrows?: boolean;
}) {
  const sent: unknown[] = [];
  const matcher = options.consumeThrows === true
    ? {
      matchCandidate: options.registry.matcher.matchCandidate.bind(options.registry.matcher),
      consumeMatch: async () => { throw new Error('expectation mirror is read-only'); },
    }
    : options.registry.matcher;
  const intake = createInboundMailIntake({
    expectations: matcher,
    records: options.records,
    notices: {
      resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
      send: async (notice) => { sent.push(notice); return options.send(); },
    },
    noticeMode: () => 'all',
    now: () => NOW,
  });
  const sink = new DedupingInboundMailSink({
    dedup: createInboundMailDedup(60 * 60_000),
    handle: intake,
  });
  const failures: string[] = [];
  const pass = async (message = mail()): Promise<void> => {
    try {
      await sink.deliver(message);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  return { pass, sent, failures };
}

describe('a failing record write cannot produce a repeated announcement', () => {
  test('five redeliveries under a store that always fails produce ZERO notices', async () => {
    const dir = scratch();
    const registry = registryAt(dir);
    const rig = watcher({
      registry,
      // ENOSPC, a read-only state directory — the store simply cannot write.
      records: {
        findByMessage: async () => null,
        record: async () => { throw new Error('ENOSPC: no space left on device'); },
      } as never,
      send: async () => ({ delivered: true }),
    });

    for (let i = 0; i < 5; i += 1) await rig.pass();

    // Every pass failed, which is correct: the store really is broken and the
    // message really has not been dealt with.
    expect(rig.failures).toHaveLength(5);
    expect(rig.failures.every((message) => message.includes('ENOSPC'))).toBe(true);
    // And the owner's phone stayed quiet. Before the ordering fix this was 5:
    // the notice went out first and the record threw after it, so every
    // redelivery announced the same message again.
    expect(rig.sent).toHaveLength(0);
  });

  test('the same failure with the notice SUPPRESSED behaves identically, so the count is about ordering', async () => {
    // A control. If the zero above came from the notice never being reached
    // for some unrelated reason, this would be indistinguishable from it —
    // here the notice is deliberately not attempted, and the failure shape is
    // the same, which is what makes the previous case's zero mean something.
    const dir = scratch();
    const registry = registryAt(dir);
    const sent: unknown[] = [];
    const intake = createInboundMailIntake({
      expectations: registry.matcher,
      records: {
        findByMessage: async () => null,
        record: async () => { throw new Error('ENOSPC: no space left on device'); },
      } as never,
      notices: {
        resolveBinding: () => ({ kind: 'bound', binding: { surfaceKind: 'telegram' } }),
        send: async (notice) => { sent.push(notice); return { delivered: true }; },
      },
      noticeMode: () => 'none',
      now: () => NOW,
    });
    await expect(intake(mail())).rejects.toThrow(/ENOSPC/);
    expect(sent).toHaveLength(0);
  });
});

describe('nothing after the send may throw, because a throw there re-announces', () => {
  test('the record update that fails AFTER the notice completes the pass instead of retrying it', async () => {
    const dir = scratch();
    const registry = registryAt(dir);
    const store = new InboundMailStore(join(dir, 'records.json'));
    let writes = 0;
    const rig = watcher({
      registry,
      records: {
        findByMessage: (key: InboundMailMessageKey) => store.findByMessage(key),
        record: async (input: InboundMailRecordInput) => {
          writes += 1;
          // The FIRST write is the `pending` row, before the notice. The
          // second is the one carrying the real outcome, after it — and only
          // that one fails here.
          if (writes >= 2) throw new Error('ENOSPC: no space left on device');
          return store.record(input);
        },
      } as never,
      send: async () => ({ delivered: true }),
    });

    await rig.pass();

    // The pass COMPLETED. If it had thrown, the sink would release the claim,
    // the cursor would stay put, and the next pass would announce the message
    // a second time — the H1 defect reached through a different verb.
    expect(rig.failures).toEqual([]);
    expect(rig.sent).toHaveLength(1);
    // What was given up is stated rather than hidden: the record is still at
    // `pending`, which is the true thing to say about a notice status that
    // could not be written.
    expect((await store.list())[0]!.noticeStatus).toBe('pending');

    // And a redelivery of the same message does not announce it again either.
    await rig.pass();
    expect(rig.sent).toHaveLength(1);
  });

  test('a consume that fails after the notice completes the pass and leaves the grant open', async () => {
    const dir = scratch();
    const registry = registryAt(dir);
    await registry.open({
      serviceDomain: 'service.test', recipientAddress: ALIAS, purpose: 'Create an account',
    });
    const store = new InboundMailStore(join(dir, 'records.json'));
    const rig = watcher({
      registry,
      records: store,
      send: async () => ({ delivered: true }),
      consumeThrows: true,
    });

    await rig.pass();

    expect(rig.failures).toEqual([]);
    expect(rig.sent).toHaveLength(1);
    // The grant stays open. That is bounded by its own window and disclosed
    // when the window elapses; a duplicate notice is neither.
    expect(registry.list()).toHaveLength(1);
    expect((await store.list())[0]!.outcome).toBe('matched-expectation');
  });
});

describe('one message, one record, however many passes it takes', () => {
  test('four transport failures then a success leave exactly one record, not five', async () => {
    const dir = scratch();
    const registry = registryAt(dir);
    const store = new InboundMailStore(join(dir, 'records.json'));
    let attempt = 0;
    const rig = watcher({
      registry,
      records: store,
      send: async () => {
        attempt += 1;
        return attempt <= 4
          ? { delivered: false, reason: 'delivery-failed', error: 'socket hang up' }
          : { delivered: true };
      },
    });

    for (let i = 0; i < 5; i += 1) await rig.pass();

    expect(rig.failures).toHaveLength(4);
    const stored = await store.list();
    // The record now goes in before the notice, so an append-only store would
    // hold five rows for one message and `email.inbound.status` would report
    // five arrivals where the owner's phone buzzed once.
    expect(stored).toHaveLength(1);
    expect(stored[0]!.noticeStatus).toBe('delivered');
  });

  test('two different messages are still two records', async () => {
    // The counterpart, so "upsert" is not read as "collapse everything".
    const dir = scratch();
    const registry = registryAt(dir);
    const store = new InboundMailStore(join(dir, 'records.json'));
    const rig = watcher({ registry, records: store, send: async () => ({ delivered: true }) });

    await rig.pass(mail(205));
    await rig.pass(mail(206));

    expect(await store.list()).toHaveLength(2);
    expect(rig.sent).toHaveLength(2);
  });
});
