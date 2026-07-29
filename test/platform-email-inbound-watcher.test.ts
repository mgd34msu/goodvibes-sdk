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

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  InboundMailboxWatcher,
  imapMailboxConnectionPort,
  resolveWatcherSettings,
  verdictForBodyReadability,
  IDLE_REISSUE_ADVISORY_BOUND_MS,
  IMAP_BODY_PROBE_BYTES,
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
  cleanupInboundScratch,
  makeCursorStore,
  RecordingObserver,
  RecordingSink,
  fixedRandom,
  flush,
  nudgeUntil,
  waitFor,
  watcherConnectionPort,
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

afterAll(() => { cleanupInboundScratch(); });

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
    connections: watcherConnectionPort({
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

    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.uids.includes(103),
      'UID 103 delivered',
      // EXPUNGE, not EXISTS: the search this test asserts must come from the
      // handshake announcement, so the nudge may not supply one of its own.
      { line: '* 1 EXPUNGE' },
    );
    expect(harness.sink.subjects).toEqual(['slipped in during DONE']);
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBeGreaterThan(searchesBefore);
  });

  test('a server that puts the UID data item last delivers mail all the same', async () => {
    // RFC 3501 §6.4.8 makes `UID FETCH` add the UID item; it does not say
    // where, and both positions are in the wild. When it lands after the
    // header literal it is not on the `* n FETCH` line at all — it is on the
    // line that closes the response — and a client that searches only the
    // start line finds no UIDs, produces no envelopes, and hands the drain
    // loop what looks exactly like a mailbox whose messages were all expunged.
    const harness = await build({
      server: {
        uidPosition: 'trailing',
        initial: [message(101, 'already here')],
      },
    });
    harness.watcher.start();
    await idleReached(harness);

    harness.mailbox.deliver('arrived on a trailing-UID server');
    await nudgeUntil(harness.mailbox, () => harness.sink.uids.includes(102), 'UID 102 delivered');

    expect(harness.sink.subjects).toEqual(['arrived on a trailing-UID server']);
    expect(harness.sink.delivered[0]?.envelope.from).toBe('sender102@sender.test');
    expect(harness.sink.delivered[0]?.envelope.deliveredTo)
      .toEqual(['watched@example.test']);
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

    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.uids.length > 0,
      'a message delivered',
      // The same undersized total the test is about, re-sent verbatim.
      { line: '* 2 EXISTS' },
    );
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
    await nudgeUntil(
      harness.mailbox,
      () => count(harness.mailbox.commands, IDLE_COMMAND) >= 2,
      'the IDLE to be re-issued after the EXPUNGE',
      // EXPUNGE only. An EXISTS nudge would cause exactly the refetch this
      // test exists to prove does not happen.
      { line: '* 1 EXPUNGE' },
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
    //
    // The refused FETCH is now reached by the connect-time probe rather than by
    // the first drain, so it lands as `bodies-unfetchable` — the reason that
    // names what the account may READ — instead of the `fetch-refused` the
    // reactive path produces. Same insufficiency, named for what was actually
    // established. `fetch-refused` remains the verdict for a fetch that fails
    // during normal draining, which `handleDrainFailure` still classifies.
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
    expect(cannotFetch.watcher.status.verdict.reason).toBe('bodies-unfetchable');
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
//
// `docs/inbound-email.md` §3.4d, "Scope sufficiency applies to both": a
// non-empty mailbox gets one BODY.PEEK at connect, answering whether the
// server will hand over message content before any expectation could be
// opened — instead of finding out reactively, on the first real fetch, which
// for a signup workstream is the verification mail itself.

describe('inbound watcher — connect-time body probe', () => {
  test('a server that refuses UID-ADDRESSED fetches is caught at connect, before any search', async () => {
    // `fetch: 'refused'` refuses `UID FETCH`, and only `UID FETCH`. That is
    // the form the real drain uses, and it is why the probe's body fetch is
    // UID-addressed rather than by sequence number: probing purely by sequence
    // number would sail past this server and leave the refusal to be
    // discovered on the first message that mattered.
    const harness = await build({
      server: { fetch: 'refused', initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await waitFor(
      () => harness.observer.terminals.length >= 1,
      'a terminal report for the refused probe',
    );

    expect(harness.watcher.status.verdict.reason).toBe('bodies-unfetchable');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    // Reached at connect, before the cursor was ever resolved against a
    // search: no UID SEARCH was issued, and the sink was never asked to
    // handle anything. An expectation registered against this mailbox learns
    // immediately rather than after a signup window expires in silence.
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(0);
    expect(harness.sink.attempts).toEqual([]);
    // The server's own wording is carried through, not paraphrased away.
    expect(harness.observer.terminals[0]?.notice?.serverMessage).toContain('Server error');
  });

  test('a server that serves the body probe reports readable and runs normally', async () => {
    const harness = await build({
      server: { initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.watcher.status.bodyProbe?.outcome).toBe('readable');
    expect(harness.watcher.status.verdict.state).not.toBe('insufficient');
    expect(harness.observer.terminals).toEqual([]);
  });

  test('an empty mailbox is unproven, distinct from readable, and the watcher still runs', async () => {
    const harness = await build({ server: { initial: [] } });
    harness.watcher.start();
    await idleReached(harness);

    const probe = harness.watcher.status.bodyProbe;
    // Asserted on the discriminant directly, not via a truthiness check —
    // `unproven` and `readable` must never read as interchangeable
    // "it's fine" values.
    expect(probe?.outcome).toBe('unproven');
    expect(probe?.outcome).not.toBe('readable');
    // Not a capability FAILURE — the watcher runs and delivers — but not
    // healthy either: nothing has demonstrated this account can read a body,
    // and `degraded` is what says so without refusing to watch the empty
    // signup alias this capability exists to serve.
    expect(harness.watcher.status.verdict.state).toBe('degraded');
    expect(harness.watcher.status.verdict.reason).toBe('bodies-unproven');
    expect(harness.observer.terminals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * The IMAP half of the rule the Gmail source already keeps: a connection that
 * authenticates but cannot fetch bodies fails loudly at connect time, and never
 * delivers empty-bodied messages that read as a quiet mailbox.
 *
 * Gmail can compare scopes, because Google publishes what a grant covers. IMAP
 * has no scopes and no such statement, so the equivalent is evidence — one
 * message read, and what came back checked against what the server itself said
 * was there.
 *
 * THE LIMIT OF THIS COVERAGE, stated so nobody reads more into it than is here:
 * every case below is driven by `fake-imap-mailbox.ts`, including the withheld
 * body. No real provider that permits headers and withholds content has ever
 * been exercised against this code — such an account is not something the suite
 * can conjure, and fabricating one would be worse than the gap. What these
 * tests establish is that the CLIENT reaches the right verdict when a server
 * behaves that way on the wire; that a given real provider behaves that way is
 * a claim nothing here supports.
 */
describe('inbound watcher — can it read message content at all', () => {
  test('a refused body fetch is insufficient at connect time, with a remedy', async () => {
    const harness = await build({
      server: { bodyProbe: 'refused', initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');

    const verdict = harness.watcher.status.verdict;
    expect(verdict.reason).toBe('bodies-unfetchable');
    expect(verdict.state).toBe('insufficient');
    // Not `fetch-refused`: that one means the server said no to handing over
    // message DATA and points at IMAP access and folder restrictions. This one
    // is about what the account may READ, and the fix has to say so.
    expect(verdict.detail).toContain('Not permitted');

    const failure = harness.observer.terminals[0];
    expect(failure?.reason).toBe('bodies-unfetchable');
    expect(failure?.fix).toContain('access');
    expect(failure?.fix.length).toBeGreaterThan(0);

    // The watcher does not run: nothing is searched for and nothing is
    // delivered, rather than a listener sitting on a mailbox it cannot read.
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(0);
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.watcher.status.mode).toBe('inactive');
  });

  test('an empty body for a message the server said has content is the same verdict', async () => {
    // The quiet-mailbox impostor, and the reason a refusal-only check is not
    // enough: every command succeeds, and the body comes back empty for a
    // message whose own BODYSTRUCTURE declared 120 octets of text. From the
    // outside that is indistinguishable from a mailbox nobody wrote to — which
    // is exactly what a metadata-only grant looked like on the Gmail side.
    const harness = await build({
      server: { bodyProbe: 'withheld', initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');

    expect(harness.watcher.status.verdict.reason).toBe('bodies-unfetchable');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    expect(harness.watcher.status.verdict.detail).toContain('120');
    expect(harness.observer.terminals[0]?.fix).toContain('access');
    expect(count(harness.mailbox.commands, SEARCH_COMMAND)).toBe(0);
    expect(harness.sink.delivered).toEqual([]);
  });

  test('an empty mailbox is unproven and degraded — the watcher still runs', async () => {
    // A freshly created signup alias is empty by definition, so refusing here
    // would break the exact journey this capability exists to serve. Claiming
    // `healthy` would assert a capability nobody has demonstrated. It runs, and
    // says plainly that it has not proven it can read message content yet.
    const harness = await build({ server: { initial: [] } });
    const connection = await imapMailboxConnectionPort({
      connect: () => openMailboxSocket(harness.mailbox.port),
      username: 'watched@example.test',
      password: 'an-app-password',
      mailbox: MAILBOX,
      timeoutMs: 2_000,
    }).open();
    const reading = connection.bodyCapability;
    await connection.close();

    expect(reading.outcome).toBe('unproven');
    const verdict = verdictForBodyReadability(reading);
    expect(verdict?.reason).toBe('bodies-unproven');
    expect(verdict?.state).toBe('degraded');
    // The owner-facing text must not claim a capability was verified: it says
    // what it has NOT been able to prove, and never reports bytes it read.
    expect(verdict?.detail).toContain('not yet proven');
    expect(verdict?.detail).not.toMatch(/\bRead \d+ byte/);
    expect(verdict?.fix).toContain('first message that arrives');

    // And the watcher runs: it reaches IDLE and delivers mail that arrives.
    harness.watcher.start();
    await idleReached(harness);
    expect(harness.watcher.status.running).toBe(true);
    expect(harness.watcher.status.mode).toBe('idle');
    harness.mailbox.deliver('arrived after the empty probe');
    await nudgeUntil(harness.mailbox, () => harness.sink.delivered.length >= 1, 'the delivered message');
    expect(harness.observer.terminals).toEqual([]);
  });

  test('the WATCHER reports unproven body access, not merely the connection', async () => {
    // The reading existing on `MailboxConnection.bodyCapability` is not the
    // capability working: `serve()` has to hand it to
    // `verdictForOpenConnection`, or the tracker records `idle-push`/`healthy`
    // and the owner gets a green light for a watcher that has never once shown
    // it can read a message. That gap is what this asserts against — the check
    // is present, compiles, and passes every other test in this file with the
    // argument dropped, and only this assertion notices.
    const harness = await build({ server: { initial: [] } });
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.watcher.status.verdict.reason).toBe('bodies-unproven');
    expect(harness.watcher.status.verdict.state).toBe('degraded');
    expect(harness.watcher.status.verdict.detail).toContain('not yet proven');
    // Degraded, not stopped: it holds IDLE and still delivers. `insufficient`
    // here would refuse to watch the empty signup alias this exists to serve.
    expect(harness.watcher.status.running).toBe(true);
    expect(harness.observer.terminals).toEqual([]);
  });

  test('a message with a legitimately zero-octet body is not a failure', async () => {
    // Nothing came back and nothing was declared, so nothing was learned. That
    // is `unproven`, not a withheld body — treating it as a failure would stop
    // a working watcher over a message somebody sent with an empty body.
    const harness = await build({
      server: { bodyProbe: 'zero-octet-body', initial: [message(101, 'a')] },
    });
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.observer.terminals).toEqual([]);
    expect(harness.watcher.status.running).toBe(true);
    harness.mailbox.deliver('arrived after a zero-octet probe');
    await nudgeUntil(harness.mailbox, () => harness.sink.delivered.length >= 1, 'the delivered message');
  });

  test('a server that hands over a body passes the probe and reaches healthy', async () => {
    const harness = await build({ server: { initial: [message(101, 'a')] } });
    harness.watcher.start();
    await idleReached(harness);

    expect(harness.watcher.status.verdict.state).toBe('healthy');
    expect(harness.watcher.status.verdict.reason).toBe('idle-push');
    expect(harness.observer.terminals).toEqual([]);

    // TWO round trips for the whole probe, in the two forms that make it one
    // probe rather than the two it replaced.
    //
    // The BODYSTRUCTURE is sequence-addressed (it is what supplies the declared
    // octets); the body fetch is UID-addressed (it is what exercises the
    // drain's own addressing). Both counts are asserted, so a change that
    // quietly reintroduces a second probe — or drops one of the two forms —
    // fails here rather than costing an extra round trip on every connect in
    // silence.
    const structureProbes = harness.mailbox.commands
      .filter((line) => /^\S+ FETCH \d+ \(UID BODYSTRUCTURE\)/.test(line));
    const bodyProbes = harness.mailbox.commands
      .filter((line) => /^\S+ UID FETCH \d+ BODY\.PEEK\[\]/.test(line));
    expect(structureProbes.length).toBe(1);
    expect(bodyProbes.length).toBe(1);
    expect(bodyProbes[0]).toContain(`BODY.PEEK[]<0.${IMAP_BODY_PROBE_BYTES}>`);

    // Bounded and read-only. An unbounded fetch would pull whatever a stranger
    // attached, and a plain BODY[ would mark the owner's mail read.
    for (const line of [...structureProbes, ...bodyProbes]) {
      expect(line.includes(' BODY[')).toBe(false);
    }
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
    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.attempts.length >= 1,
      'the first delivery attempt',
      // The cursor is refused here, so a duplicate wake re-delivers and the
      // exact-equality assertions below would fail. A long interval keeps this
      // a recovery from a lost edge rather than a second stimulus.
      { intervalMs: 500 },
    );
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid)
      .toBe(101);
    expect(harness.cursors.advances).toEqual([]);

    // The watcher pauses, rebuilds, and asks again from above the cursor.
    await harness.clock.waitForDue(1_000, 'the pause after a refused delivery');
    await harness.clock.advance(1_000);

    await waitFor(() => harness.sink.uids.includes(102), 'the redelivered message');
    // Delivery to the sink is not the cursor advance: the advance happens after
    // it, and on a loaded runner the gap between the two is observable. Waiting
    // on the sink and then asserting on the cursor read a cursor that had not
    // moved yet. Wait for the advance being asserted.
    await waitFor(
      () => harness.cursors.advances.includes(102),
      'the cursor to advance past the redelivered message',
    );
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
    // The wake is driven until it takes; the cursor assertion below is the
    // real subject of the test.
    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.uids.length > 0,
      'the bulk delta to start arriving',
      { line: '* 26 EXISTS' },
    );

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

// ---------------------------------------------------------------------------
//
// `[UIDNEXT n]` on EXAMINE is a SHOULD in RFC 3501, not a MUST, and
// `parseMailboxStatus` types it `number | null` because servers omit it.
//
// The defect these gate: the mark was computed as `(status.uidNext ?? 1) - 1`,
// so an absent UIDNEXT established the cursor at UID 0. UID 0 is below every
// message that exists, so the first drain searched `UID 1:*`, matched the
// whole mailbox, and delivered every message in it to the owner's notification
// channel as new mail — while the note it had just emitted said the opposite
// in three clauses at once ("Listening from UID 0 onwards", "n message(s) …
// were not read", "starts listening now rather than backfilling").

describe('inbound watcher — a server that does not report UIDNEXT', () => {
  const OLD = [message(101, 'a year old'), message(102, 'also old'), message(103, 'old too')];

  test('the whole mailbox is not replayed as new mail', async () => {
    const harness = await build({ server: { omitUidNext: true, initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    // The assertion the defect failed: nothing already in the mailbox reaches
    // the sink, exactly as it would not if UIDNEXT had been reported.
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.sink.uids).toEqual([]);
  });

  test('the mark is derived from the server rather than assumed to be zero', async () => {
    const harness = await build({ server: { omitUidNext: true, initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    // The cursor is ESTABLISHED at 103 — the same mark `UIDNEXT - 1` would
    // have given — rather than established at 0 and walked up to 103 by
    // replaying the mailbox. Asserted on the argument `resolve` received,
    // because the stored `lastSeenUid` is 103 either way once a backfill
    // finishes and so cannot tell the two apart.
    expect(harness.cursors.resolves).toEqual([
      { currentHighestUid: 103, currentMessageCount: 3 },
    ]);
    // Nothing was ever advanced over, which is what "did not walk up to it"
    // means in the store's own terms.
    expect(harness.cursors.advances).toEqual([]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(103);
    // And the mark was genuinely asked for: a full-mailbox search was issued.
    expect(harness.mailbox.commands.some((line) => line.endsWith('UID SEARCH UID 1:*')))
      .toBe(true);
  });

  test('the cursor note describes what actually happened, including how it was reached', async () => {
    const harness = await build({ server: { omitUidNext: true, initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    const established = harness.observer.notes.find((note) => note.kind === 'cursor-established');
    expect(established).toBeDefined();
    const detail = established?.detail ?? '';
    // Every clause is now true of the run that produced it.
    expect(detail).toContain('Listening from UID 103 onwards');
    expect(detail).toContain('3 message(s) already in the mailbox were not read');
    expect(detail).toContain('starts listening now rather than backfilling');
    // And the note does not pretend the mark came from the server's own
    // UIDNEXT when it did not — a cursor derived by asking is a materially
    // different provenance and is disclosed as one.
    expect(detail).toContain('without reporting a UIDNEXT');
    expect(detail).toContain('UID SEARCH');
    // The clause the defect emitted must not be reachable any more.
    expect(detail).not.toContain('Listening from UID 0 onwards');
  });

  test('the skipped count comes from the search, so it is right even without EXISTS', async () => {
    // A server terse enough to omit UIDNEXT may be terse elsewhere too, and
    // `exists ?? 0` would then have made the note claim 0 messages were
    // skipped while skipping three. The count is taken from the same answer
    // the mark is.
    const harness = await build({ server: { omitUidNext: true, initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    const established = harness.observer.notes.find((note) => note.kind === 'cursor-established');
    expect(established?.detail).toContain('it answered 3 message(s)');
    expect(established?.detail).toContain('the highest being UID 103');
  });

  test('an empty mailbox establishes at 0 legitimately, and says so truthfully', async () => {
    // 0 is the CORRECT mark here rather than a fallback: there is nothing
    // below it to step over, and nothing is skipped.
    const harness = await build({ server: { omitUidNext: true, initial: [] } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(0);
    expect(harness.sink.delivered).toEqual([]);
    const established = harness.observer.notes.find((note) => note.kind === 'cursor-established');
    expect(established?.detail).toContain('Listening from UID 0 onwards');
    expect(established?.detail).toContain('0 message(s) already in the mailbox were not read');
    expect(harness.watcher.status.verdict.state).not.toBe('insufficient');
  });

  test('mail arriving after the derived mark is still delivered', async () => {
    // The mark has to be usable, not merely safe: a cursor placed correctly
    // and never advanced past would be the opposite failure.
    const harness = await build({ server: { omitUidNext: true, initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);

    harness.mailbox.deliver('the verification email');
    await nudgeUntil(
      harness.mailbox,
      () => harness.sink.uids.length >= 1,
      'the newly arrived message',
    );
    // Same ordering as above: the sink sees the message before the cursor
    // records it, so the cursor assertion waits on the cursor.
    await waitFor(
      () => harness.cursors.advances.includes(104),
      'the cursor to advance past the newly arrived message',
    );

    expect(harness.sink.uids).toEqual([104]);
    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(104);
  });

  test('a search that names nothing while the mailbox reports messages is refused, not zeroed', async () => {
    // The one case where the derivation cannot answer: the server says the
    // mailbox holds three messages and its search names none of them. The only
    // mark available from here is 0, which would replay all three — so the
    // watcher refuses instead, under a reason that names the real condition.
    const harness = await build({
      server: { omitUidNext: true, search: 'empty', initial: OLD },
    });
    harness.watcher.start();
    await waitFor(() => harness.observer.terminals.length >= 1, 'a terminal report');

    expect(harness.watcher.status.verdict.reason).toBe('mailbox-position-unknown');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    expect(harness.watcher.status.verdict.detail).toContain('3 message(s) present');
    expect(harness.watcher.status.verdict.fix.length).toBeGreaterThan(0);
    // And above all: nothing was replayed and no cursor was written at 0.
    expect(harness.sink.delivered).toEqual([]);
    expect(await harness.cursors.get(ACCOUNT, MAILBOX)).toBeNull();
  });

  test('a refused search while deriving is a reconnect, not a capability verdict', async () => {
    // §13.1: a refused SEARCH is routinely transient. Deriving the mark must
    // not turn one into a permanent refusal — that would let a hiccup on the
    // first connection permanently disable the mailbox.
    const harness = await build({
      server: { omitUidNext: true, search: 'refused', initial: OLD },
    });
    harness.watcher.start();
    await waitFor(
      () => harness.watcher.status.verdict.reason === 'reconnecting',
      'the reconnecting verdict for the refused derivation search',
    );

    expect(harness.watcher.status.verdict.state).toBe('degraded');
    expect(harness.observer.terminals).toEqual([]);
    expect(harness.sink.delivered).toEqual([]);
  });

  test('a reported UIDNEXT is still trusted, and costs no extra search', async () => {
    // The control. Nothing about the normal path changes: the mark is
    // UIDNEXT - 1, and no full-mailbox search is issued to re-derive it.
    const harness = await build({ server: { initial: OLD } });
    harness.watcher.start();
    await idleReached(harness);
    await flush();

    expect((await harness.cursors.get(ACCOUNT, MAILBOX))?.lastSeenUid).toBe(103);
    expect(harness.sink.delivered).toEqual([]);
    expect(harness.mailbox.commands.some((line) => line.endsWith('UID SEARCH UID 1:*')))
      .toBe(false);
    const established = harness.observer.notes.find((note) => note.kind === 'cursor-established');
    expect(established?.detail).not.toContain('without reporting a UIDNEXT');
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
