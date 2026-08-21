/**
 * Finding what arrived: the delta fetch, and the adaptive poll that drives it.
 *
 * The delta fetch is the load-bearing half of this file and is shared with the
 * IDLE path, which is why it lives beside the poll loop rather than inside it.
 * IDLE and polling differ only in WHEN they ask; what they ask is identical,
 * and identical because it has to be:
 *
 * > **The delta always comes from `UID SEARCH UID <cursor+1>:*`.**
 *
 * Not from arithmetic on `EXISTS`, which is a mailbox TOTAL and says neither
 * which message is new nor how many arrived. Not from a sequence number, which
 * renumbers on every expunge. Not from `SEARCH UNSEEN`, which cannot work at
 * all here because `EXAMINE` + `BODY.PEEK` means nothing is ever marked
 * `\Seen`, so the same messages would come back forever.
 *
 * The `*` in that range needs care
 * ────────────────────────────────
 * `UID SEARCH UID 11:*` does NOT mean "UIDs from 11 upwards". RFC 3501 defines
 * `*` as the highest UID in the mailbox, and a range whose start exceeds its
 * end is not empty, it is the range with its endpoints swapped. So on a
 * mailbox whose highest UID is 10, `11:*` is the range 10:11 and matches
 * message 10, which the cursor says is already processed. Every server does
 * this and it is correct behaviour; a watcher that trusted the result would
 * redeliver its newest message on every single poll. Results are therefore
 * filtered to strictly above the cursor, here, once.
 *
 * The cursor moves behind the work, never ahead of it
 * ───────────────────────────────────────────────────
 * `advance()` is called once per message and only after that message's
 * `deliver()` has resolved. A crash, a failed notice or a killed process
 * between fetch and completion therefore leaves the cursor below the message,
 * and the next pass fetches it again, a duplicate for dedup to suppress
 * rather than a message nobody ever hears about. This is the same rule
 * `TelegramIngressSupervisor` already follows for its offset, and it is the
 * reason a reconnect loses nothing: recovery is not "resume the stream", it is
 * "ask what is above the cursor".
 */

import type { ImapEnvelopeBatch, ImapFetchProblem } from '../imap-client.js';
import { parseSearchNumbers } from '../imap-headers.js';
import type {
  InboundMailObserver,
  InboundMailSink,
  InboundWatcherSettings,
  MailboxCursorPort,
  MailboxReader,
  MailboxWire,
  WatcherClock,
} from './ports.js';
import { isImapUid, MAX_IMAP_UID } from './source-cursor.js';
import type { MailboxCursor } from './types.js';

/** Everything one drain of the mailbox needs. */
export interface MailboxDeltaDeps {
  readonly settings: InboundWatcherSettings;
  readonly reader: MailboxReader;
  readonly wire: MailboxWire;
  readonly cursors: MailboxCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  readonly observer?: InboundMailObserver | undefined;
  /** Where the cursor stands going in. */
  readonly cursor: MailboxCursor;
  /** Recorded on each message so a consumer can tell push from poll. */
  readonly via: 'idle' | 'poll';
  readonly signal: AbortSignal;
}

/** Why a drain stopped, and where it left the cursor. */
export type MailboxDeltaOutcome =
  /** Every message above the cursor was delivered. */
  | 'complete'
  /** Shutdown was requested part-way through. The rest is above the cursor. */
  | 'aborted'
  /** The sink refused a message. The cursor is below it; it will come again. */
  | 'delivery-failed'
  /** The server or socket failed. Classified by the caller. */
  | 'read-failed';

export interface MailboxDeltaReport {
  readonly outcome: MailboxDeltaOutcome;
  /** How many UIDs the search returned above the cursor. */
  readonly found: number;
  /** How many were handed to the sink and accepted. */
  readonly delivered: number;
  /** UIDs the search returned and the FETCH did not: expunged in between. */
  readonly vanished: number;
  /** Where the cursor stands coming out. */
  readonly cursor: MailboxCursor;
  /** The failure, for `delivery-failed` and `read-failed`. */
  readonly error: unknown;
  /**
   * Which command failed, for `read-failed`.
   *
   * A refused FETCH and a refused SEARCH are different claims about the
   * mailbox, the first says its contents are withheld, the second is
   * routinely transient, so the caller is told which one it was rather than
   * left to guess from the message text.
   */
  readonly phase: 'search' | 'fetch' | null;
  /**
   * True when `read-failed` means "the server answered and this client could
   * not read the answer", rather than a refusal or a dead socket.
   *
   * The caller needs this as its own fact rather than as a string match on
   * `error.message`. An unreadable answer is retried, the message is still in
   * the mailbox and the cursor has not moved past it, but it is retried
   * against a condition that may never clear, so it needs a ceiling of its own
   * the way an unexpected throw does. Counting it requires being able to
   * recognise it, and recognising it by re-reading the sentence
   * `unreadableFetch` wrote would be a second classifier that silently stops
   * agreeing the day the sentence is reworded.
   */
  readonly unreadableFetch: boolean;
}

/**
 * Ask the server for the UIDs above the cursor.
 *
 * Issued on the raw wire because `UID SEARCH UID n:*` is not on the client's
 * method surface, and bounded by the operation timeout because a search that
 * never answers is a dead connection wearing a healthy one's clothes.
 *
 * REFUSES A CURSOR OUTSIDE THE 32-BIT UID SPACE rather than searching from it.
 * `source-cursor.ts` and `MailboxCursorStore` between them make such a cursor
 * unstorable and unwritable, and `parseSearchNumbers` makes it unreadable off
 * the wire, so this should never fire, it is here because of what the failure
 * LOOKED like when it could. `UID SEARCH UID 9007199254740992:*` is a range a
 * server answers perfectly happily, and every UID it returns then fails the
 * `uid > lastSeenUid` filter below: the drain reports `complete, found: 0`,
 * the watcher reports healthy, and no mail is ever delivered again. Silence
 * that reports itself as success is the one failure mode this whole capability
 * exists to eliminate, so an impossible position is raised as a read failure,
 * `drainMailboxDelta` turns it into `read-failed` on the `search` phase, which
 * the caller backs off and discloses, rather than being searched from as if
 * it were a place.
 */
export async function searchAboveCursor(
  wire: MailboxWire,
  lastSeenUid: number,
  options: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<number[]> {
  if (!isImapUid(lastSeenUid)) {
    throw new Error(
      `Refusing to search above UID ${String(lastSeenUid)}: not an integer in `
      + `0..${String(MAX_IMAP_UID)} (RFC 3501 §2.3.1.1). No UID a server can issue is above it, `
      + 'so every message in the mailbox would be filtered out and the drain would report '
      + 'success having delivered nothing.',
    );
  }
  const from = Math.max(1, lastSeenUid + 1);
  const tag = await wire.sendCommand(`UID SEARCH UID ${from}:*`);
  const lines = await wire.awaitTag(tag, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  // Filtered, not trusted: see the file header on why `11:*` can return 10.
  const above = parseSearchNumbers(lines).filter((uid) => uid > lastSeenUid);
  above.sort((a, b) => a - b);
  return above;
}

function chunk(uids: readonly number[], size: number): number[][] {
  const batches: number[][] = [];
  for (let index = 0; index < uids.length; index += size) {
    batches.push(uids.slice(index, index + size));
  }
  return batches;
}

/**
 * Fetch and process everything above the cursor, advancing behind each one.
 *
 * Batched at `deltaBatchSize`, and the batching is load-bearing rather than
 * defensive. `fetchEnvelopes` REFUSES a batch above `IMAP_MAX_FETCH_UIDS`
 * instead of trimming it, so a mailbox that took two thousand messages while
 * the daemon was down would fail its whole delta on one over-long `UID FETCH`
 * line and make no progress at all on any pass. Splitting it is what makes
 * that recovery possible; the ceiling is enforced when the setting is
 * resolved.
 *
 * Ascending UID order throughout, because the cursor is a high-water mark:
 * processing 12 before 11 and then failing on 11 would leave the cursor either
 * at 12 (losing 11) or at 10 (redelivering 12). In order, the cursor is always
 * exactly "everything below this is done".
 *
 * A UID the search returned and the FETCH did not is a message expunged in the
 * gap between the two, but ONLY when no unreadable response could have been
 * that UID's own. The cursor advances past a genuine expunge: the server has
 * said it is not there, and holding the cursor below a UID that no longer
 * exists would make every subsequent pass re-search from a point that can
 * never clear.
 *
 * Whether an unreadable response could have been this UID's is decided per
 * UID, not per batch, see `attributeUnreadable`. A batch-wide test was the
 * first version of this rule and it froze the cursor permanently: with UID 101
 * genuinely expunged and UID 102 unreadable in the same batch, 101 was refused
 * as well, batch composition is stable across retries, and so the cursor could
 * never clear 100. The block that exists to avoid stepping over live mail must
 * not also refuse to step over mail the server has said is gone.
 */
export async function drainMailboxDelta(
  deps: MailboxDeltaDeps,
): Promise<MailboxDeltaReport> {
  const { settings, cursor } = deps;
  let current = cursor;
  let delivered = 0;
  let vanished = 0;

  const finish = (
    outcome: MailboxDeltaOutcome,
    found: number,
    error: unknown = null,
    phase: 'search' | 'fetch' | null = null,
    unreadableFetch = false,
  ): MailboxDeltaReport => ({
    outcome, found, delivered, vanished, cursor: current, error, phase, unreadableFetch,
  });

  let uids: number[];
  try {
    uids = await searchAboveCursor(deps.wire, cursor.lastSeenUid, {
      timeoutMs: settings.operationTimeoutMs,
      signal: deps.signal,
    });
  } catch (error) {
    return finish(deps.signal.aborted ? 'aborted' : 'read-failed', 0, error, 'search');
  }
  if (uids.length === 0) return finish('complete', 0);

  for (const batch of chunk(uids, settings.deltaBatchSize)) {
    if (deps.signal.aborted) return finish('aborted', uids.length);
    let fetched: ImapEnvelopeBatch;
    try {
      fetched = await deps.reader.fetchEnvelopeBatch(batch);
    } catch (error) {
      return finish(
        deps.signal.aborted ? 'aborted' : 'read-failed', uids.length, error, 'fetch');
    }
    const byUid = new Map(fetched.envelopes.map((envelope) => [envelope.uid, envelope]));
    const unreadable = fetched.unreadable;
    const attribution = attributeUnreadable(unreadable);

    for (const uid of batch) {
      if (deps.signal.aborted) return finish('aborted', uids.length);
      const envelope = byUid.get(uid);
      if (envelope === undefined) {
        if (attribution.couldBe(uid)) {
          // Not an expunge, or not provably one. An unreadable response could
          // have been this UID's own, see the block comment above
          // `unreadableFetch`.
          const error = unreadableFetch(deps, current, uid, unreadable, attribution.named.has(uid));
          note(deps, 'fetch-unreadable', error.message);
          return finish('read-failed', uids.length, error, 'fetch', true);
        }
        vanished += 1;
        current = await advanceTo(deps, current, uid);
        continue;
      }
      try {
        // The base fields are a straight carry off the envelope: the pipeline
        // downstream reads `InboundMessageCommon` and never narrows, so what a
        // source can say has to be said here rather than left for each
        // consumer to dig out of `envelope`. `date` becomes `claimedDate`
        // because it is sender-written and is not an ordering key.
        await deps.sink.deliver({
          source: 'imap',
          account: settings.account,
          mailbox: settings.mailbox,
          from: envelope.from,
          subject: envelope.subject,
          claimedDate: envelope.date,
          messageId: envelope.messageId,
          deliveredTo: envelope.deliveredTo,
          unverifiedToHeaderClaim: envelope.unverifiedToHeaderClaim,
          uidValidity: current.uidValidity,
          uid,
          envelope,
          via: deps.via,
        });
      } catch (error) {
        note(deps, 'delivery-failed',
          `UID ${uid} was not processed, so the cursor stays at `
          + `${current.lastSeenUid} and the message will be fetched again.`);
        return finish('delivery-failed', uids.length, error);
      }
      delivered += 1;
      // Only now. Everything about "no message is lost" is in this ordering.
      current = await advanceTo(deps, current, uid);
    }
  }

  note(deps, 'delta-drained',
    `${delivered} message(s) processed above UID ${cursor.lastSeenUid}`
    + `${vanished > 0 ? `, ${vanished} expunged before they could be fetched` : ''}.`);
  return finish('complete', uids.length);
}

/**
 * Which missing UIDs an unreadable response could belong to.
 *
 * THE RULE, stated once so it is arguable rather than buried: a UID absent
 * from the fetch result is unattributable, and therefore not provably
 * expunged, when either
 *
 *   1. an unreadable response NAMED that UID (`problem.uid === uid`); the
 *      server answered for it and the answer could not be read, or
 *   2. any unreadable response named no UID at all (`problem.uid === null`);
 *      such a response belongs to some message in this batch and there is
 *      nothing in it that says which.
 *
 * Anything else is a genuine expunge and the cursor advances past it. That is
 * the whole of the difference from the batch-wide test this replaces: a
 * response that names UID 102 says nothing whatsoever about UID 101, and
 * treating it as though it did is what pinned the cursor below a message the
 * server had already said was gone.
 *
 * WHAT THIS CANNOT DECIDE, plainly: case 2. When even one response arrived
 * with no legible UID, every missing UID in the batch is ambiguous, the drain
 * stops at the first of them, and no missing UID in that batch advances. A
 * counting argument does bound how many of them can really be unreadable, at
 * most one per unattributable response, but it does not say WHICH, and the
 * cursor is a high-water mark that can only move past a specific UID. A
 * sequence-number argument could narrow it further (responses come back in
 * mailbox order, and mailbox order is UID order), but it would rest on an
 * ordering RFC 3501 does not require a server to use for a `UID FETCH` set,
 * and being wrong about it means stepping over live mail. So this stays with
 * what the server actually said.
 *
 * Over-retrying a message that really was expunged costs one more fetch that
 * returns nothing; under-retrying costs the message. The ceiling on how long
 * that retrying may go on is the watcher's, see `MAX_CONSECUTIVE_UNREADABLE_DRAINS`.
 */
function attributeUnreadable(unreadable: readonly ImapFetchProblem[]): {
  readonly named: ReadonlySet<number>;
  readonly couldBe: (uid: number) => boolean;
} {
  const named = new Set<number>();
  let anyUnattributable = false;
  for (const problem of unreadable) {
    if (problem.uid === null) anyUnattributable = true;
    else named.add(problem.uid);
  }
  return {
    named,
    couldBe: (uid: number): boolean => anyUnattributable || named.has(uid),
  };
}

/**
 * The failure raised when a UID is missing from a batch and an unreadable
 * response could have been its own.
 *
 * The two facts that used to be one
 * ────────────────────────────────
 * "The server sent no response for UID 307" and "the server sent a response for
 * UID 307 and we could not read it" arrive here identically: 307 is not in the
 * result. The first is an expunge and the cursor may move past it. The second
 * is a message still sitting in the mailbox that we know nothing about, and
 * moving the cursor past it means nobody is ever told it arrived.
 *
 * This function is reached only in the second case. `attributed` says which
 * way it was reached, and the sentence says so, because "the server answered
 * for UID 307 and we could not read it" and "one of the answers was
 * unreadable and none of them said which message it was about" are different
 * things to tell an owner who is trying to work out what his mail server is
 * doing.
 *
 * The wording is deliberately the owner's, not a stack trace: this reaches
 * `classifyReadFailure`, which sees a plain Error rather than an
 * `IMAP command failed:` refusal and classifies it as `reconnecting`, a
 * transient condition the watcher retries under its normal backoff. It is the
 * watcher's own consecutive-unreadable count, not this classification, that
 * eventually calls it a capability verdict.
 */
function unreadableFetch(
  deps: MailboxDeltaDeps,
  current: MailboxCursor,
  uid: number,
  unreadable: readonly ImapFetchProblem[],
  attributed: boolean,
): Error {
  const reasons = unreadable.map((problem) => problem.detail).join('; ');
  const claim = attributed
    ? `The mail server answered the fetch for UID ${uid} with a response this client could not read`
    : `The mail server answered this fetch with ${unreadable.length} response(s) this client `
      + `could not read, and none of them named a UID, so any of them may have been UID ${uid}'s`;
  return new Error(
    `${claim} (${reasons}). An unreadable answer is not evidence that the message is gone, so `
    + `the cursor stays at ${current.lastSeenUid} and the message will be fetched again.`,
  );
}

/**
 * Move the cursor and take the store's answer for where it now is.
 *
 * The returned cursor is the STORE'S, not a locally reconstructed one. This
 * used to build `{ ...current, lastSeenUid: uid }` by hand, which quietly
 * disagreed with the store: `advance` clamps with
 * `Math.max(existing.lastSeenUid, input.lastSeenUid)` so a cursor never moves
 * backwards, and the local copy assigned unconditionally. Two computations of
 * one rule, neither aware of the other. Now there is one.
 */
async function advanceTo(
  deps: MailboxDeltaDeps,
  current: MailboxCursor,
  uid: number,
): Promise<MailboxCursor> {
  return deps.cursors.advance({
    account: current.account,
    mailbox: current.mailbox,
    uidValidity: current.uidValidity,
    lastSeenUid: uid,
  });
}

function note(
  deps: MailboxDeltaDeps,
  kind: 'delta-drained' | 'delivery-failed' | 'fetch-unreadable',
  detail: string,
): void {
  try {
    deps.observer?.note?.({
      account: deps.settings.account,
      mailbox: deps.settings.mailbox,
      kind,
      detail,
      at: new Date(deps.clock.now()).toISOString(),
    });
  } catch {
    // An observer that throws must not stop the mail being read.
  }
}

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------

/**
 * Why the poll loop returned.
 *
 * `read-failed` is deliberately not split into "the socket died" and "the
 * server refused" here. Telling those apart decides whether the watcher
 * reconnects or reports `insufficient`, which is a capability judgement, and
 * it is made in one place, `classifyReadFailure`, rather than duplicated in
 * each loop.
 */
export type PollLoopOutcome =
  /** Shutdown requested. */
  | 'stopped'
  /** The search or fetch failed; the caller classifies the error. */
  | 'read-failed'
  /** The sink refused a message; the caller retries after a pause. */
  | 'delivery-failed';

export interface PollLoopResult {
  readonly outcome: PollLoopOutcome;
  readonly cursor: MailboxCursor;
  readonly error: unknown;
  /** Which command failed, for `read-failed`. */
  readonly phase: 'search' | 'fetch' | null;
  /** True when `read-failed` was an unreadable answer. See `MailboxDeltaReport`. */
  readonly unreadableFetch: boolean;
  /** How many drains ran, complete or not. */
  readonly passes: number;
  /**
   * How many of those drains completed.
   *
   * The caller resets its consecutive-failure counters on a completed drain,
   * and a poll loop that ran for six hours and then hit one bad fetch has
   * completed thousands. Without this the caller only ever sees the drain that
   * ended the loop, so hours of demonstrated progress would count for nothing
   * and a ceiling meant for CONSECUTIVE failures would accumulate across
   * unrelated days.
   */
  readonly completedDrains: number;
}

/**
 * Poll the mailbox until shutdown or until something the caller must act on.
 *
 * Runs when the server does not advertise IDLE, when IDLE is refused, and when
 * the owner asked for polling. It is not a lesser path: it finds exactly the
 * same messages by exactly the same search, just on a timer instead of on a
 * push, and a verification mail found within two minutes is found in time.
 *
 * The first drain happens IMMEDIATELY, before the first sleep. Whatever
 * arrived while the connection was down is already above the cursor, and
 * waiting out a poll interval before looking would add the interval to every
 * reconnect for no reason.
 */
export async function runPollLoop(deps: MailboxDeltaDeps): Promise<PollLoopResult> {
  let cursor = deps.cursor;
  let passes = 0;
  let completedDrains = 0;
  const stopped = (): PollLoopResult => ({
    outcome: 'stopped',
    cursor,
    error: null,
    phase: null,
    unreadableFetch: false,
    passes,
    completedDrains,
  });
  for (;;) {
    if (deps.signal.aborted) return stopped();
    const report = await drainMailboxDelta({ ...deps, cursor, via: 'poll' });
    cursor = report.cursor;
    passes += 1;
    if (report.outcome === 'complete') completedDrains += 1;
    if (report.outcome === 'read-failed') {
      return {
        outcome: 'read-failed',
        cursor,
        error: report.error,
        phase: report.phase,
        unreadableFetch: report.unreadableFetch,
        passes,
        completedDrains,
      };
    }
    if (report.outcome === 'delivery-failed') {
      return {
        outcome: 'delivery-failed',
        cursor,
        error: report.error,
        phase: null,
        unreadableFetch: false,
        passes,
        completedDrains,
      };
    }
    if (report.outcome === 'aborted' || deps.signal.aborted) return stopped();
    await deps.clock.sleep(deps.settings.pollIntervalMs, deps.signal);
  }
}
