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

import type {
  InboundCapabilityReason,
  InboundCapabilityState,
  InboundCapabilityTransition,
  InboundCapabilityVerdict,
  InboundMailObserver,
  MailboxOpenReport,
  MailboxReader,
  WatcherClock,
} from './ports.js';
import { isConnectionLimitRefusal } from './backoff.js';

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
  'connection-limit': 'degraded',
  'credentials-rejected': 'insufficient',
  'mailbox-unreadable': 'insufficient',
  'uidvalidity-missing': 'insufficient',
  'fetch-refused': 'insufficient',
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
  'connection-limit': '',
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
  'fetch-refused':
    'The mailbox opened and the server refused to hand over message data, so '
    + 'arriving mail can be seen and not read. Check that the account is '
    + 'permitted IMAP access and is not restricted to a subset of folders.',
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

/** How the IDLE question was answered, and by what. */
export interface IdleSupportResolution {
  readonly supported: boolean;
  /**
   *   - `advertised` — the server volunteered its capabilities at greeting or
   *     login time and we read them for free;
   *   - `capability-probe` — it volunteered nothing, so we asked;
   *   - `unknown` — it volunteered nothing and would not answer either. Poll,
   *     and say that is why.
   */
  readonly resolvedBy: 'advertised' | 'capability-probe' | 'unknown';
}

/**
 * Decide whether this connection can hold an IDLE, resolving the unknown case
 * rather than collapsing it into "no".
 *
 * The whole point of the tri-state is that these three inputs are different:
 *
 *   | `supportsIdle` | meaning                       | what happens here |
 *   |----------------|-------------------------------|-------------------|
 *   | `true`         | advertised                    | IDLE              |
 *   | `false`        | advertised, and IDLE not in it| poll              |
 *   | `null`         | the server said nothing       | **ask, then decide** |
 *
 * A watcher that treated `null` as `false` would poll a push-capable server
 * forever and produce no evidence that it had done so.
 */
export async function resolveIdleSupport(
  report: MailboxOpenReport,
  reader: MailboxReader,
): Promise<IdleSupportResolution> {
  if (report.supportsIdle !== null) {
    return { supported: report.supportsIdle, resolvedBy: 'advertised' };
  }
  let atoms: readonly string[] = [];
  try {
    atoms = await reader.capabilities();
  } catch {
    // A server that will not answer leaves the question unknown, not false.
    return { supported: false, resolvedBy: 'unknown' };
  }
  if (atoms.length === 0) return { supported: false, resolvedBy: 'unknown' };
  return {
    supported: atoms.some((atom) => atom.toUpperCase() === 'IDLE'),
    resolvedBy: 'capability-probe',
  };
}

/**
 * The verdict for a connection that opened, given what the mode asked for and
 * what the server turned out to offer.
 *
 * Explicitly configured polling is `healthy`, not `degraded`: the watcher is
 * doing exactly what it was told, nothing is wrong, and a permanent amber
 * light for a working configuration is the same alarm fatigue this file exists
 * to avoid. Polling because push was unavailable is `degraded`, because
 * something the owner would want to know did not go the way it was meant to.
 */
export function verdictForOpenConnection(input: {
  readonly mode: 'idle' | 'poll' | 'auto';
  readonly idle: IdleSupportResolution;
}): InboundCapabilityVerdict {
  if (input.mode === 'poll') {
    return capabilityVerdict(
      'polling-configured',
      'Polling on a fixed interval, as the configured inbound mode asks for.',
    );
  }
  if (input.idle.supported) {
    return capabilityVerdict(
      'idle-push',
      input.idle.resolvedBy === 'capability-probe'
        ? 'Holding an IDLE connection; the server confirmed IDLE when asked.'
        : 'Holding an IDLE connection; the server advertised IDLE.',
    );
  }
  if (input.idle.resolvedBy === 'unknown') {
    return capabilityVerdict(
      'polling-capability-unknown',
      'The server would not say what it supports, so new mail is found by '
      + 'polling rather than assumed to be unpushable.',
    );
  }
  return capabilityVerdict(
    'polling-no-idle',
    'The server does not advertise IDLE, so new mail is found by polling.',
  );
}

// ---------------------------------------------------------------------------
// Classifying failures
// ---------------------------------------------------------------------------

/**
 * The three named ways an open can fail, as a shape rather than a class.
 *
 * Duck-typed so a `MailboxConnectionPort` implementation is free to throw its
 * own error type: what matters is that it named the reason and said whether
 * retrying could ever help, not which constructor produced it.
 */
export interface OpenFailureShape {
  readonly reason: 'authentication-rejected' | 'mailbox-unavailable' | 'connection-failed';
  readonly terminal: boolean;
  readonly serverMessage: string;
  readonly message: string;
}

function readOpenFailure(error: unknown): OpenFailureShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as Partial<Record<string, unknown>>;
  const reason = candidate['reason'];
  if (
    reason !== 'authentication-rejected'
    && reason !== 'mailbox-unavailable'
    && reason !== 'connection-failed'
  ) return null;
  return {
    reason,
    terminal: candidate['terminal'] === true,
    serverMessage: typeof candidate['serverMessage'] === 'string' ? candidate['serverMessage'] : '',
    message: typeof candidate['message'] === 'string' ? candidate['message'] : '',
  };
}

/** Everything the caller can read off a failed open, already classified. */
export interface OpenFailureVerdict {
  readonly verdict: InboundCapabilityVerdict;
  /**
   * True when retrying on a backoff cannot help and the watcher must stop
   * until something changes. A connection limit is NOT terminal.
   */
  readonly terminal: boolean;
}

/**
 * Turn a failed `open()` into a verdict.
 *
 * The ordering here is the load-bearing part. A simultaneous-connection
 * refusal arrives at LOGIN, and the open path classifies anything the server
 * refuses at LOGIN as `authentication-rejected`, which is TERMINAL. Checking
 * the provider's own wording first is what keeps a condition that clears in
 * seconds from permanently stopping the watcher — and it is checked against
 * both the composed message and the server's raw text, because a caller may
 * carry the provider's words in either.
 */
export function classifyOpenFailure(error: unknown): OpenFailureVerdict {
  const text = errorText(error);
  const failure = readOpenFailure(error);
  const wording = failure === null
    ? text
    : `${failure.message} ${failure.serverMessage}`.trim();

  if (isConnectionLimitRefusal(wording)) {
    return {
      verdict: capabilityVerdict('connection-limit', wording),
      terminal: false,
    };
  }
  if (failure === null) {
    return { verdict: capabilityVerdict('reconnecting', text), terminal: false };
  }
  if (failure.reason === 'authentication-rejected' && failure.terminal) {
    return { verdict: capabilityVerdict('credentials-rejected', wording), terminal: true };
  }
  if (failure.reason === 'mailbox-unavailable' && failure.terminal) {
    return { verdict: capabilityVerdict('mailbox-unreadable', wording), terminal: true };
  }
  return { verdict: capabilityVerdict('reconnecting', wording), terminal: false };
}

/**
 * Whether a failure while reading messages means the mailbox cannot be read at
 * all, or merely that this connection ended.
 *
 * The phase matters, and conflating the two would be a real defect in opposite
 * directions:
 *
 *   - A `NO`/`BAD` to a **FETCH** is a mailbox whose contents the server will
 *     not hand over. Arrival can be observed and never read, so the capability
 *     is `insufficient` and reconnecting achieves nothing — the watcher stops
 *     and says so.
 *   - A `NO` to a **SEARCH** is not the same claim. Servers refuse searches
 *     transiently, under load, and on a folder being reindexed, and stopping
 *     the watcher for an hour over one of those would turn a hiccup into
 *     silence. It reconnects.
 *   - A socket that died is a reconnect either way.
 */
export function classifyReadFailure(
  error: unknown,
  phase: 'search' | 'fetch' = 'fetch',
): OpenFailureVerdict {
  const text = errorText(error);
  if (isConnectionLimitRefusal(text)) {
    return { verdict: capabilityVerdict('connection-limit', text), terminal: false };
  }
  if (phase === 'fetch' && /^IMAP command failed:/.test(text)) {
    return { verdict: capabilityVerdict('fetch-refused', text), terminal: true };
  }
  return { verdict: capabilityVerdict('reconnecting', text), terminal: false };
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
