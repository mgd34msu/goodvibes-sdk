/**
 * Can this watcher do its job at all — and if not, does the owner know?
 *
 * A watcher has three honest answers, not two. It is `healthy` when it is
 * doing what it was configured to do; `degraded` when it is running with less
 * than it wanted — polling because the server offers no push, or waiting out a
 * reconnect — and `insufficient` when it CANNOT do the job, because the
 * mailbox will not open or the credential is refused.
 *
 * The third one is the reason this file exists. A capability that cannot work
 * and does not say so is worse than one that is switched off, because the
 * owner believes he has a channel. So `insufficient` does not degrade
 * silently: the watcher does not run, and the condition is surfaced with the
 * one step that would fix it.
 *
 * Told once, not told repeatedly
 * ──────────────────────────────
 * The notification fires ONCE PER TRANSITION. Re-probing on an hourly timer
 * and announcing the same refused credential every hour trains the owner to
 * ignore the exact channel this capability depends on being read; by the third
 * night it is noise, and the message that mattered arrives in a stream he has
 * learned to swipe away. So a verdict identical to the one before it changes
 * nothing and says nothing — but the re-probe still runs, so fixing a scope or
 * a password recovers without a restart.
 *
 * The tri-state that this file exists to respect
 * ──────────────────────────────────────────────
 * `ImapConnectionReport.supportsIdle` is `boolean | null`, and `null` means
 * THE SERVER SAID NOTHING — never "no". `if (report.supportsIdle)` is
 * therefore wrong in a way that produces no error and no log line: it silently
 * polls forever against a server that would have pushed. Resolving a `null`
 * means asking, with a `CAPABILITY` command, and only a server that will not
 * answer even then leaves the question genuinely unknown.
 */

import {
  classifyServerRefusal,
  describeEmailCapabilityFailure,
  resolveIdleSupport,
} from '../imap-open.js';
import type {
  EmailCapabilityFailureNotice,
  EmailCapabilityFailureReason,
  ImapIdleDecision,
} from '../imap-client.js';
import type {
  InboundCapabilityReason,
  InboundCapabilityState,
  InboundCapabilityTransition,
  InboundCapabilityVerdict,
  InboundMailObserver,
  MailboxReader,
  WatcherClock,
} from './ports.js';

export { resolveIdleSupport } from '../imap-open.js';

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

const STATE_BY_REASON: Readonly<Record<InboundCapabilityReason, InboundCapabilityState>> = {
  'idle-push': 'healthy',
  'polling-configured': 'healthy',
  'polling-no-idle': 'degraded',
  'polling-idle-refused': 'degraded',
  'polling-capability-unknown': 'degraded',
  reconnecting: 'degraded',
  'server-unavailable': 'degraded',
  'credentials-missing': 'insufficient',
  'credentials-rejected': 'insufficient',
  'mailbox-unreadable': 'insufficient',
  'uidvalidity-missing': 'insufficient',
  'mailbox-position-unknown': 'insufficient',
  'fetch-refused': 'insufficient',
  'gmail-metadata-only': 'insufficient',
  // Running, and running with less than it wanted — the definition of
  // `degraded`. Mail IS being announced; what cannot happen is a verification
  // being satisfied.
  'gmail-metadata-notice-only': 'degraded',
  'fetch-unreadable': 'insufficient',
  'local-store-unwritable': 'insufficient',
  'watcher-stopped-unexpectedly': 'insufficient',
};

/**
 * The remedial step for each reason, or '' where waiting is the step.
 *
 * One step, imperative, naming the thing to change. "Check your settings" is
 * not a fix; "the mail server refused the credential — store a new app
 * password" is, and it is what gets routed to the owner when a state goes
 * `insufficient`.
 *
 * Only settings that EXIST today are named by key. The inbound watcher's own
 * settings land with the config schema in a separate round, and a fix that
 * named a key the settings screen has no row for would send the owner looking
 * for something that is not there — the precise defect
 * `platform-daemon-mailbox-schema` exists to catch. Those are described in
 * words until the keys are real.
 */
const FIX_BY_REASON: Readonly<Record<InboundCapabilityReason, string>> = {
  'idle-push': '',
  'polling-configured': '',
  'polling-no-idle':
    'Nothing to fix — this mail server offers no push, so new mail is found by '
    + 'polling instead. Shortening the inbound poll interval finds it sooner, '
    + 'at the cost of more requests to the mail server.',
  'polling-idle-refused':
    'Nothing to fix — the server advertised IDLE and then refused it, so new '
    + 'mail is found by polling instead.',
  'polling-capability-unknown':
    'Nothing to fix — the server would not say whether it supports push, so '
    + 'new mail is found by polling instead.',
  reconnecting: '',
  'server-unavailable': '',
  'credentials-missing':
    'No mail password is stored where the daemon reads secrets, so there is '
    + 'nothing to sign in with. Store one at daemon scope.',
  'credentials-rejected':
    'The mail server refused the sign-in. Replace the stored password for this '
    + 'account (surfaces.email.imap.password); if the account uses two-factor '
    + 'sign-in, that value has to be an app password, not the login password.',
  'mailbox-unreadable':
    'The sign-in worked and the mailbox did not open. Check the folder name '
    + '(surfaces.email.imap.mailbox) against the folders the account actually '
    + 'has — on Gmail the name is case-sensitive and nested folders are '
    + 'written like [Gmail]/All Mail.',
  'uidvalidity-missing':
    'The mail server opened the mailbox without reporting a UIDVALIDITY, which '
    + 'every IMAP server is required to send. Without it the daemon cannot tell '
    + 'across a restart which messages it has already handled. Point '
    + 'surfaces.email.imap.mailbox at a mailbox on a server that reports one, '
    + 'or report this to the mail provider.',
  'mailbox-position-unknown':
    'The mail server opened the mailbox without saying how far it goes (no '
    + 'UIDNEXT), and when asked directly it listed no messages while still '
    + 'reporting that the mailbox holds some. Those two answers contradict each '
    + 'other, so there is no starting point the daemon can trust. It has stopped '
    + 'rather than start from zero, because starting from zero would treat every '
    + 'message already in the mailbox as new and announce all of them. Point '
    + 'surfaces.email.imap.mailbox at a different mailbox on this account to see '
    + 'whether the problem follows the folder or the server, and report the '
    + 'contradiction to the mail provider. Inbound mail retries when the daemon '
    + 'restarts or when inbound settings change.',
  'fetch-refused':
    'The mailbox opened and the server refused to hand over message data, so '
    + 'arriving mail can be seen and not read. Check that the account is '
    + 'permitted IMAP access and is not restricted to a subset of folders.',
  'gmail-metadata-only':
    'The connected Google account granted the gmail.metadata scope, which Google '
    + 'describes as "View your email message metadata such as labels and headers, '
    + 'but not the email body". Headers can be read and bodies cannot, so no '
    + 'signup, password reset or order confirmation can be completed from this '
    + 'mailbox. Re-authorize granting a body-capable scope (gmail.readonly, '
    + 'gmail.modify, or https://mail.google.com/). To be told that mail arrived '
    + 'without being able to act on it, set '
    + 'surfaces.email.inbound.onInsufficientCapability to "notice-only" — that '
    + 'announces the sender, subject and delivery address of every message and '
    + 'still completes nothing.',
  'gmail-metadata-notice-only':
    'Nothing is broken and nothing will complete. The Google grant excludes '
    + 'message bodies (gmail.metadata), and '
    + 'surfaces.email.inbound.onInsufficientCapability is set to "notice-only", '
    + 'so every arriving message is announced from its sender, subject and '
    + 'delivery address alone. No verification expectation can be satisfied '
    + 'while this lasts, so a signup or an order confirmation waiting on a link '
    + 'in a message body will wait until it expires. Re-authorize granting '
    + 'gmail.readonly, gmail.modify, or https://mail.google.com/ to restore it.',
  'fetch-unreadable':
    'The mail server is answering the request for message data and the daemon '
    + 'cannot read the answers it sends, so mail is arriving and none of it can '
    + 'be handed on. Nothing is lost — the messages are still in the mailbox and '
    + 'the daemon has not marked them handled — but it has stopped asking, '
    + 'because asking again was producing the same unreadable answer several '
    + 'times a second. The detail above is what could not be read; it is a '
    + 'mismatch between this daemon and this mail server rather than anything '
    + 'wrong with the account, so it is worth reporting with that detail '
    + 'attached. Inbound mail retries when the daemon restarts or when inbound '
    + 'settings change.',
  'local-store-unwritable':
    'The daemon cannot write the file it records handled mail in, so it has '
    + 'stopped reading rather than announce the same message repeatedly or '
    + 'lose its place at the next restart. This is local: check free space and '
    + 'write permission on the daemon state directory (~/.goodvibes/daemon).',
  'watcher-stopped-unexpectedly':
    'The mailbox watcher stopped with a failure that does not name a cause the '
    + 'daemon recognises, so it is reported verbatim rather than guessed at. '
    + 'The detail above is what it said; inbound mail restarts with the daemon '
    + 'or when inbound settings change.',
};

/** Build a verdict, taking its state and its fix from its reason. */
export function capabilityVerdict(
  reason: InboundCapabilityReason,
  detail = '',
): InboundCapabilityVerdict {
  return {
    state: STATE_BY_REASON[reason],
    reason,
    detail,
    fix: FIX_BY_REASON[reason],
  };
}

/** The state a reason implies. Exported so callers need no second table. */
export function stateForReason(reason: InboundCapabilityReason): InboundCapabilityState {
  return STATE_BY_REASON[reason];
}

// ---------------------------------------------------------------------------
// Resolving whether the server can push
// ---------------------------------------------------------------------------

/**
 * The verdict for a connection that opened, given what the mode asked for and
 * what the server turned out to offer.
 *
 * The IDLE decision itself is NOT made here. `resolveIdleSupport` in
 * `imap-open.ts` owns it, resolves "the server said nothing" by issuing
 * `CAPABILITY`, and names how it found out. This file only turns that answer
 * into a watcher state, because two resolvers would be two answers and the
 * quiet one would win.
 *
 * Explicitly configured polling is `healthy`, not `degraded`: the watcher is
 * doing exactly what it was told, nothing is wrong, and a permanent amber
 * light for a working configuration is alarm fatigue. Polling because push was
 * unavailable is `degraded`, because something the owner would want to know
 * did not go the way it was meant to.
 */
export function verdictForOpenConnection(input: {
  readonly mode: 'idle' | 'poll' | 'auto';
  readonly idle: ImapIdleDecision;
}): InboundCapabilityVerdict {
  if (input.mode === 'poll') {
    return capabilityVerdict(
      'polling-configured',
      'Polling on a fixed interval, as the configured inbound mode asks for.',
    );
  }
  if (input.idle.supported) {
    return capabilityVerdict('idle-push', 'Holding an IDLE connection; the server advertised IDLE.');
  }
  if (input.idle.reason === 'server-would-not-say') {
    return capabilityVerdict(
      'polling-capability-unknown',
      'The server would not say what it supports, even when asked, so new mail '
      + 'is found by polling rather than assumed to be unpushable.',
    );
  }
  return capabilityVerdict(
    'polling-no-idle',
    'The server listed its capabilities and IDLE was not among them, so new '
    + 'mail is found by polling.',
  );
}

// ---------------------------------------------------------------------------
// Classifying failures
// ---------------------------------------------------------------------------

/** Everything the caller can read off a failure, already classified. */
export interface OpenFailureVerdict {
  readonly verdict: InboundCapabilityVerdict;
  /**
   * True when retrying on a backoff cannot help and the watcher must stop
   * until something changes. Taken from the failure's own record, never
   * re-derived here.
   */
  readonly terminal: boolean;
  /** The routable record, when the failure carried one. */
  readonly notice: EmailCapabilityFailureNotice | null;
}

/** Each email-layer failure reason as the watcher state it produces. */
const REASON_FOR_NOTICE: Readonly<
  Record<EmailCapabilityFailureReason, InboundCapabilityReason>
> = {
  'credential-unavailable': 'credentials-missing',
  'authentication-rejected': 'credentials-rejected',
  'mailbox-unavailable': 'mailbox-unreadable',
  'server-unavailable': 'server-unavailable',
  'connection-failed': 'reconnecting',
};

/**
 * Turn a failed `open()` into a verdict.
 *
 * This used to re-read the server's wording ahead of the reason, because
 * `composeOpenFailure` classified by PHASE and called every refusal at LOGIN a
 * rejected credential — which is terminal, and which Gmail's
 * `NO [LIMIT] Too many simultaneous connections` arrives as. That workaround
 * is gone: the email layer now classifies from the response code and the
 * wording first, produces `server-unavailable` for a refusal about the server
 * rather than the account, and prefers the non-terminal reading when the
 * refusal is ambiguous.
 *
 * So there is one classifier and this reads its answer. Two classifiers is how
 * the wrong one wins silently, and the wrong one here stops mail delivery
 * until a person notices.
 *
 * The owner-facing sentence comes from the notice as well, so a rejected
 * credential produces ONE text wherever it surfaces rather than one from the
 * email layer and a competing one from here.
 */
export function classifyOpenFailure(error: unknown): OpenFailureVerdict {
  const text = errorText(error);
  const notice = describeEmailCapabilityFailure(error);
  if (notice === null) {
    // A socket that never reached a server, or a factory that threw. Nothing
    // said it was about the account, so it is a reconnect.
    return {
      verdict: capabilityVerdict('reconnecting', text),
      terminal: false,
      notice: null,
    };
  }
  const reason = REASON_FOR_NOTICE[notice.reason];
  return {
    verdict: {
      state: STATE_BY_REASON[reason],
      reason,
      detail: notice.serverMessage.length > 0 ? notice.serverMessage : text,
      fix: notice.ownerMessage,
    },
    terminal: notice.terminal,
    notice,
  };
}

/**
 * Whether a failure while reading messages means the mailbox cannot be read at
 * all, or merely that this connection ended.
 *
 * The server's own words are read by `classifyServerRefusal` — the same
 * function the open path uses — so a `[LIMIT]` refused mid-session is the same
 * `server-unavailable` it would have been at login. The phase reason handed in
 * is deliberately the non-terminal one, so a refusal that says nothing about
 * itself falls through to the rule below rather than to a verdict that stops
 * the watcher.
 *
 * When the server named nothing, the phase decides, and the two phases are
 * different claims:
 *
 *   - A `NO`/`BAD` to a **FETCH** is a mailbox whose contents the server will
 *     not hand over. Arrival can be observed and never read, so the capability
 *     is `insufficient` and reconnecting achieves nothing.
 *   - A `NO` to a **SEARCH** is not that claim. Servers refuse searches
 *     transiently, under load, and on a folder being reindexed, and stopping
 *     for an hour over one would turn a hiccup into silence.
 */
export function classifyReadFailure(
  error: unknown,
  phase: 'search' | 'fetch' = 'fetch',
): OpenFailureVerdict {
  const text = errorText(error);
  const transient = { terminal: false, notice: null } as const;
  if (!/^IMAP command failed:/.test(text)) {
    return { verdict: capabilityVerdict('reconnecting', text), ...transient };
  }
  const named = classifyServerRefusal(text, 'connection-failed');
  if (named === 'server-unavailable') {
    return { verdict: capabilityVerdict('server-unavailable', text), ...transient };
  }
  if (named === 'authentication-rejected') {
    return {
      verdict: capabilityVerdict('credentials-rejected', text),
      terminal: true,
      notice: null,
    };
  }
  if (named === 'mailbox-unavailable') {
    return {
      verdict: capabilityVerdict('mailbox-unreadable', text),
      terminal: true,
      notice: null,
    };
  }
  if (phase === 'fetch') {
    return { verdict: capabilityVerdict('fetch-refused', text), terminal: true, notice: null };
  }
  return { verdict: capabilityVerdict('reconnecting', text), ...transient };
}

/**
 * Filesystem conditions that clear on their own, and the ones that do not.
 *
 * Split by errno rather than by message text because the message is the
 * platform's to phrase and the code is not: `ENOSPC` on a log-rotating machine
 * is genuinely a wait, while `EACCES` on a state directory is a decision
 * somebody made and no amount of retrying reverses it. Anything unrecognised
 * is treated as transient, because the cost of retrying a permanent fault is a
 * bounded number of retries and the cost of stopping on a transient one is
 * mail that never arrives.
 */
const PERMANENT_STORE_ERRNOS: ReadonlySet<string> = new Set([
  'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG',
]);

/** Errnos that mean the local filesystem, as opposed to a socket. */
const STORAGE_ERRNOS: ReadonlySet<string> = new Set([
  ...PERMANENT_STORE_ERRNOS,
  'ENOSPC', 'EDQUOT', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'ENOENT', 'EFBIG', 'ETXTBSY',
]);

function errnoOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/**
 * Classify a failure that escaped the reading path entirely — a cursor write
 * that threw, an injected dependency that broke, a bug.
 *
 * This is the classifier behind the rule that an unexpected throw is CAUGHT,
 * named and reported rather than allowed to unwind the run loop into a
 * `.catch(() => undefined)`. `consecutive` is how many of these have happened
 * in a row without a completed drain in between: a first `ENOSPC` is a wait,
 * and the tenth is a condition the owner has to be told about, because at that
 * point "it will clear on its own" has been disproved by the machine.
 */
export function classifyLocalFailure(
  error: unknown,
  consecutive: number,
  giveUpAfter: number,
): OpenFailureVerdict {
  const text = errorText(error);
  const errno = errnoOf(error);
  const permanent = PERMANENT_STORE_ERRNOS.has(errno);
  const exhausted = consecutive >= giveUpAfter;
  if (!permanent && !exhausted) {
    return {
      verdict: capabilityVerdict('reconnecting',
        `The mailbox watcher could not complete a pass: ${text}. `
        + `Attempt ${String(consecutive)} of ${String(giveUpAfter)} before this is `
        + 'treated as permanent.'),
      terminal: false,
      notice: null,
    };
  }
  // A store write is the only local failure with a fix worth naming, so only a
  // failure that looks like one borrows that advice. Anything else keeps its
  // own words: sending an owner to check disk space over an unrelated bug is
  // the same class of mistake as calling a connection limit a bad password.
  const reason = STORAGE_ERRNOS.has(errno) || /\bcursor\b/i.test(text)
    ? 'local-store-unwritable'
    : 'watcher-stopped-unexpectedly';
  return { verdict: capabilityVerdict(reason, text), terminal: true, notice: null };
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? '');
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Holds the current verdict and announces only the changes.
 *
 * `record()` returns whether it announced, so the caller can tell "this is
 * new" from "this is the same thing again" without comparing verdicts itself
 * — which is the comparison that gets forgotten, and forgetting it is what
 * turns an hourly re-probe into an hourly alarm.
 *
 * The comparison is on state AND reason, and deliberately not on `detail`: the
 * detail carries the server's own wording, and a server that phrases the same
 * refusal differently between attempts — a session id in the text, a
 * timestamp — must not read as a new condition. The stored verdict is still
 * updated to the latest wording, so status shows what the server last said.
 */
export class CapabilityStateTracker {
  private readonly account: string;
  private readonly mailbox: string;
  private readonly clock: WatcherClock;
  private readonly observer: InboundMailObserver | undefined;
  private verdict: InboundCapabilityVerdict | null = null;
  private transitions = 0;

  constructor(input: {
    readonly account: string;
    readonly mailbox: string;
    readonly clock: WatcherClock;
    readonly observer?: InboundMailObserver | undefined;
  }) {
    this.account = input.account;
    this.mailbox = input.mailbox;
    this.clock = input.clock;
    this.observer = input.observer;
  }

  get current(): InboundCapabilityVerdict | null {
    return this.verdict;
  }

  get state(): InboundCapabilityState {
    return this.verdict?.state ?? 'degraded';
  }

  /** How many times the state or reason has actually changed. */
  get transitionCount(): number {
    return this.transitions;
  }

  /**
   * Record a verdict. Returns true when this was a transition and the observer
   * was told, false when it was the same condition observed again.
   */
  record(next: InboundCapabilityVerdict): boolean {
    const previous = this.verdict;
    const changed = previous === null
      || previous.state !== next.state
      || previous.reason !== next.reason;
    this.verdict = next;
    if (!changed) return false;
    this.transitions += 1;
    const transition: InboundCapabilityTransition = {
      account: this.account,
      mailbox: this.mailbox,
      from: previous,
      to: next,
      at: new Date(this.clock.now()).toISOString(),
    };
    try {
      this.observer?.stateChanged?.(transition);
    } catch {
      // An observer that throws must not take the watcher down with it: the
      // watcher's job is to keep reading mail, and it can do that whether or
      // not somebody's notification route is working.
    }
    return true;
  }
}
