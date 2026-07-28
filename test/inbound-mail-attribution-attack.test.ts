/**
 * The per-UID attribution rule, attacked rather than demonstrated.
 *
 * `drainMailboxDelta` decides, for every UID the search returned that the fetch
 * did not answer for, whether that absence is a genuine expunge (advance past
 * it) or an unreadable answer (hold below it). Two opposite harms sit either
 * side of that decision, and a rule can fail into both:
 *
 *   **Stepping over.** The cursor advances past a message that is still in the
 *   mailbox. Nobody is ever told it arrived. This is the one that loses mail
 *   and it is unrecoverable — the cursor is a high-water mark, so there is no
 *   later pass that goes back for it.
 *
 *   **Pinning.** The cursor is held below a UID the server has already said is
 *   gone. Batch composition is stable across retries, so the mailbox never
 *   makes progress again. This is what the batch-wide rule did, and it is the
 *   defect the per-UID rule replaced.
 *
 * The earlier tests assert specific scenarios. This file asserts the rule
 * itself, over generated batches, against an independently written oracle — so
 * a disagreement is found rather than argued about. The oracle is deliberately
 * a SECOND implementation of the rule rather than a call into the first: an
 * oracle that shares the implementation proves only that the code equals
 * itself.
 */

import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  drainMailboxDelta,
  resolveWatcherSettings,
  type MailboxReader,
  type MailboxWire,
} from '../packages/sdk/src/platform/email/inbound/index.ts';
import type {
  ImapEnvelope,
  ImapEnvelopeBatch,
  ImapFetchProblem,
} from '../packages/sdk/src/platform/email/imap-client.ts';
import {
  RecordingObserver,
  RecordingSink,
  FakeClock,
  cleanupInboundScratch,
  makeCursorStore,
} from './_helpers/inbound-watcher-harness.ts';
import { afterAll } from 'bun:test';

const ACCOUNT = 'primary';
const MAILBOX = 'INBOX';
const UID_VALIDITY = 900;

afterAll(() => { cleanupInboundScratch(); });

function envelope(uid: number): ImapEnvelope {
  return {
    uid,
    from: `s${String(uid)}@sender.test`,
    subject: `Message ${String(uid)}`,
    date: 'Mon, 27 Jul 2026 09:00:00 +0000',
    messageId: `<uid-${String(uid)}@example.test>`,
    mailbox: MAILBOX,
    deliveredTo: ['watched@example.test'],
    deliveryEvidence: [{ address: 'watched@example.test', source: 'delivered-to' }],
    unverifiedToHeaderClaim: 'watched@example.test',
    authenticationResults: [],
  };
}

interface Scenario {
  /** Where the cursor starts. */
  readonly seed: number;
  /** What the SEARCH returns above the cursor, ascending. */
  readonly present: readonly number[];
  /** Which of those the FETCH answers for. */
  readonly readable: readonly number[];
  /** UIDs named by an unreadable response. */
  readonly namedUnreadable: readonly number[];
  /** How many unreadable responses named no UID at all. */
  readonly anonymousUnreadable: number;
}

/**
 * The rule, written again from its statement rather than from its code.
 *
 * A missing UID is unattributable — and so not provably expunged — when an
 * unreadable response named it, or when any unreadable response named no UID
 * at all. Everything else missing is a genuine expunge. Processing is in
 * ascending UID order and the cursor is a high-water mark, so the drain stops
 * at the first unattributable UID and the cursor is the last one before it.
 */
function oracleCursor(scenario: Scenario): number {
  const named = new Set(scenario.namedUnreadable);
  const anyAnonymous = scenario.anonymousUnreadable > 0;
  const readable = new Set(scenario.readable);
  let cursor = scenario.seed;
  for (const uid of [...scenario.present].sort((a, b) => a - b)) {
    if (readable.has(uid)) { cursor = uid; continue; }
    if (anyAnonymous || named.has(uid)) break;
    cursor = uid;
  }
  return cursor;
}

async function runDrain(scenario: Scenario) {
  const unreadable: ImapFetchProblem[] = [
    ...scenario.namedUnreadable.map((uid) => ({
      seq: uid,
      uid,
      detail: `the FETCH response for UID ${String(uid)} carried no header section`,
    })),
    ...Array.from({ length: scenario.anonymousUnreadable }, (_unused, index) => ({
      seq: index + 1,
      uid: null,
      detail: 'the FETCH response carried no UID data item',
    })),
  ];

  const reader: MailboxReader = {
    capabilities: async () => ['IMAP4REV1'],
    fetchEnvelopes: async (uids) => (await reader.fetchEnvelopeBatch(uids)).envelopes as ImapEnvelope[],
    fetchEnvelopeBatch: async (uids): Promise<ImapEnvelopeBatch> => ({
      envelopes: uids.filter((uid) => scenario.readable.includes(uid)).map(envelope),
      unreadable,
    }),
  };
  const wire = {
    onUntagged: () => () => undefined,
    sendCommand: async () => 'A001',
    sendRawLine: async () => undefined,
    awaitContinuation: async () => undefined,
    awaitTag: async () => [`* SEARCH ${scenario.present.join(' ')}`, 'A001 OK'],
    waitForUntagged: async () => '',
  } as unknown as MailboxWire;

  const { store: cursors } = await makeCursorStore({
    account: ACCOUNT, mailbox: MAILBOX, uidValidity: UID_VALIDITY, lastSeenUid: scenario.seed,
  });
  const cursor = await cursors.get(ACCOUNT, MAILBOX);
  if (cursor === null) throw new Error('seeded cursor did not persist');

  const sink = new RecordingSink();
  const report = await drainMailboxDelta({
    settings: resolveWatcherSettings({ account: ACCOUNT, mailbox: MAILBOX, mode: 'poll' }),
    reader,
    wire,
    cursors,
    sink,
    clock: new FakeClock(),
    observer: new RecordingObserver(),
    cursor,
    via: 'poll',
    signal: new AbortController().signal,
  });
  return { report, sink };
}

/** UIDs strictly above a seed, ascending, no duplicates. */
const scenario: fc.Arbitrary<Scenario> = fc
  .record({
    seed: fc.integer({ min: 100, max: 110 }),
    offsets: fc.uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 6 }),
    readableMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    unreadableMask: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    anonymousUnreadable: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ seed, offsets, readableMask, unreadableMask, anonymousUnreadable }) => {
    const present = [...offsets].sort((a, b) => a - b).map((offset) => seed + offset);
    const readable = present.filter((_uid, index) => readableMask[index] === true);
    // A UID the fetch answered for cannot also be one it failed to read.
    const namedUnreadable = present.filter(
      (uid, index) => unreadableMask[index] === true && !readable.includes(uid),
    );
    return { seed, present, readable, namedUnreadable, anonymousUnreadable };
  });

describe('the attribution rule holds under generated batches', () => {
  test('the cursor always lands exactly where the rule says it should', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const { report } = await runDrain(input);
        expect(report.cursor.lastSeenUid).toBe(oracleCursor(input));
      }),
      { numRuns: 250 },
    );
  });

  test('THE CURSOR NEVER STEPS OVER A UID THE SERVER NAMED AS UNREADABLE', async () => {
    // The unrecoverable harm. If this ever fails, mail is silently lost.
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const { report } = await runDrain(input);
        for (const uid of input.namedUnreadable) {
          expect(report.cursor.lastSeenUid).toBeLessThan(uid);
        }
      }),
      { numRuns: 250 },
    );
  });

  test('an unattributable response holds every missing uid at or after the first', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        if (input.anonymousUnreadable === 0) return;
        const { report } = await runDrain(input);
        const firstMissing = [...input.present]
          .sort((a, b) => a - b)
          .find((uid) => !input.readable.includes(uid));
        if (firstMissing === undefined) return;
        expect(report.cursor.lastSeenUid).toBeLessThan(firstMissing);
      }),
      { numRuns: 250 },
    );
  });

  test('with nothing unreadable the drain always completes and clears every uid', async () => {
    // The anti-pinning half. A rule that never advances is "safe" and useless.
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const clean = { ...input, namedUnreadable: [], anonymousUnreadable: 0 };
        const { report } = await runDrain(clean);
        expect(report.outcome).toBe('complete');
        expect(report.cursor.lastSeenUid).toBe(Math.max(...clean.present));
      }),
      { numRuns: 200 },
    );
  });

  test('the cursor never moves backwards, whatever the batch looks like', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const { report } = await runDrain(input);
        expect(report.cursor.lastSeenUid).toBeGreaterThanOrEqual(input.seed);
      }),
      { numRuns: 250 },
    );
  });

  test('every delivered message is one the fetch actually answered for', async () => {
    // The other way to lose: delivering an envelope the server never sent.
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const { sink } = await runDrain(input);
        for (const uid of sink.uids) expect(input.readable).toContain(uid);
      }),
      { numRuns: 250 },
    );
  });
});

describe('the pinning failure the per-UID rule replaced cannot recur', () => {
  test('a genuine expunge below an unreadable uid always clears', async () => {
    // The exact reproduction, generalised: any number of genuinely-gone UIDs
    // below the first unreadable one must all be stepped past in one pass.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 105 }),
        fc.integer({ min: 1, max: 4 }),
        async (seed, goneCount) => {
          const gone = Array.from({ length: goneCount }, (_u, index) => seed + index + 1);
          const blocked = seed + goneCount + 1;
          const { report } = await runDrain({
            seed,
            present: [...gone, blocked],
            readable: [],
            namedUnreadable: [blocked],
            anonymousUnreadable: 0,
          });
          expect(report.outcome).toBe('read-failed');
          // Everything provably gone cleared; the ambiguous one did not.
          expect(report.cursor.lastSeenUid).toBe(gone[gone.length - 1]);
          expect(report.vanished).toBe(goneCount);
        },
      ),
      { numRuns: 120 },
    );
  });
});
