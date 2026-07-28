/**
 * The inbound-mail watcher against a scripted fake IMAP server.
 *
 * No real network (a loopback pair stands in for the mail host), no real
 * sleeping (the 27-minute IDLE re-issue and the backoff ceiling run on an
 * injected clock), and no test that waits minutes for anything.
 *
 * These are gates. Each asserts a behaviour that, if it regressed, would end
 * with the owner hearing nothing about mail that arrived — which is the exact
 * failure the capability exists to eliminate.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  InboundMailboxWatcher,
  imapMailboxConnectionPort,
  resolveWatcherSettings,
  IDLE_REISSUE_ADVISORY_BOUND_MS,
  type InboundWatcherSettings,
  type MailboxCursor,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import {
  makeFakeMailbox,
  openMailboxSocket,
  type FakeMailboxOptions,
  type FakeMailboxServer,
} from './_helpers/fake-imap-mailbox.ts';
import {
  FakeClock,
  makeCursorStore,
  RecordingObserver,
  RecordingSink,
  fixedRandom,
  flush,
  waitFor,
  type RecordingCursorStore,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';

interface Harness {
  readonly mailbox: FakeMailboxServer;
  readonly watcher: InboundMailboxWatcher;
  readonly clock: FakeClock;
  readonly cursors: RecordingCursorStore;
  readonly sink: RecordingSink;
  readonly observer: RecordingObserver;
  readonly settings: InboundWatcherSettings;
}

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness === undefined) continue;
    await harness.watcher.stop();
    harness.mailbox.close();
  }
});

async function build(input: {
  readonly server?: FakeMailboxOptions;
  readonly settings?: Partial<InboundWatcherSettings>;
  readonly seed?: MailboxCursor;
  readonly clientTimeoutMs?: number;
} = {}): Promise<Harness> {
  const mailbox = await makeFakeMailbox(input.server);
  const clock = new FakeClock();
  const { store: cursors } = await makeCursorStore(input.seed);
  const sink = new RecordingSink();
  const observer = new RecordingObserver();
  const settings = resolveWatcherSettings({
    account: ACCOUNT,
    mailbox: MAILBOX,
    ...input.settings,
  });
  const watcher = new InboundMailboxWatcher({
    settings,
    connections: imapMailboxConnectionPort({
      connect: () => openMailboxSocket(mailbox.port),
      username: 'watched@example.test',
      password: 'an-app-password',
      mailbox: MAILBOX,
      timeoutMs: input.clientTimeoutMs ?? 2_000,
    }),
    cursors,
    sink,
    clock,
    random: fixedRandom(0.5),
    observer,
  });
  const harness: Harness = { mailbox, watcher, clock, cursors, sink, observer, settings };
  open.push(harness);
  return harness;
}

function count(commands: readonly string[], pattern: RegExp): number {
  return commands.filter((line) => pattern.test(line)).length;
}

const IDLE_COMMAND = /^\S+ IDLE$/;
const SEARCH_COMMAND = /UID SEARCH/;

/** Wait until the watcher is sitting in an IDLE, `n` IDLEs in. */
async function idleReached(harness: Harness, n = 1): Promise<void> {
  await waitFor(
    () => count(harness.mailbox.commands, IDLE_COMMAND) >= n,
    `IDLE command number ${n}`,
  );
  // The re-issue timer is armed once the `+` continuation has been read, so
  // its presence is the signal that the loop is actually waiting.
  await harness.clock.waitForSleepers(1, 'the IDLE re-issue timer');
}

// ---------------------------------------------------------------------------

describe('inbound watcher — IDLE', () => {
  test('a drop mid-IDLE reconnects and delivers mail that arrived while down', async () => {
    const harness = await build({
      server: { initial: [message(101, 'already here')] },
    });
    harness.watcher.start();
    await idleReached(harness);
    expect(harness.mailbox.connectionCount).toBe(1);

    harness.mailbox.dropConnections();
    // Mail delivered while nobody is connected: no push can announce it, and
    // the only way it is ever seen is by asking what is above the cursor.
    harness.mailbox.deliverQuietly('arrived while the socket was down');

    await harness.clock.waitForDue(1_000, 'the reconnect backoff');
    await harness.clock.advance(1_000);

    await waitFor(() => harness.sink.uids.includes(102), 'UID 102 delivered');
    expect(harness.sink.subjects).toEqual(['arrived while the socket was down']);
    expect(harness.mailbox.connectionCount).toBeGreaterThanOrEqual(2);
    expect(harness.observer.insufficientAnnouncements).toEqual([]);
  });

  test('an untagged EXISTS arriving during the DONE handshake is processed', async () => {
    const harness = await build({
      server: { initial: [message(101, 'one'), message(102, 'two')] },
    });
    harness.watcher.start();
    await idleReached(harness);
    const searchesBefore = count(harness.mailbox.commands, SEARCH_COMMAND);

    // Deliver INSIDE the DONE handshake: after the server has read DONE and
    // before it writes the tagged completion. A loop that unsubscribes before
    // collecting the completion drops this announcement entirely.
    harness.mailbox.onNextDone((server) => { server.deliver('slipped in during DONE'); });
    // An EXPUNGE ends the IDLE without itself justifying a refetch, so the
    // only reason to search afterwards is the EXISTS from the handshake.
    harness.mailbox.expunge(101);

    await waitFor(() => harness.sink.uids.includes(103), 'UID 103 delivered');
    expect(harness.sink.subjects).toEqual(['slipped in during DONE']);
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBeGreaterThan(searchesBefore);
  });

  test('EXISTS is a wake-up: the delta comes from UID SEARCH, never from the number', async () => {
    const harness = await build({
      server: {
        initial: [message(101, 'a'), message(102, 'b'), message(103, 'c')],
      },
    });
    harness.watcher.start();
    await idleReached(harness);

    harness.mailbox.deliverQuietly('the real new message');
    // A total that is smaller than the mailbox and names no message. Arithmetic
    // on it would find nothing; treated as a wake-up it finds UID 104.
    harness.mailbox.push('* 2 EXISTS');

    await waitFor(() => harness.sink.uids.length > 0, 'a message delivered');
    expect(harness.sink.uids).toEqual([104]);
    expect(harness.sink.uids).not.toContain(2);
    expect(harness.mailbox.commands.some((line) => line.endsWith('UID SEARCH UID 104:*')))
      .toBe(true);
  });

  test('EXPUNGE triggers no refetch and leaves the cursor alone', async () => {
    const harness = await build({
      server: { initial: [message(101, 'a'), message(102, 'b')] },
    });
    harness.watcher.start();
    await idleReached(harness);
    const searchesBefore = count(harness.mailbox.commands, SEARCH_COMMAND);
    const cursorBefore = await harness.cursors.get(ACCOUNT, MAILBOX);

    harness.mailbox.expunge(101);
    // Wait for the IDLE to be torn down and re-issued, which proves the
    // EXPUNGE was seen and acted on rather than simply not arriving yet.
    await waitFor(
      () => count(harness.mailbox.commands, IDLE_COMMAND) >= 2,
      'the IDLE to be re-issued after the EXPUNGE',
    );
    await flush();

    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(searchesBefore);
    expect(harness.sink.delivered).toEqual([]);
    expect(await harness.cursors.get(ACCOUNT, MAILBOX))
      .toEqual(cursorBefore);
    expect(harness.observer.notes.some((note) => note.kind === 'expunge-observed'))
      .toBe(true);
  });

  test('IDLE is re-issued inside the RFC 2177 29-minute bound', async () => {
    const harness = await build({ server: { initial: [message(101, 'a')] } });
    const startedAt = harness.clock.now();
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.settings.idleReissueMs).toBe(27 * 60_000);
    expect(harness.clock.nextDueIn).toBe(27 * 60_000);

    await harness.clock.advance(27 * 60_000);
    await waitFor(
      () => count(harness.mailbox.commands, IDLE_COMMAND) >= 2,
      'the IDLE to be re-issued',
    );

    expect(harness.clock.now() - startedAt).toBeLessThan(IDLE_REISSUE_ADVISORY_BOUND_MS);
    expect(harness.mailbox.commands.filter((line) => line === 'DONE').length)
      .toBeGreaterThanOrEqual(1);
    // The re-issue doubles as a sweep for anything push never announced.
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBeGreaterThanOrEqual(2);
  });

  test('a re-issue whose round trip stalls is treated as a dead connection', async () => {
    const harness = await build({
      server: { initial: [message(101, 'a')], stallAfterDoneCount: 1 },
      settings: { idleReissueMs: 60_000, operationTimeoutMs: 150 },
      clientTimeoutMs: 400,
    });
    harness.watcher.start();
    await idleReached(harness);
    expect(harness.mailbox.connectionCount).toBe(1);

    // The server reads DONE and then says nothing. Without a liveness bound
    // this reads as a healthy IDLE for as long as the process lives.
    await harness.clock.advance(60_000);
    await waitFor(
      () => harness.clock.pending > 0 && harness.clock.nextDueIn <= 1_000,
      'the reconnect backoff to be armed after the stalled re-issue',
    );
    await harness.clock.advance(1_000);

    await waitFor(() => harness.mailbox.connectionCount >= 2, 'a rebuilt connection');
    expect(harness.watcher.status.verdict.state).not.toBe('insufficient');
  });
});

// ---------------------------------------------------------------------------

describe('inbound watcher — choosing push or poll', () => {
  test('a server that advertises no IDLE polls instead', async () => {
    const harness = await build({
      server: { idle: 'absent', initial: [message(101, 'a')] },
      settings: { pollIntervalMs: 30_000 },
    });
    harness.watcher.start();
    await waitFor(
      () => count(harness.mailbox.commands, SEARCH_COMMAND) >= 1,
      'the first poll',
    );
    await harness.clock.waitForSleepers(1, 'the poll interval');

    harness.mailbox.deliverQuietly('found by polling');
    await harness.clock.advance(30_000);
    await waitFor(() => harness.sink.uids.includes(102), 'the polled message');

    expect(count(harness.mailbox.commands, IDLE_COMMAND)).toBe(0);
    expect(harness.watcher.status.mode).toBe('polling');
    expect(harness.watcher.status.verdict.reason).toBe('polling-no-idle');
    expect(harness.watcher.status.verdict.state).toBe('degraded');
  });

  test('a server that says nothing is asked, and still reaches IDLE', async () => {
    const harness = await build({
      server: { idle: 'silent-then-idle', initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.mailbox.commands.some((line) => /CAPABILITY$/.test(line))).toBe(true);
    expect(count(harness.mailbox.commands, IDLE_COMMAND)).toBeGreaterThanOrEqual(1);
    expect(harness.watcher.status.mode).toBe('idle');
    expect(harness.watcher.status.verdict.reason).toBe('idle-push');
    expect(harness.watcher.status.verdict.state).toBe('healthy');
  });

  test('a server that will not answer CAPABILITY polls, and says that is why', async () => {
    const harness = await build({
      server: { idle: 'silent-unanswered', initial: [message(101, 'a')] },
      clientTimeoutMs: 250,
    });
    harness.watcher.start();
    await waitFor(
      () => count(harness.mailbox.commands, SEARCH_COMMAND) >= 1,
      'the first poll',
    );

    expect(count(harness.mailbox.commands, IDLE_COMMAND)).toBe(0);
    expect(harness.watcher.status.verdict.reason).toBe('polling-capability-unknown');
    expect(harness.watcher.status.verdict.state).toBe('degraded');
  });

  test('a server that advertises IDLE and then refuses it falls back to polling', async () => {
    const harness = await build({
      server: { refuseIdle: true, initial: [message(101, 'a')] },
      settings: { pollIntervalMs: 30_000 },
    });
    harness.watcher.start();
    await waitFor(
      () => harness.watcher.status.verdict.reason === 'polling-idle-refused',
      'the fallback to polling',
    );
    await harness.clock.waitForSleepers(1, 'the poll interval');

    harness.mailbox.deliverQuietly('found after IDLE was refused');
    await harness.clock.advance(30_000);
    await waitFor(() => harness.sink.uids.includes(102), 'the polled message');
    // Refusal is answered on the SAME connection: reconnecting would only
    // find the same refusal.
    expect(harness.mailbox.connectionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('inbound watcher — capability sufficiency', () => {
  test('a refused credential is retried once, then stops and is surfaced', async () => {
    const harness = await build({ server: { login: 'refused' } });
    harness.watcher.start();

    await harness.clock.waitForDue(1_000, 'the single auth retry backoff');
    expect(harness.mailbox.connectionCount).toBe(1);
    await harness.clock.advance(1_000);

    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');
    expect(harness.mailbox.connectionCount).toBe(2);
    const failure = harness.observer.terminals[0];
    expect(failure?.reason).toBe('credentials-rejected');
    expect(failure?.fix.length).toBeGreaterThan(0);
    expect(harness.watcher.status.verdict.state).toBe('insufficient');

    // Ten more minutes must not produce a third attempt: it is waiting out the
    // capability re-check, not retrying a rejected password on a loop.
    await harness.clock.advance(10 * 60_000);
    expect(harness.mailbox.connectionCount).toBe(2);
  });

  test('an unopenable mailbox is insufficient, does not read, and is told once', async () => {
    const harness = await build({
      server: { examine: 'refused' },
      settings: { capabilityRecheckMs: 60 * 60_000 },
    });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');

    expect(harness.watcher.status.verdict.reason).toBe('mailbox-unreadable');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(0);
    expect(harness.sink.delivered).toEqual([]);

    // Re-probe three times. The condition persists, so the watcher keeps
    // checking — and says nothing further, because nothing has changed.
    for (let round = 0; round < 3; round += 1) {
      const before = harness.mailbox.connectionCount;
      await harness.clock.advance(60 * 60_000);
      await waitFor(
        () => harness.mailbox.connectionCount > before,
        `re-probe number ${round + 1}`,
      );
    }
    expect(harness.mailbox.connectionCount).toBeGreaterThanOrEqual(4);
    expect(harness.observer.terminals.length).toBe(1);
    expect(harness.observer.insufficientAnnouncements.length).toBe(1);
  });

  test('recheckNow re-probes immediately instead of waiting out the timer', async () => {
    const harness = await build({ server: { examine: 'refused' } });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');
    const before = harness.mailbox.connectionCount;

    harness.watcher.recheckNow();
    await waitFor(
      () => harness.mailbox.connectionCount > before,
      'an immediate re-probe after a configuration change',
    );
  });

  test('a watcher waiting out a reconnect is degraded, never insufficient', async () => {
    const harness = await build({ server: { initial: [message(101, 'a')] } });
    harness.watcher.start();
    await idleReached(harness);

    harness.mailbox.dropConnections();
    await waitFor(
      () => harness.watcher.status.verdict.reason === 'reconnecting',
      'the reconnecting verdict',
    );

    expect(harness.watcher.status.verdict.state).toBe('degraded');
    expect(harness.observer.insufficientAnnouncements).toEqual([]);
    expect(harness.observer.terminals).toEqual([]);
  });

  test('a simultaneous-connection refusal is degraded in the provider’s words', async () => {
    // Gmail answers this at the LOGIN step, which the email layer used to call
    // a rejected credential — terminal — stopping the watcher permanently on a
    // condition that clears in seconds. It now reads the [LIMIT] response code
    // and reports the server's own unavailability instead.
    const harness = await build({ server: { login: 'connection-limit' } });
    harness.watcher.start();
    await waitFor(
      () => harness.watcher.status.verdict.reason === 'server-unavailable',
      'the server-unavailable verdict',
    );

    const verdict = harness.watcher.status.verdict;
    expect(verdict.state).toBe('degraded');
    expect(verdict.detail).toContain('Too many simultaneous connections');
    expect(harness.observer.terminals).toEqual([]);

    // It keeps trying — the limit clears on its own — but on a longer ceiling.
    const before = harness.mailbox.connectionCount;
    await harness.clock.advance(15 * 60_000);
    await waitFor(
      () => harness.mailbox.connectionCount > before,
      'a retry after the server-unavailable backoff',
    );
    expect(harness.observer.insufficientAnnouncements).toEqual([]);
  });

  test('a refused FETCH is insufficient; a refused SEARCH is only a reconnect', async () => {
    // Two refusals, two different claims. A server withholding message data
    // means arrival can be seen and never read, which no amount of
    // reconnecting fixes. A server refusing a search is routinely transient —
    // load, a folder being reindexed — and stopping the watcher over one would
    // turn a hiccup into silence.
    const cannotFetch = await build({
      server: { fetch: 'refused', initial: [message(101, 'a')] },
      seed: {
        account: ACCOUNT,
        mailbox: MAILBOX,
        uidValidity: 42,
        lastSeenUid: 100,
        updatedAt: new Date(0).toISOString(),
      },
    });
    cannotFetch.watcher.start();
    await waitFor(
      () => cannotFetch.observer.terminals.length >= 1,
      'a terminal report for the refused fetch',
    );
    expect(cannotFetch.watcher.status.verdict.reason).toBe('fetch-refused');
    expect(cannotFetch.watcher.status.verdict.state).toBe('insufficient');

    const cannotSearch = await build({
      server: { search: 'refused', initial: [message(101, 'a')] },
    });
    cannotSearch.watcher.start();
    await waitFor(
      () => cannotSearch.watcher.status.verdict.reason === 'reconnecting',
      'the reconnecting verdict for the refused search',
    );
    expect(cannotSearch.watcher.status.verdict.state).toBe('degraded');
    expect(cannotSearch.observer.terminals).toEqual([]);
  });

  test('an insufficient watcher releases the connection instead of holding it', async () => {
    // "The watcher does not run" has to include "and is not still occupying a
    // connection slot". Gmail allows fifteen simultaneous IMAP connections and
    // EmailService takes a fresh one per request, so a watcher parked on an
    // open socket for an hour while refusing to read from it makes the
    // server-unavailable verdict more likely on every OTHER mailbox — the same
    // limit pressure with none of the benefit.
    const harness = await build({
      server: { fetch: 'refused', initial: [message(101, 'a')] },
      seed: {
        account: ACCOUNT,
        mailbox: MAILBOX,
        uidValidity: 42,
        lastSeenUid: 100,
        updatedAt: new Date(0).toISOString(),
      },
    });
    harness.watcher.start();
    await waitFor(
      () => harness.observer.terminals.length >= 1,
      'a terminal report for the refused fetch',
    );
    await waitFor(
      () => harness.mailbox.liveConnections === 0,
      'the connection to be released while the watcher waits out the re-check',
    );
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    // Still waiting on the re-check, not spinning: one wait, an hour out.
    expect(harness.clock.nextDueIn).toBe(60 * 60_000);
  });

  test('a mailbox that reports no UIDVALIDITY is refused rather than guessed at', async () => {
    const harness = await build({
      server: { omitUidValidity: true, initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');

    expect(harness.watcher.status.verdict.reason).toBe('uidvalidity-missing');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('inbound watcher — the cursor', () => {
  test('the cursor advances only after a message is fully processed', async () => {
    const harness = await build({ server: { initial: [message(101, 'a')] } });
    harness.sink.refuseOnce.add(102);
    harness.watcher.start();
    await idleReached(harness);
    // The first drain found nothing: UID 102:* returns UID 101 on a mailbox
    // whose highest UID is 101, and that is below the cursor.
    expect(harness.sink.attempts).toEqual([]);
    expect(harness.cursors.advances).toEqual([]);

    harness.mailbox.deliver('processed on the second attempt');

    // First attempt: fetched, refused between fetch and completion.
    await waitFor(() => harness.sink.attempts.length >= 1, 'the first delivery attempt');
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid)
      .toBe(101);
    expect(harness.cursors.advances).toEqual([]);

    // The watcher pauses, rebuilds, and asks again from above the cursor.
    await harness.clock.waitForDue(1_000, 'the pause after a refused delivery');
    await harness.clock.advance(1_000);

    await waitFor(() => harness.sink.uids.includes(102), 'the redelivered message');
    expect(harness.sink.attempts).toEqual([102, 102]);
    expect(harness.sink.uids).toEqual([102]);
    expect(harness.cursors.advances).toEqual([102]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid)
      .toBe(102);
  });

  test('a delta larger than one fetch batch loses none of it', async () => {
    const harness = await build({
      server: { initial: [message(101, 'a')] },
      settings: { deltaBatchSize: 7 },
    });
    harness.watcher.start();
    await idleReached(harness);

    for (let index = 0; index < 25; index += 1) {
      harness.mailbox.deliverQuietly(`bulk ${index}`);
    }
    harness.mailbox.push('* 26 EXISTS');

    // Waits on the CURSOR, not on the sink. The cursor advances only after
    // deliver() resolves, so "25 messages delivered" is one step short of
    // "25 messages fully processed" — and asserting the cursor on the strength
    // of the sink count is a race that only loses under I/O pressure. It did:
    // this read 125 instead of 126 in a full-suite run while passing alone and
    // under eight concurrent runs of its own file.
    await waitFor(
      () => harness.cursors.advances.length >= 25,
      'all 25 messages processed and their cursor advances committed',
    );
    expect(harness.sink.uids).toEqual(
      Array.from({ length: 25 }, (_value, index) => 102 + index),
    );
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid)
      .toBe(126);
  });

  test('a resumed cursor picks up above its stored position and does not replay', async () => {
    const harness = await build({
      server: {
        initial: [message(101, 'old'), message(102, 'old'), message(103, 'unread')],
      },
      seed: {
        account: ACCOUNT,
        mailbox: MAILBOX,
        uidValidity: 42,
        lastSeenUid: 102,
        updatedAt: new Date(0).toISOString(),
      },
    });
    harness.watcher.start();
    await waitFor(() => harness.sink.uids.length >= 1, 'the unprocessed message');
    await flush();

    expect(harness.sink.uids).toEqual([103]);
    expect(harness.mailbox.commands.some((line) => line.endsWith('UID SEARCH UID 103:*')))
      .toBe(true);
  });

  test('a first run establishes the mark and does not backfill', async () => {
    const harness = await build({
      server: {
        initial: [message(101, 'old'), message(102, 'old'), message(103, 'old')],
      },
    });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    expect(harness.sink.delivered).toEqual([]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid)
      .toBe(103);
    expect(harness.observer.notes.some((note) => note.kind === 'cursor-established'))
      .toBe(true);
  });
});

function message(uid: number, subject: string): {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly deliveredTo: string;
} {
  return {
    uid,
    from: `sender${uid}@sender.test`,
    subject,
    deliveredTo: 'watched@example.test',
  };
}
