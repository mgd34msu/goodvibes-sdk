/**
 * The IDLE loop: RFC 2177 push, and the five things about it that are easy to
 * get wrong.
 *
 * One long-lived connection per mailbox sends `IDLE`, waits for the server's
 * `+` continuation, and then sits in silence until the server says something.
 * Everything interesting is in the details of ending that silence.
 *
 * **1. `DONE` is not a tagged command.** It is a bare line answering the
 * server's continuation request. The tagged completion that follows belongs to
 * the ORIGINAL `IDLE` tag, allocating a new tag for `DONE`, or expecting a
 * completion under one, leaves the real completion unmatched and the reader
 * waiting for a line that already went past.
 *
 * **2. Untagged responses arrive during the `DONE` handshake.** The window
 * between writing `DONE` and reading the tagged completion is a real interval
 * on a real network, and mail delivered into it produces an `EXISTS` that is
 * every bit as real as one delivered a second earlier. A loop that subscribes
 * for the wait and unsubscribes before the handshake drops those, silently,
 * and only under load, which is when it matters. So the subscription is opened
 * BEFORE `IDLE` goes out and closed AFTER the tagged completion comes back,
 * and everything collected in between counts.
 *
 * **3. `EXISTS` is a mailbox TOTAL, not a delta.** `* 12 EXISTS` says the
 * mailbox now holds twelve messages. It does not say message 12 is new, it
 * does not say one message arrived, and subtracting the previous total is
 * arithmetic on a number an expunge can move downwards. It is a WAKE-UP and
 * nothing else; the delta always comes from `UID SEARCH UID <cursor+1>:*`.
 * Nothing in this file ever turns an `EXISTS` number into a message identity.
 *
 * **4. `EXPUNGE` renumbers everything above it.** It cannot produce new mail,
 * so it needs no refetch, but it invalidates every sequence number in flight.
 * This loop never holds sequence-number work to invalidate, because the delta
 * is UID-keyed end to end; an `EXPUNGE` is therefore recorded and otherwise
 * ignored, which is the correct amount of work to do about it.
 *
 * **5. A dead TCP connection reads as a healthy IDLE forever.** No bytes are
 * expected during an IDLE, so "no bytes arrived" is indistinguishable from
 * "the socket died two hours ago", and that is the exact failure this whole
 * capability exists to eliminate. The re-issue timer therefore doubles as the
 * liveness probe: every `idleReissueMs` the loop ends the IDLE and starts a
 * new one, and if that round trip does not complete within the operation
 * timeout the connection is declared dead and rebuilt. The interval is set
 * well inside RFC 2177's 29-minute advisory, which exists because a server
 * "MAY consider a client inactive if it has an IDLE command running" and log
 * it off.
 *
 * Nothing here marks anything `\Seen`: the mailbox is EXAMINEd and every fetch
 * downstream is `BODY.PEEK`.
 */

import type {
  InboundMailObserver,
  InboundWatcherSettings,
  MailboxWire,
  WatcherClock,
} from './ports.js';

// ---------------------------------------------------------------------------
// Reading what the server said
// ---------------------------------------------------------------------------

const EXISTS_LINE = /^\* (\d+) EXISTS\b/;
const RECENT_LINE = /^\* (\d+) RECENT\b/;
const EXPUNGE_LINE = /^\* (\d+) EXPUNGE\b/;
const VANISHED_LINE = /^\* VANISHED\b/;
const BYE_LINE = /^\* BYE\b/;

/**
 * Whether an untagged line is worth ending the silence for.
 *
 * `* 0 RECENT` is not: a mailbox reporting no recent messages is answering a
 * question nobody asked, and waking on it would end every IDLE the moment it
 * began on servers that volunteer it.
 */
export function isIdleWakeLine(line: string): boolean {
  if (EXISTS_LINE.test(line)) return true;
  const recent = RECENT_LINE.exec(line);
  if (recent !== null) return Number(recent[1]) > 0;
  if (EXPUNGE_LINE.test(line)) return true;
  if (VANISHED_LINE.test(line)) return true;
  return BYE_LINE.test(line);
}

/** What a completed IDLE round observed. */
export interface IdleWakeSummary {
  /** Every untagged line seen between `IDLE` and its tagged completion. */
  readonly lines: readonly string[];
  /** An `EXISTS`, or a `RECENT` above zero, arrived. */
  readonly mailboxGrew: boolean;
  /** An `EXPUNGE` or `VANISHED` arrived. */
  readonly expunged: boolean;
  /** The server announced it is closing the connection. */
  readonly bye: boolean;
  /**
   * Whether the caller should ask what is above the cursor.
   *
   * True when the mailbox grew, and ALSO true on every re-issue. The re-issue
   * sweep costs one `UID SEARCH` every twenty-seven minutes and closes the one
   * hole push cannot close by itself: a notification that was never sent, or
   * was sent while nothing could receive it. `EXPUNGE` alone never sets it,
   * a deletion cannot produce mail.
   */
  readonly refetch: boolean;
  /** What ended the wait. */
  readonly endedBy: 'untagged' | 'reissue' | 'abort' | 'error';
}

function summarise(
  lines: readonly string[],
  endedBy: IdleWakeSummary['endedBy'],
): IdleWakeSummary {
  let mailboxGrew = false;
  let expunged = false;
  let bye = false;
  for (const line of lines) {
    if (EXISTS_LINE.test(line)) mailboxGrew = true;
    const recent = RECENT_LINE.exec(line);
    if (recent !== null && Number(recent[1]) > 0) mailboxGrew = true;
    if (EXPUNGE_LINE.test(line) || VANISHED_LINE.test(line)) expunged = true;
    if (BYE_LINE.test(line)) bye = true;
  }
  return {
    lines,
    mailboxGrew,
    expunged,
    bye,
    refetch: mailboxGrew || endedBy === 'reissue',
    endedBy,
  };
}

// ---------------------------------------------------------------------------
// One round
// ---------------------------------------------------------------------------

/** How an IDLE round ended, from the loop's point of view. */
export type IdleRoundOutcome =
  /** The connection is healthy and the loop should issue another IDLE. */
  | 'continue'
  /** Shutdown was requested; the IDLE was ended cleanly. */
  | 'stopped'
  /** The server refused `IDLE` itself. Fall back to polling; do not reconnect. */
  | 'idle-refused'
  /** The socket failed. Reconnect on a backoff. */
  | 'connection-lost'
  /** The liveness probe did not complete. The connection is dead. Rebuild it. */
  | 'reissue-stalled';

export interface IdleRoundResult {
  readonly outcome: IdleRoundOutcome;
  readonly wake: IdleWakeSummary;
  readonly error: unknown;
}

export interface IdleRoundDeps {
  readonly wire: MailboxWire;
  readonly clock: WatcherClock;
  readonly settings: InboundWatcherSettings;
  readonly signal: AbortSignal;
  /** 0 for the first IDLE of a connection; used to name a stalled re-issue. */
  readonly roundIndex: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

function isRefusal(error: unknown): boolean {
  return messageOf(error).startsWith('IMAP command failed:');
}

function isTimeout(error: unknown): boolean {
  return /timed out|read timeout/i.test(messageOf(error));
}

/**
 * Run one `IDLE` … `DONE` cycle.
 *
 * The subscription is opened first and released last, so the collected lines
 * span the entire cycle including the `DONE` handshake, see point 2 in the
 * file header. `DONE` is written even when the wait ended in shutdown, and its
 * tagged completion is awaited WITHOUT the caller's abort signal: a shutdown
 * that skipped the completion would leave a half-finished command on a
 * connection we are about to say `LOGOUT` on, and would drop whatever arrived
 * in the handshake window on the way out.
 */
export async function runIdleRound(deps: IdleRoundDeps): Promise<IdleRoundResult> {
  const collected: string[] = [];
  const unsubscribe = deps.wire.onUntagged((line) => { collected.push(line); });
  const bounded = {
    timeoutMs: deps.settings.operationTimeoutMs,
    signal: deps.signal,
  };
  const stalledOutcome: IdleRoundOutcome =
    deps.roundIndex > 0 ? 'reissue-stalled' : 'connection-lost';

  try {
    let tag: string;
    try {
      // `retainUntagged: false`: this command is outstanding for twenty-seven
      // minutes, and every untagged line arriving in that window would
      // otherwise be retained in its own buffer for a reader that never comes
      //, the IDLE completion is read for its status, never for its lines. The
      // subscription above still sees all of them, which is where they are
      // actually used.
      tag = await deps.wire.sendCommand('IDLE', { retainUntagged: false });
    } catch (error) {
      return { outcome: 'connection-lost', wake: summarise(collected, 'error'), error };
    }

    try {
      await deps.wire.awaitContinuation(tag, bounded);
    } catch (error) {
      if (deps.signal.aborted) {
        return { outcome: 'stopped', wake: summarise(collected, 'abort'), error: null };
      }
      // A server that answers IDLE with NO or BAD does not support it here,
      // whatever CAPABILITY said. That is a fallback to polling, not a broken
      // socket, and reconnecting would find the same refusal.
      if (isRefusal(error)) {
        return { outcome: 'idle-refused', wake: summarise(collected, 'error'), error };
      }
      return {
        outcome: isTimeout(error) ? stalledOutcome : 'connection-lost',
        wake: summarise(collected, 'error'),
        error,
      };
    }

    const ended = await waitForWake(deps);
    if (ended.kind === 'error') {
      // The wait can only end by a line, by an abort, or by the session
      // failing. Nothing else reached here, so the socket is gone and there is
      // nobody left to send DONE to.
      return { outcome: 'connection-lost', wake: summarise(collected, 'error'), error: ended.error };
    }

    try {
      await deps.wire.sendRawLine('DONE');
    } catch (error) {
      return { outcome: 'connection-lost', wake: summarise(collected, 'error'), error };
    }
    try {
      // Deliberately no abort signal, see the doc comment.
      await deps.wire.awaitTag(tag, { timeoutMs: deps.settings.operationTimeoutMs });
    } catch (error) {
      // A DONE the server never completes is the liveness probe failing. When
      // the wait ended on the re-issue timer that IS the probe, whichever
      // round it happened in: a connection that has stopped answering looks
      // exactly like a quiet one until something demands a round trip.
      return {
        outcome: ended.kind === 'reissue'
          ? 'reissue-stalled'
          : isTimeout(error) ? stalledOutcome : 'connection-lost',
        wake: summarise(collected, ended.kind),
        error,
      };
    }

    const wake = summarise(collected, ended.kind);
    if (wake.bye) {
      return { outcome: 'connection-lost', wake, error: new Error('The mail server closed the connection.') };
    }
    return {
      outcome: ended.kind === 'abort' ? 'stopped' : 'continue',
      wake,
      error: null,
    };
  } finally {
    unsubscribe();
  }
}

type WakeEnd =
  | { readonly kind: 'untagged' }
  | { readonly kind: 'reissue' }
  | { readonly kind: 'abort' }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * Wait for whichever comes first: something worth waking for, the re-issue
 * deadline, shutdown, or the connection failing.
 *
 * Both waits are cancelled by one inner controller as soon as either wins, so
 * neither is left attached to the session for the life of the process. The
 * untagged wait passes `timeoutMs: null`, the whole point is a wait that
 * lasts as long as the silence does, and is bounded by that controller
 * instead, which is what keeps it from being unbounded in both.
 */
async function waitForWake(deps: IdleRoundDeps): Promise<WakeEnd> {
  if (deps.signal.aborted) return { kind: 'abort' };

  const race = new AbortController();
  const relay = (): void => { race.abort(); };
  deps.signal.addEventListener('abort', relay, { once: true });

  let reissueDue = false;
  const timer = deps.clock.sleep(deps.settings.idleReissueMs, race.signal).then(() => {
    reissueDue = !race.signal.aborted;
    return { kind: 'timer' as const };
  });
  const untagged = deps.wire
    .waitForUntagged(isIdleWakeLine, { timeoutMs: null, signal: race.signal })
    .then(() => ({ kind: 'line' as const }))
    .catch((error: unknown) => ({ kind: 'failed' as const, error }));

  try {
    const winner = await Promise.race([untagged, timer]);
    race.abort();
    // Let the loser settle before returning, so no wait outlives this round.
    await timer;
    const settled = await untagged;

    if (winner.kind === 'line') return { kind: 'untagged' };
    if (winner.kind === 'timer' && reissueDue) return { kind: 'reissue' };
    if (deps.signal.aborted) return { kind: 'abort' };
    if (settled.kind === 'failed') return { kind: 'error', error: settled.error };
    return { kind: 'abort' };
  } finally {
    deps.signal.removeEventListener('abort', relay);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type IdleLoopOutcome =
  | 'stopped'
  | 'idle-refused'
  | 'connection-lost'
  | 'reissue-stalled'
  /** The caller's wake handler asked to stop, a read or a delivery failed. */
  | 'wake-halted';

export interface IdleLoopResult {
  readonly outcome: IdleLoopOutcome;
  /** Completed IDLE rounds. */
  readonly rounds: number;
  readonly error: unknown;
}

export interface IdleLoopDeps extends Omit<IdleRoundDeps, 'roundIndex'> {
  readonly observer?: InboundMailObserver | undefined;
  /**
   * Ask what is above the cursor. Returns `'continue'` to keep IDLEing and
   * `'halt'` when the caller must take the connection back, a refused fetch
   * or a message the sink would not accept.
   */
  readonly onWake: (wake: IdleWakeSummary) => Promise<'continue' | 'halt'>;
}

/**
 * Hold an IDLE connection, waking to fetch and re-issuing on the timer, until
 * shutdown or until something the caller has to act on.
 *
 * The wake handler runs BETWEEN rounds, never during one: `UID SEARCH` and
 * `UID FETCH` cannot be issued while an `IDLE` is in flight, and the round has
 * already collected its tagged completion by the time this calls out.
 */
export async function runIdleLoop(deps: IdleLoopDeps): Promise<IdleLoopResult> {
  let rounds = 0;
  for (;;) {
    if (deps.signal.aborted) return { outcome: 'stopped', rounds, error: null };
    const round = await runIdleRound({ ...deps, roundIndex: rounds });
    rounds += 1;

    if (round.wake.expunged) {
      note(deps, 'expunge-observed',
        'A message was expunged. The cursor is UID-keyed, so nothing is '
        + 'refetched and no sequence number is carried across it.');
    }
    if (round.wake.endedBy === 'reissue') {
      note(deps, 'idle-reissued',
        `IDLE re-issued after ${deps.settings.idleReissueMs} ms, inside RFC 2177's `
        + '29-minute advisory, and swept for anything push did not announce.');
    }

    // Only ask the server for the delta on a connection that is still usable.
    // On a lost connection the answer is above the cursor and the reconnect
    // fetches it, which is the whole reason the cursor exists.
    if ((round.outcome === 'continue') && round.wake.refetch) {
      const decision = await deps.onWake(round.wake);
      if (decision === 'halt') return { outcome: 'wake-halted', rounds, error: null };
    }

    if (round.outcome === 'continue') continue;
    if (round.outcome === 'stopped') return { outcome: 'stopped', rounds, error: null };
    if (round.outcome === 'connection-lost') {
      note(deps, 'connection-lost', messageOf(round.error));
    }
    return { outcome: round.outcome, rounds, error: round.error };
  }
}

function note(
  deps: IdleLoopDeps,
  kind: 'expunge-observed' | 'idle-reissued' | 'connection-lost',
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
