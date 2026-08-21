/**
 * source.ts, the seam that makes inbound mail source-agnostic
 * (docs/inbound-email.md §3.4d).
 *
 * The watcher was IMAP-only, so someone who had already adopted Google
 * credentials was still asked to find an IMAP host, a username and an app
 * password for a mailbox the daemon can already read. That is friction we
 * invented, in the middle of the exact journey this capability exists to
 * serve: sign up, receive verification mail, complete verification.
 *
 * So the consuming side takes a MAIL SOURCE rather than an IMAP connection.
 * `InboundMailboxMessage`, `InboundMailSink`, `MailboxCursorPort`,
 * `InboundMailObserver` and `InboundCapabilityVerdict` were already
 * source-agnostic; only `MailboxConnectionPort`, `MailboxReader` and
 * `MailboxWire` are IMAP-shaped. Expectation matching, taint labelling,
 * dedup, notice rendering, cursor persistence and owner disclosure are
 * therefore written once and serve both sources.
 *
 * Why `latency` is on the interface at all
 * ────────────────────────────────────────
 * Because the two sources do not cost the same thing, and the difference is
 * the kind that gets quietly rounded off in a status line. IMAP IDLE is true
 * push and delivers in under a second. Gmail's `users.history.list` is
 * POLLING, `users.watch` + Pub/Sub needs a public HTTPS endpoint and a GCP
 * topic, which a daemon on someone's own machine behind NAT does not have,
 * so its worst case is the whole poll interval and nothing on that path can
 * be faster. Making the latency a value the source must state means the owner
 * is told a number rather than the word "real-time", and a surface that wants
 * to render "new mail appears within about 5 seconds" can, without guessing.
 *
 * Nothing here can start work. A source is handed a sink, a cursor and an
 * observer; there is no session broker, no agent manager and no reply queue
 * in any signature below, which is §2.1's structural removal of the spawn
 * capability restated at this seam.
 */

import type { InboundCapabilityVerdict } from './ports.js';

/**
 * How quickly a source can notice mail, stated rather than implied.
 *
 *   - `push`, the provider tells us. Sub-second; the delay is a round trip.
 *   - `poll`, we ask on a timer. `worstCaseMs` is the floor: a message that
 *     lands one millisecond after a poll waits the whole interval, and there
 *     is no configuration that makes it shorter than the interval in force.
 */
export type SourceLatency =
  | { readonly kind: 'push' }
  | { readonly kind: 'poll'; readonly worstCaseMs: number };

/**
 * One way of finding out that mail arrived.
 *
 * `start` and `run` are separate because capability sufficiency is a
 * PRECONDITION (§3.4a), not something discovered mid-stream: `start` connects
 * and answers "can this source do the job", and a verdict of `insufficient`
 * means `run` is never entered. A source that authenticated but cannot fetch
 * bodies says so here, loudly, with the step that fixes it, it never returns
 * an empty-looking success, because a mailbox going quiet is exactly what a
 * working mailbox looks like on a slow day.
 */
export interface InboundMailSource {
  readonly kind: 'imap' | 'gmail-history';
  /** Connect and report capability (§3.4a). Never returns empty-looking success. */
  start(signal: AbortSignal): Promise<InboundCapabilityVerdict>;
  /** Run until aborted, delivering to the sink. Push or poll is the source's business. */
  run(signal: AbortSignal): Promise<void>;
  /** Disclosed to the owner, so "real-time" is never claimed for polling. */
  readonly latency: SourceLatency;
  stop(): Promise<void>;
  /**
   * Re-probe now instead of at the next scheduled check.
   *
   * Optional, and the optionality is a statement rather than a convenience: a
   * source with nothing an immediate re-probe would pick up must not be made to
   * declare a method that does nothing, because a no-op `recheckNow` reads at
   * the call site exactly like one that works.
   *
   * `ImapMailSource` implements it, and what makes it meaningful there is that
   * `source-factory.ts`'s connection port resolves the host, the port, the
   * account and the stored password afresh inside every `open()`. An owner who
   * has just corrected one of those is one reconnect away from finding out;
   * this is what turns "one reconnect away" into "now" rather than "up to
   * `capabilityRecheckMinutes` from now".
   *
   * What it does NOT do, said here so a call site is not read as more than it
   * is: it cuts short `InboundMailboxWatcher.waitForRecheck()`, and that wait
   * exists only after a terminal verdict. On a healthy connected watcher there
   * is nothing to wake and asking is deliberately a no-op, a settings save is
   * not a reason to drop a working IDLE connection and rebuild it.
   *
   * `GmailMailSource` does not implement it. Its `insufficient` states are
   * grants changed in Google's console, and no edit to this daemon's settings
   * clears one, so an immediate re-probe would spend a request to learn what
   * was already known.
   */
  recheckNow?(): void;
}

/**
 * The latency as a sentence the owner can be shown.
 *
 * Deliberately never says "real-time" for a poll, and never implies a poll is
 * faster than its interval. Rounds to whole seconds because a millisecond
 * figure on a five-second poll is false precision.
 */
export function describeSourceLatency(latency: SourceLatency): string {
  if (latency.kind === 'push') {
    return 'The mail server pushes new mail as it arrives, so it is noticed within about a second.';
  }
  const seconds = Math.max(1, Math.round(latency.worstCaseMs / 1000));
  return `New mail is found by asking every ${String(seconds)} second${seconds === 1 ? '' : 's'}, `
    + `so it can go unnoticed for up to ${String(seconds)} second${seconds === 1 ? '' : 's'}. `
    + 'This is polling, not push, and nothing on this path is faster than the interval.';
}
