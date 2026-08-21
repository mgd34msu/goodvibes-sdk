/**
 * What the watcher is constructed with, what it publishes, and the two ceilings
 * that bound its retrying.
 *
 * Split out of `watcher.ts`, which had reached the 800-line cap. The dividing
 * line is deliberate: this file is the watcher's SHAPE, the arguments in, the
 * status out, and the constants those depend on, while `watcher.ts` keeps the
 * connection lifecycle that acts on them. A reader asking "what does the
 * supervisor see" is answered here without reading a protocol loop.
 *
 * Both constants are exported rather than private because the retry ceilings
 * they set are the difference between a watcher that recovers and one that
 * hammers a provider forever; each carries the argument for its own value.
 *
 * Re-exported from `watcher.ts`, which remains the name every consumer imports.
 */

import type { ImapBodyProbe } from '../imap-body-probe.js';
import type {
  InboundCapabilityVerdict,
  InboundMailObserver,
  InboundMailSink,
  InboundMailTerminalFailure,
  InboundWatcherSettings,
  MailboxConnectionPort,
  MailboxCursorPort,
  RandomSource,
  WatcherClock,
} from './ports.js';
import type { BackoffPolicy } from './backoff.js';
import type { MailboxCursor } from './types.js';

export interface InboundMailboxWatcherDeps {
  readonly settings: InboundWatcherSettings;
  readonly connections: MailboxConnectionPort;
  readonly cursors: MailboxCursorPort;
  readonly sink: InboundMailSink;
  readonly clock: WatcherClock;
  readonly random: RandomSource;
  readonly observer?: InboundMailObserver | undefined;
  readonly backoffPolicy?: BackoffPolicy | undefined;
}

/** What the supervisor folds into the standard channel status snapshot. */
export interface InboundMailboxWatcherStatus {
  readonly account: string;
  readonly mailbox: string;
  readonly running: boolean;
  readonly mode: 'idle' | 'polling' | 'inactive';
  readonly verdict: InboundCapabilityVerdict;
  readonly cursor: MailboxCursor | null;
  /** Non-null once the watcher has stopped for a reason only a change fixes. */
  readonly terminalFailure: InboundMailTerminalFailure | null;
  /**
   * Consecutive failed reconnect attempts. 0 once a connection has drained.
   *
   * Deliberately NOT "0 while connected", which is what it used to say and
   * what the code used to do. Opening a socket is not progress on its own: a
   * watcher that connects, fails its drain, disconnects and connects again is
   * making no progress at all, and resetting the count on the connect turned
   * an escalating backoff into a flat one that hammered the provider forever.
   * The count clears when a drain completes, when the connection has done the
   * thing it exists to do.
   */
  readonly reconnectAttempts: number;
  /** Completed connections, for telling "flapping" from "up". */
  readonly connections: number;
  /**
   * What the last connection's connect-time body probe found, or `null`
   * before any connection has opened.
   *
   * Kept distinct from `verdict` on purpose: `unproven` (an empty mailbox at
   * connect time) and `readable` are different facts about this account, and
   * both have to stay visible as such, reading either as "fine, same as the
   * other" is the exact silent-degradation mistake `ImapBodyProbe` exists to
   * make impossible to write by accident.
   */
  readonly bodyProbe: ImapBodyProbe | null;
}

/**
 * How many passes may end in an unexpected throw before it stops being treated
 * as a condition that will clear.
 *
 * Not one, a full disk during a log rotation, or a state directory being
 * replaced by an installer, recovers within seconds and a watcher that gave up
 * on the first one would need a restart it should not need. Not unbounded
 * either: retrying forever is how a permanently unwritable cursor becomes a
 * watcher that looks busy and delivers nothing. Ten attempts on the reconnect
 * backoff spans minutes, which is long enough for anything transient and short
 * enough that the owner hears about anything else the same hour.
 */
export const MAX_CONSECUTIVE_LOCAL_FAILURES = 10;

/**
 * How many drains may end in an unreadable FETCH answer before the mailbox is
 * called unreadable rather than retried.
 *
 * The same ceiling, for the same reason, as the throw path above, and it was
 * missing, which is the whole of the defect this constant closes. A drain that
 * ends in `read-failed` because the server's answer could not be parsed is
 * correct to retry: the message is still in the mailbox, the cursor has not
 * moved past it, and one torn response on one socket really does clear on the
 * next connection. What is not correct is retrying it forever. The unreadable
 * response is produced by the SERVER's wire format and this CLIENT's parser,
 * neither of which changes between attempts, so a batch that came back
 * unreadable ten times in a row will come back unreadable the eleventh time,
 * and the eleven-thousandth.
 *
 * The cost of not having this is not merely a stuck mailbox. The retry rides
 * the reconnect backoff, and the backoff only escalates if it is not being
 * reset, see `drainOnce`, which is now the only place that resets it. Before
 * that, a successful TCP connect reset the schedule and every reconnect
 * restarted from attempt zero: a flat 500 ms of sleep between logins,
 * indefinitely, against a provider that permits fifteen concurrent
 * connections. Ten attempts on an escalating backoff spans minutes, which is
 * long enough for anything genuinely transient and short enough that the owner
 * hears about anything else the same hour.
 */
export const MAX_CONSECUTIVE_UNREADABLE_DRAINS = 10;
