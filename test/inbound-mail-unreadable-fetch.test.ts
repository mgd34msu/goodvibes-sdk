/**
 * A mailbox whose FETCH answers cannot be read: what the watcher does about it,
 * and what it must never do about it.
 *
 * Every test here is a gate on a defect that was REPRODUCED, not imagined. The
 * fix for "an unreadable answer is not evidence the message is gone" was
 * correct and introduced three new ways to fail, and the two that matter most
 * are in this file:
 *
 *   1. The retry was unbounded AND the backoff was reset on every successful
 *      connection, so a mailbox that could never be read reconnected from
 *      attempt zero forever, measured at a flat 500 ms between logins, which
 *      is roughly two IMAP logins per second against a provider that permits
 *      fifteen concurrent connections. The daemon becomes the outage.
 *   2. The refusal to advance was decided per BATCH, so a UID the server had
 *      genuinely expunged was held back by an unreadable batch-mate, and
 *      because batch composition is stable across retries, the cursor could
 *      never clear that point.
 *
 * Nothing here opens a socket. The connection port is scripted in-process so a
 * test can say "this batch comes back unreadable" and count what the watcher
 * does next, and every wait runs on the injected clock.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import {
  InboundMailboxWatcher,
  drainMailboxDelta,
  resolveWatcherSettings,
  type InboundWatcherSettings,
  type MailboxConnection,
  type MailboxConnectionPort,
  type MailboxReader,
  type MailboxWire,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type {
  ImapEnvelope,
  ImapEnvelopeBatch,
  ImapFetchProblem,
} from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  FakeClock,
  cleanupInboundScratch,
  makeCursorStore,
  RecordingObserver,
  RecordingSink,
  fixedRandom,
  waitFor,
  type RecordingCursorStore,
} from './_helpers/inbound-watcher-harness.ts';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const UID_VALIDITY = 900;

// ---------------------------------------------------------------------------
// A mailbox that answers, scripted
// ---------------------------------------------------------------------------

function envelope(uid: number): ImapEnvelope {
  return {
    uid,
    from: `sender${String(uid)}@sender.test`,
    subject: `Message ${String(uid)}`,
    date: 'Mon, 27 Jul 2026 09:00:00 +0000',
    messageId: `<uid-${String(uid)}@example.test>`,
    mailbox: MAILBOX,
    deliveredTo: ['watched@example.test'],
    deliveryEvidence: [{ address: 'watched@example.test', rawValue: 'watched@example.test', source: 'delivered-to' }],
    unverifiedToHeaderClaim: 'watched@example.test',
    authenticationResults: [],
  };
}

/** A response the server sent that names its UID and still cannot be read. */
function namedProblem(uid: number): ImapFetchProblem {
  return {
    seq: uid - 100,
    uid,
    detail: `the FETCH response for UID ${String(uid)} carried no header section`,
  };
}

/** A response that names nothing, the genuinely unattributable case. */
function anonymousProblem(): ImapFetchProblem {
  return {
    seq: 2,
    uid: null,
    detail: 'the FETCH response for sequence number 2 carried no UID data item, so it '
      + 'cannot be attributed to a message',
  };
}

interface ScriptedMailboxOptions {
  /** UIDs the SEARCH reports above the cursor. */
  readonly present: readonly number[];
  /** UIDs the FETCH answers for. Anything in `present` and not here is absent. */
  readonly readable: readonly number[];
  /** The unreadable responses each FETCH comes back with. */
  readonly unreadable: readonly ImapFetchProblem[];
}

/**
 * A connection port with no socket under it.
 *
 * `opens` is the count this file's most important assertion is made against:
 * the defect is not visible in any single connection, only in how often the
 * watcher makes a new one.
 */
class ScriptedMailbox implements MailboxConnectionPort {
  opens = 0;
  fetches = 0;
  private readonly options: ScriptedMailboxOptions;

  constructor(options: ScriptedMailboxOptions) {
    this.options = options;
  }

  async open(): Promise<MailboxConnection> {
    this.opens += 1;
    const options = this.options;
    const highest = options.present.length === 0
      ? 100
      : Math.max(...options.present);

    const reader: MailboxReader = {
      capabilities: async () => ['IMAP4REV1'],
      fetchEnvelopes: async (uids) => (await reader.fetchEnvelopeBatch(uids)).envelopes as ImapEnvelope[],
      fetchEnvelopeBatch: async (uids): Promise<ImapEnvelopeBatch> => {
        this.fetches += 1;
        return {
          envelopes: uids
            .filter((uid) => options.readable.includes(uid))
            .map((uid) => envelope(uid)),
          unreadable: options.unreadable,
        };
      },
    };

    const wire = {
      onUntagged: () => () => undefined,
      sendCommand: async () => 'A001',
      sendRawLine: async () => undefined,
      awaitContinuation: async () => undefined,
      awaitTag: async () => [`* SEARCH ${options.present.join(' ')}`, 'A001 OK SEARCH completed'],
      waitForUntagged: async () => '',
    } as unknown as MailboxWire;

    return {
      report: {
        advertisedCapabilities: ['IMAP4REV1'],
        idle: { known: true, supported: false },
        mailbox: {
          name: MAILBOX,
          exists: options.present.length,
          uidValidity: UID_VALIDITY,
          uidNext: highest + 1,
          readOnly: true,
        },
      },
      reader,
      wire,
      // This stub connection never ran a probe, and `unproven` is what says so
      //, not `readable`, which would claim a capability nothing demonstrated.
      bodyCapability: {
        outcome: 'unproven',
        detail: 'A stub connection: no body was fetched, so nothing is proven.',
      },
      close: async () => undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly watcher: InboundMailboxWatcher;
  readonly clock: FakeClock;
  readonly cursors: RecordingCursorStore;
  readonly sink: RecordingSink;
  readonly observer: RecordingObserver;
  readonly connections: ScriptedMailbox;
  readonly settings: InboundWatcherSettings;
}

const open: Harness[] = [];

afterAll(() => { cleanupInboundScratch(); });

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness === undefined) continue;
    await harness.watcher.stop();
  }
});

async function build(options: ScriptedMailboxOptions & {
  readonly seedUid?: number;
}): Promise<Harness> {
  const clock = new FakeClock();
  const { store: cursors } = await makeCursorStore({
    account: ACCOUNT,
    mailbox: MAILBOX,
    uidValidity: UID_VALIDITY,
    lastSeenUid: options.seedUid ?? 101,
  });
  const sink = new RecordingSink();
  const observer = new RecordingObserver();
  const connections = new ScriptedMailbox(options);
  const settings = resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' });
  const watcher = new InboundMailboxWatcher({
    settings,
    connections,
    cursors,
    sink,
    clock,
    // Full jitter with a draw of 1 takes the top of each window, so the
    // escalation is exact rather than statistical: 1s, 2s, 4s, 8s...
    random: fixedRandom(1),
    observer,
  });
  const harness: Harness = {
    watcher, clock, cursors, sink, observer, connections, settings,
  };
  open.push(harness);
  return harness;
}

/** Every sleep the watcher asked for, in order, by draining the fake clock. */
async function collectSleeps(harness: Harness, count: number): Promise<number[]> {
  const intervals: number[] = [];
  for (let index = 0; index < count; index += 1) {
    await harness.clock.waitForDue(
      Number.POSITIVE_INFINITY,
      `scheduled wait #${String(index + 1)}`,
    );
    const due = harness.clock.nextDueIn;
    intervals.push(due);
    await harness.clock.advance(due);
  }
  return intervals;
}

/**
 * Run the watcher forward until `predicate` holds, advancing only over waits
 * that actually exist.
 *
 * `nextDueIn` is `Infinity` when nothing is scheduled, and advancing by that
 * moves the fake clock to a time `new Date()` cannot represent, so the guard
 * is not decoration; without it the watcher's next status timestamp throws
 * `Invalid Date` and the test fails somewhere unrelated to what it is testing.
 */
async function pumpUntil(
  harness: Harness,
  predicate: () => boolean,
  what: string,
  maxSteps = 200,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (predicate()) return;
    const due = harness.clock.nextDueIn;
    await (Number.isFinite(due) ? harness.clock.advance(due) : harness.clock.advance(0));
    if (predicate()) return;
  }
  throw new Error(`Gave up after ${String(maxSteps)} steps waiting for: ${what}`);
}

// ---------------------------------------------------------------------------
// 1. The hot loop
// ---------------------------------------------------------------------------

describe('a mailbox whose answers cannot be read does not become a login flood', () => {
  test('the reconnect interval ESCALATES when the connection opens and the drain fails', async () => {
    // The measured defect: `connectBackoff.reset()` sat on the successful
    // connection, so every reconnect after a failed drain restarted at attempt
    // zero and the intervals came back flat, [500, 500, 500, ...] forever.
    // A successful TCP connect is not evidence of progress when the work the
    // connection exists for keeps failing.
    const harness = await build({
      present: [102, 103],
      readable: [103],
      unreadable: [namedProblem(102)],
    });
    harness.watcher.start();

    const intervals = await collectSleeps(harness, 5);

    // Strictly increasing, and nothing like a flat 500 ms.
    expect(intervals).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]).toBeGreaterThan(intervals[index - 1] ?? 0);
    }
  });

  test('the connection count stays bounded while the backoff climbs', async () => {
    // The same fact stated as the provider sees it. Five waits spanning 31
    // seconds cost at most a handful of logins; the defect cost roughly two a
    // second, against a fifteen-connection cap.
    const harness = await build({
      present: [102, 103],
      readable: [103],
      unreadable: [namedProblem(102)],
    });
    harness.watcher.start();

    const intervals = await collectSleeps(harness, 5);
    const spanMs = intervals.reduce((total, ms) => total + ms, 0);

    expect(spanMs).toBe(31_000);
    expect(harness.connections.opens).toBeLessThanOrEqual(6);
    // What the defect produced over the same 31 seconds, for scale.
    expect(harness.connections.opens).toBeLessThan(62);
  });

  test('an unreadable mailbox escalates to a named terminal reason with an owner notice', async () => {
    // The asymmetry that was the defect: the THROW path escalated through
    // MAX_CONSECUTIVE_LOCAL_FAILURES to a terminal reason and an owner notice,
    // and the UNREADABLE path had no counterpart at all, no ceiling, no
    // terminal, no notice. A mailbox that can never be read must say so rather
    // than retry forever.
    const harness = await build({
      present: [102, 103],
      readable: [103],
      unreadable: [namedProblem(102)],
    });
    harness.watcher.start();

    await pumpUntil(
      harness,
      () => harness.observer.terminals.length > 0,
      'the watcher to report a terminal failure',
    );

    const terminal = harness.observer.terminals[0];
    expect(terminal?.reason).toBe('fetch-unreadable');
    expect(terminal?.account).toBe(ACCOUNT);
    expect(terminal?.mailbox).toBe(MAILBOX);
    // The owner gets a step, not a stack trace.
    expect(terminal?.fix).toContain('cannot read the answers');
    expect(terminal?.detail).toContain('times in a row');
    expect(harness.watcher.status.verdict.state).toBe('insufficient');
    expect(harness.watcher.status.verdict.reason).toBe('fetch-unreadable');
  });

  test('a mailbox that reads normally keeps its backoff reset and never escalates', async () => {
    // The other half of the ceiling: it counts CONSECUTIVE failures. A mailbox
    // that drains cleanly must never accumulate toward a permanent verdict.
    const harness = await build({
      present: [102, 103],
      readable: [102, 103],
      unreadable: [],
    });
    harness.watcher.start();

    await waitFor(() => harness.sink.uids.length === 2, 'both messages delivered');

    expect(harness.sink.uids).toEqual([102, 103]);
    expect(harness.observer.terminals).toHaveLength(0);
    expect(harness.watcher.status.reconnectAttempts).toBe(0);
    expect(harness.watcher.status.verdict.state).not.toBe('insufficient');
  });
});

// ---------------------------------------------------------------------------
// 2. The genuine expunge held hostage by its batch-mate
// ---------------------------------------------------------------------------

describe('a genuine expunge is not blocked by an unreadable batch-mate', () => {
  /** One drain, driven directly, the level the defect was reproduced at. */
  async function drainOnce(options: ScriptedMailboxOptions & { readonly seedUid: number }) {
    const clock = new FakeClock();
    const { store: cursors } = await makeCursorStore({
      account: ACCOUNT,
      mailbox: MAILBOX,
      uidValidity: UID_VALIDITY,
      lastSeenUid: options.seedUid,
    });
    const sink = new RecordingSink();
    const observer = new RecordingObserver();
    const connection = await new ScriptedMailbox(options).open();
    const cursor = await cursors.get(ACCOUNT, MAILBOX);
    if (cursor === null) throw new Error('the seeded cursor did not persist');

    const report = await drainMailboxDelta({
      settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' }),
      reader: connection.reader,
      wire: connection.wire,
      cursors,
      sink,
      clock,
      observer,
      cursor,
      via: 'poll',
      signal: new AbortController().signal,
    });
    return { report, sink, observer };
  }

  test('a UID the server named as unreadable blocks only itself, not the batch', async () => {
    // The reproduction: SEARCH returns [101, 102], 101 is genuinely expunged
    // and 102 came back unreadable. The batch-wide test refused BOTH and left
    // the cursor at 100, and since batch composition is stable across
    // retries, it could never clear.
    const { report } = await drainOnce({
      seedUid: 100,
      present: [101, 102],
      readable: [],
      unreadable: [namedProblem(102)],
    });

    expect(report.outcome).toBe('read-failed');
    // 101 advanced: the server said nothing about it and nothing claimed it.
    expect(report.cursor.lastSeenUid).toBe(101);
    expect(report.vanished).toBe(1);
  });

  test('the cursor clears the expunge across repeated passes rather than pinning', async () => {
    // The property that actually matters. One pass advancing is only useful if
    // the next pass starts above the point it reached.
    const first = await drainOnce({
      seedUid: 100,
      present: [101, 102],
      readable: [],
      unreadable: [namedProblem(102)],
    });
    expect(first.report.cursor.lastSeenUid).toBe(101);

    const second = await drainOnce({
      seedUid: first.report.cursor.lastSeenUid,
      present: [102],
      readable: [],
      unreadable: [namedProblem(102)],
    });
    // Still held at 101, 102 is the ambiguous one and must not be stepped
    // over, but it did not go backwards, and 101 is behind us for good.
    expect(second.report.cursor.lastSeenUid).toBe(101);
  });

  test('an unreadable response that names NO uid holds every missing uid in the batch', async () => {
    // The limit of the rule, asserted so it is a decision rather than a gap.
    // A response with no legible UID belongs to some message in this batch and
    // says nothing about which, so no missing UID in it is provably gone.
    const { report } = await drainOnce({
      seedUid: 100,
      present: [101, 102],
      readable: [],
      unreadable: [anonymousProblem()],
    });

    expect(report.outcome).toBe('read-failed');
    expect(report.cursor.lastSeenUid).toBe(100);
    expect(report.vanished).toBe(0);
  });

  test('with nothing unreadable, every absent uid is an ordinary expunge', async () => {
    const { report } = await drainOnce({
      seedUid: 100,
      present: [101, 102],
      readable: [],
      unreadable: [],
    });

    expect(report.outcome).toBe('complete');
    expect(report.cursor.lastSeenUid).toBe(102);
    expect(report.vanished).toBe(2);
  });

  test('the drain reports the unreadable answer through the observer', async () => {
    const { observer } = await drainOnce({
      seedUid: 100,
      present: [101, 102],
      readable: [],
      unreadable: [namedProblem(102)],
    });

    const note = observer.notes.find((entry) => entry.kind === 'fetch-unreadable');
    expect(note).toBeDefined();
    expect(note?.detail).toContain('UID 102');
    expect(note?.detail).toContain('not evidence that the message is gone');
  });
});
