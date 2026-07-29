/**
 * §12 gate #14 — a `Message-ID` collision cannot suppress a message.
 *
 * `Message-ID` is written by whoever sent the mail. If it were ever the
 * identity a duplicate is judged by, anybody able to send a message could
 * silence a later one by reusing its id: the owner would see one notice where
 * two messages arrived, and the missing one would be whichever the attacker
 * chose. Identity is therefore the SERVER-assigned UID under its UIDVALIDITY
 * generation, and this file is the proof that a collision on the header does
 * nothing.
 *
 * ## Why this gate had no test until now
 *
 * It was **unconstructible**. `fake-imap-mailbox.ts` minted
 * `Message-ID: <uid-N@example.test>` per UID with no way to override it, so a
 * collision could not be built and the gate could never be satisfied as
 * written — an entry on the test plan that no amount of effort could turn
 * green. The harness now takes an override, and this is what it is for.
 *
 * ## Why the mailbox starts empty
 *
 * A message already present when the watcher connects sits at or below the
 * high-water mark the cursor establishes at, and is never offered — that is
 * the no-backfill rule (§4) working correctly. Seeding one of the colliding
 * pair would therefore leave only ONE message actually delivered, and "both
 * were delivered" would be untestable while looking tested. Both arrive after
 * the watcher is watching, so both are genuinely above the cursor.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  DedupingInboundMailSink,
  createInboundMailDedup,
} from '../packages/sdk/src/platform/email/inbound/sink.ts';
import {
  InboundMailboxWatcher,
  resolveWatcherSettings,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type { InboundMailboxMessage } from '../packages/sdk/src/platform/email/inbound/ports.ts';
import { makeFakeMailbox, openMailboxSocket, type FakeMailboxServer } from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  RecordingObserver,
  fixedRandom,
  cleanupInboundScratch,
  makeCursorStore,
  nudgeUntil,
  waitFor,
  watcherConnectionPort,
  requireImapMessage,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
/** One id, reused. The header a sender controls completely. */
const FORGED_ID = '<collision@attacker.test>';

interface Live { readonly watcher: InboundMailboxWatcher; readonly mailbox: FakeMailboxServer }
const live: Live[] = [];

afterAll(() => { cleanupInboundScratch(); });

afterEach(async () => {
  while (live.length > 0) {
    const entry = live.pop();
    if (entry === undefined) continue;
    await entry.watcher.stop();
    entry.mailbox.close();
  }
});

interface Harness {
  readonly watcher: InboundMailboxWatcher;
  readonly mailbox: FakeMailboxServer;
  /** UIDs the pipeline actually ran for, in order. */
  readonly handled: number[];
  /** The `Message-ID` each handled message carried, in the same order. */
  readonly messageIds: string[];
}

async function build(): Promise<Harness> {
  const mailbox = await makeFakeMailbox({ initial: [] });
  const { store: cursors } = await makeCursorStore();
  const handled: number[] = [];
  const messageIds: string[] = [];

  const watcher = new InboundMailboxWatcher({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX }),
    connections: watcherConnectionPort({
      connect: () => openMailboxSocket(mailbox.port),
      username: 'watched@example.test',
      password: 'an-app-password',
      mailbox: MAILBOX,
      timeoutMs: 2_000,
    }),
    cursors,
    sink: new DedupingInboundMailSink({
      dedup: createInboundMailDedup(),
      handle: async (raw: InboundMailboxMessage) => {
        // This suite drives IMAP UIDs and envelope message-ids; narrow on the
        // discriminant rather than asserting the Gmail variant away.
        const message = requireImapMessage(raw, 'message-id collision handle');
        handled.push(message.uid);
        messageIds.push(message.envelope.messageId);
      },
    }),
    clock: new FakeClock(),
    random: fixedRandom(0.5),
    observer: new RecordingObserver(),
  });
  live.push({ watcher, mailbox });
  return { watcher, mailbox, handled, messageIds };
}

/** Wait until the watcher has issued its Nth IDLE, so a delivery has a listener. */
async function idleRounds(harness: Harness, count: number): Promise<void> {
  await waitFor(
    () => harness.mailbox.commands.filter((line) => /^\S+ IDLE$/.test(line)).length >= count,
    `IDLE round ${String(count)}`,
  );
}

describe('a forged Message-ID cannot suppress a message (gate #14)', () => {
  test('two messages sharing one Message-ID are BOTH delivered, under their own UIDs', async () => {
    const harness = await build();
    harness.watcher.start();
    await idleRounds(harness, 1);

    harness.mailbox.deliver('the first', FORGED_ID);
    // `nudgeUntil`, not `waitFor`, and see its header for why: `idleRounds`
    // reads the SERVER's command log, and the client registers the waiter that
    // ends the round one round trip later. A `deliver()` edge landing in that
    // window is seen by nobody who can act on it, and the only recovery is the
    // 27-minute re-issue on a `FakeClock` this test never advances — so it
    // presents as a hard timeout, not as slowness. Nothing is re-sent unless
    // the wake really was lost, and a duplicate wake cannot double-count here
    // anyway: the sink claims `imap:<uidValidity>:<uid>` before it runs.
    await nudgeUntil(harness.mailbox, () => harness.handled.length >= 1, 'the first message');

    // Pushed only once the watcher is back INSIDE an IDLE: a line arriving
    // between rounds has nobody waiting on it, and delivering eagerly would
    // test the harness's timing rather than the watcher.
    await idleRounds(harness, 2);
    harness.mailbox.deliver('the second, wearing the first message\'s identity', FORGED_ID);
    await nudgeUntil(harness.mailbox, () => harness.handled.length >= 2, 'the second message');

    expect(harness.handled).toEqual([101, 102]);
    // The collision was CONSTRUCTED, not merely intended. Without this the
    // test would pass just as well against the old harness, which minted a
    // distinct id per UID and made the gate unsatisfiable — a green test for a
    // property it never exercised.
    expect(harness.messageIds).toEqual([FORGED_ID, FORGED_ID]);
  });

  test('the harness really does forge it — the default is per-UID and distinct', async () => {
    // The control for the test above. If `deliver()` silently ignored the
    // override, both messages would carry `<uid-101…>` and `<uid-102…>` and
    // the collision assertion would be about two different strings.
    const harness = await build();
    harness.watcher.start();
    await idleRounds(harness, 1);

    harness.mailbox.deliver('no override');
    await nudgeUntil(harness.mailbox, () => harness.handled.length >= 1, 'the unforged message');

    expect(harness.messageIds).toEqual(['<uid-101@example.test>']);
    expect(harness.messageIds[0]).not.toBe(FORGED_ID);
  });
});
