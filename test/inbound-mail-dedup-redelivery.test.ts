/**
 * The guard on a redelivery the design causes on purpose.
 *
 * The watcher advances its cursor only after a message is fully processed, so
 * a failure between fetch and completion leaves the cursor below the message
 * and the next pass fetches it again. That is the right trade only if
 * something suppresses the duplicate — otherwise the recovery mechanism is
 * itself a defect, and a reconnect loop becomes a stream of repeated
 * notifications on the owner's phone. This platform has shipped that class of
 * defect once already, on ntfy, where one message produced two agents.
 *
 * The end-to-end cases drive the REAL watcher against the fake IMAP server
 * with the real persisted cursor store, because the interaction being tested
 * is precisely between the cursor rule and the dedup cache. A unit test of the
 * sink alone would not have caught either of the two orderings that matter:
 * a claim that outlives a failed attempt, and a suppression that stalls the
 * cursor.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { InboundMessageDedup } from '../packages/sdk/src/platform/adapters/inbound-dedup.ts';
import {
  DEFAULT_INBOUND_MAIL_DEDUP_TTL_MS,
  DedupingInboundMailSink,
  createInboundMailDedup,
  inboundMailDedupKey,
  inboundMailSourceIdentity,
} from '../packages/sdk/src/platform/email/inbound/sink.ts';
import {
  InboundMailboxWatcher,
  imapMailboxConnectionPort,
  resolveWatcherSettings,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { InboundMailboxMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxServer } from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  RecordingObserver,
  fixedRandom,
  makeCursorStore,
  waitFor,
  type RecordingCursorStore,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

interface Live { readonly watcher: InboundMailboxWatcher; readonly mailbox: FakeMailboxServer }
const live: Live[] = [];

afterEach(async () => {
  while (live.length > 0) {
    const entry = live.pop();
    if (entry === undefined) continue;
    await entry.watcher.stop();
    entry.mailbox.close();
  }
});

function message(uid: number, subject: string) {
  return { uid, from: `s${uid}@sender.test`, subject, deliveredTo: 'watched@example.test' };
}

/** One notice per message is what the owner should end up with. */
interface Harness {
  readonly watcher: InboundMailboxWatcher;
  readonly clock: FakeClock;
  readonly cursors: RecordingCursorStore;
  readonly mailbox: FakeMailboxServer;
  readonly notices: number[];
  readonly handled: number[];
  failOnce: Set<number>;
}

async function build(): Promise<Harness> {
  const mailbox = await makeFakeMailbox({ initial: [message(101, 'already here')] });
  const clock = new FakeClock();
  const { store: cursors } = await makeCursorStore();
  const notices: number[] = [];
  const handled: number[] = [];
  const failOnce = new Set<number>();

  const sink = new DedupingInboundMailSink({
    dedup: createInboundMailDedup(),
    handle: async (msg: InboundMailboxMessage) => {
      handled.push(msg.uid);
      if (failOnce.has(msg.uid)) {
        failOnce.delete(msg.uid);
        // A notice that could not be delivered — the exact failure between
        // fetch and completion the cursor rule is built around.
        throw new Error(`could not deliver the notice for UID ${String(msg.uid)}`);
      }
      notices.push(msg.uid);
    },
  });

  const watcher = new InboundMailboxWatcher({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX }),
    connections: imapMailboxConnectionPort({
      connect: () => openMailboxSocket(mailbox.port),
      username: 'watched@example.test',
      password: 'an-app-password',
      mailbox: MAILBOX,
      timeoutMs: 2_000,
    }),
    cursors,
    sink,
    clock,
    random: fixedRandom(0.5),
    observer: new RecordingObserver(),
  });
  live.push({ watcher, mailbox });
  return { watcher, clock, cursors, mailbox, notices, handled, failOnce };
}

describe('identity is per-source and server-assigned', () => {
  test('IMAP identity is the UID under its UIDVALIDITY generation', () => {
    expect(inboundMailSourceIdentity({ source: 'imap', uidValidity: 42, uid: 101 }))
      .toBe('imap:42:101');
    // The same UID under a different generation is a DIFFERENT message: a
    // rebuilt mailbox reissues UIDs from 1, so dropping the generation would
    // suppress new mail as a repeat of mail that no longer exists.
    expect(inboundMailSourceIdentity({ source: 'imap', uidValidity: 43, uid: 101 }))
      .not.toBe(inboundMailSourceIdentity({ source: 'imap', uidValidity: 42, uid: 101 }));
  });

  test('Gmail identity is the id Gmail assigned, since it has no UID', () => {
    expect(inboundMailSourceIdentity({ source: 'gmail', messageId: '18f0a' }))
      .toBe('gmail:18f0a');
  });

  test('an unusable id yields no key, so the message is delivered rather than collapsed', () => {
    // '' makes claim() return true. The alternative — a shared empty key —
    // would suppress every id-less message after the first one.
    expect(inboundMailSourceIdentity({ source: 'gmail', messageId: '  ' })).toBe('');
    expect(inboundMailSourceIdentity({ source: 'imap', uidValidity: 0, uid: 5 })).toBe('');
    expect(new InboundMessageDedup().claim('')).toBe(true);
  });

  test('the key is scoped per mailbox, so two mailboxes do not suppress each other', () => {
    const first = inboundMailDedupKey({
      account: 'a', mailbox: 'INBOX', id: { source: 'imap', uidValidity: 42, uid: 7 },
    });
    const second = inboundMailDedupKey({
      account: 'a', mailbox: 'Archive', id: { source: 'imap', uidValidity: 42, uid: 7 },
    });
    expect(first).not.toBe(second);
  });

  test('the email cache outlives a restart cycle, unlike the shared ntfy default', () => {
    // Ten minutes — the module default — is shorter than a crash-restart, and
    // the daemon restarts itself hourly at idle. A message fetched just before
    // a restart would come back after it with its claim already expired.
    expect(DEFAULT_INBOUND_MAIL_DEDUP_TTL_MS).toBe(60 * 60_000);
  });
});

describe('a redelivered message produces exactly one notice', () => {
  test('a later wake does not re-offer an already-processed message at all', async () => {
    // The cursor is the FIRST line of defence and dedup is the second, and it
    // matters which is doing the work here. Once UID 102 is processed the
    // cursor sits at 102, so the next wake searches `UID SEARCH UID 103:*` and
    // the only thing that comes back is UID 102 — via the inverted-range quirk
    // where a range whose start exceeds the mailbox's highest UID matches that
    // highest UID. It is filtered out above the cursor, so the message is
    // never offered a second time and dedup is never consulted.
    //
    // Asserted explicitly because the first draft of this test assumed the
    // opposite and passed vacuously: it waited on a cursor advance that the
    // FIRST delivery had already satisfied, so the second pass never had to
    // happen for the assertion to hold.
    const harness = await build();
    harness.watcher.start();
    await waitFor(
      () => harness.mailbox.commands.some((line) => /^\S+ IDLE$/.test(line)),
      'the watcher to reach IDLE',
    );

    harness.mailbox.deliver('the only notice the owner should get');
    await waitFor(() => harness.notices.length >= 1, 'the first notice');

    // Push only once the watcher is back INSIDE an IDLE. An untagged line
    // arriving between rounds — after one round's subscription is released and
    // before the next IDLE is issued — has nobody waiting on it, so pushing
    // eagerly would test the harness's timing rather than the watcher.
    await waitFor(
      () => harness.mailbox.commands.filter((l) => /^\S+ IDLE$/.test(l)).length >= 2,
      'the watcher to re-issue IDLE after the first delivery',
    );
    const searchesBefore = harness.mailbox.commands.filter((l) => /UID SEARCH/.test(l)).length;
    harness.mailbox.push('* 2 EXISTS');
    await waitFor(
      () => harness.mailbox.commands.filter((l) => /UID SEARCH/.test(l)).length > searchesBefore,
      'the second pass to search the mailbox again',
    );

    // Searched again, found nothing above the cursor, offered nothing.
    expect(harness.handled).toEqual([102]);
    expect(harness.notices).toEqual([102]);
    expect(harness.mailbox.commands.some((l) => l.endsWith('UID SEARCH UID 103:*'))).toBe(true);
  });

  test('a failure between fetch and completion redelivers AND still notices once', async () => {
    // The interaction the whole design rests on. The first attempt fails after
    // the message was claimed, so the claim has to be given back or the retry
    // is suppressed as a duplicate of an attempt that never finished — and the
    // owner is told nothing at all, which is worse than being told twice.
    const harness = await build();
    harness.failOnce.add(102);
    harness.watcher.start();
    await waitFor(
      () => harness.mailbox.commands.some((line) => /^\S+ IDLE$/.test(line)),
      'the watcher to reach IDLE',
    );

    harness.mailbox.deliver('must survive a failed first attempt');

    await waitFor(() => harness.handled.length >= 1, 'the first, failing attempt');
    expect(harness.notices).toEqual([]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(101);

    await harness.clock.waitForDue(1_000, 'the pause after the failed delivery');
    await harness.clock.advance(1_000);

    await waitFor(() => harness.notices.length >= 1, 'the redelivered message to be announced');
    expect(harness.handled).toEqual([102, 102]);
    expect(harness.notices).toEqual([102]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(102);
  });

  test('a suppressed duplicate still advances the cursor, so the mailbox drains', async () => {
    // Suppression resolves rather than throwing. Throwing would pin the cursor
    // below a message that is suppressed again on every pass, and the watcher
    // would re-fetch it forever while making no progress.
    const dedup = createInboundMailDedup();
    const handled: number[] = [];
    const sink = new DedupingInboundMailSink({
      dedup,
      handle: async (msg) => { handled.push(msg.uid); },
    });
    const msg = {
      account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, uid: 7,
      envelope: { uid: 7 } as InboundMailboxMessage['envelope'], via: 'idle' as const,
    };

    await sink.deliver(msg);
    await expect(sink.deliver(msg)).resolves.toBeUndefined();
    expect(handled).toEqual([7]);
  });

  test('two concurrent deliveries of one message run the pipeline once', async () => {
    // An IDLE wake and a fallback poll overlapping. The claim is taken before
    // the work for exactly this case.
    const dedup = createInboundMailDedup();
    const handled: number[] = [];
    let release: (() => void) | null = null;
    const sink = new DedupingInboundMailSink({
      dedup,
      handle: async (msg) => {
        handled.push(msg.uid);
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    const msg = {
      account: ACCOUNT, mailbox: MAILBOX, uidValidity: 42, uid: 9,
      envelope: { uid: 9 } as InboundMailboxMessage['envelope'], via: 'idle' as const,
    };

    const first = sink.deliver(msg);
    await waitFor(() => handled.length === 1, 'the first delivery to start');
    await sink.deliver(msg); // the concurrent second arrival
    release?.();
    await first;

    expect(handled).toEqual([9]);
  });
});
