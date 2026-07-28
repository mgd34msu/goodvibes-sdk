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
 * end is not empty — it is the range with its endpoints swapped. So on a
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
 * and the next pass fetches it again — a duplicate for dedup to suppress
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
   * mailbox — the first says its contents are withheld, the second is
   * routinely transient — so the caller is told which one it was rather than
   * left to guess from the message text.
   */
  readonly phase: 'search' | 'fetch' | null;
}

/**
 * Ask the server for the UIDs above the cursor.
 *
 * Issued on the raw wire because `UID SEARCH UID n:*` is not on the client's
 * method surface, and bounded by the operation timeout because a search that
 * never answers is a dead connection wearing a healthy one's clothes.
 */
export async function searchAboveCursor(
  wire: MailboxWire,
  lastSeenUid: number,
  options: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<number[]> {
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
 * gap between the two — but ONLY when every response in that batch was read.
 * The cursor advances past a genuine expunge: the server has said it is not
 * there, and holding the cursor below a UID that no longer exists would make
 * every subsequent pass re-search from a point that can never clear.
 *
 * When the batch also contained a response this client could NOT read, the
 * same absence means nothing of the kind, and the two are no longer conflated:
 * the drain stops at that UID with the cursor below it, reports the reason
 * through the observer, and the batch is fetched again. See `unreadableFetch`.
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
  ): MailboxDeltaReport => ({
    outcome, found, delivered, vanished, cursor: current, error, phase,
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

    for (const uid of batch) {
      if (deps.signal.aborted) return finish('aborted', uids.length);
      const envelope = byUid.get(uid);
      if (envelope === undefined) {
        if (unreadable.length > 0) {
          // Not an expunge. The server answered this batch with responses we
          // could not read, and one of them may have been this UID's — see the
          // block comment above `unreadableFetch`.
          const error = unreadableFetch(deps, current, uid, unreadable);
          note(deps, 'fetch-unreadable', error.message);
          return finish('read-failed', uids.length, error, 'fetch');
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
 * The failure raised when a UID is missing from a batch that also contained
 * responses this client could not read.
 *
 * The two facts that used to be one
 * ────────────────────────────────
 * "The server sent no response for UID 307" and "the server sent a response for
 * UID 307 and we could not read it" arrive here identically: 307 is not in the
 * result. The first is an expunge and the cursor may move past it. The second
 * is a message still sitting in the mailbox that we know nothing about, and
 * moving the cursor past it means nobody is ever told it arrived.
 *
 * This function is reached only in the second case, because `unreadable` is
 * non-empty. It cannot narrow further than the batch — a response whose UID was
 * illegible cannot be attributed to a particular message — so the whole batch
 * from this UID onwards is left unresolved and asked for again. Over-retrying a
 * message that really was expunged costs one more fetch that returns nothing;
 * under-retrying costs the message.
 *
 * The wording is deliberately the owner's, not a stack trace: this reaches
 * `classifyReadFailure`, which sees a plain Error rather than an
 * `IMAP command failed:` refusal and classifies it as `reconnecting` — a
 * transient condition the watcher retries under its normal backoff, not a
 * capability verdict that would stop it.
 */
function unreadableFetch(
  deps: MailboxDeltaDeps,
  current: MailboxCursor,
  uid: number,
  unreadable: readonly ImapFetchProblem[],
): Error {
  const reasons = unreadable.map((problem) => problem.detail).join('; ');
  return new Error(
    `The mail server answered the fetch for UID ${uid} with ${unreadable.length} response(s) `
    + `this client could not read (${reasons}). An unreadable answer is not evidence that the `
    + `message is gone, so the cursor stays at ${current.lastSeenUid} and the message will be `
    + `fetched again.`,
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
 * it is made in one place — `classifyReadFailure` — rather than duplicated in
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
  /** How many complete drains ran. */
  readonly passes: number;
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
  for (;;) {
    if (deps.signal.aborted) {
      return { outcome: 'stopped', cursor, error: null, phase: null, passes };
    }
    const report = await drainMailboxDelta({ ...deps, cursor, via: 'poll' });
    cursor = report.cursor;
    passes += 1;
    if (report.outcome === 'read-failed') {
      return { outcome: 'read-failed', cursor, error: report.error, phase: report.phase, passes };
    }
    if (report.outcome === 'delivery-failed') {
      return { outcome: 'delivery-failed', cursor, error: report.error, phase: null, passes };
    }
    if (report.outcome === 'aborted' || deps.signal.aborted) {
      return { outcome: 'stopped', cursor, error: null, phase: null, passes };
    }
    await deps.clock.sleep(deps.settings.pollIntervalMs, deps.signal);
  }
}
