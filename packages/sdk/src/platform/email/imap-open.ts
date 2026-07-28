/**
 * Opening a connection: what it turned out to be able to do, the ways it can
 * fail to become readable, and what the owner is told when it does.
 *
 * Split out of `imap-client.ts` to keep that file under the repository's
 * per-file line cap, and because these types are what a caller reasons about
 * BEFORE it has a usable client — the failure it has to classify and the
 * capability record it has to read.
 */

import type { ImapMailboxStatus } from './imap-headers.js';
import type { ImapConnection, ImapSession } from './imap-session.js';
import type { ImapClient } from './imap-client.js';

/**
 * What a caller is told when it reads before connecting. Named rather than
 * inlined because two places raise it and one test asserts on it.
 */
export const NOT_OPEN_MESSAGE =
  'The IMAP connection is not open. Call open() before reading from the mailbox.';

/**
 * Why a connection could not be opened, as four distinct facts.
 *
 * They are distinct because they call for different responses, and a caller
 * that cannot tell them apart necessarily gets some of them wrong:
 *
 *   - `authentication-rejected` — the credential was REFUSED as a credential,
 *     or could not be put on the wire at all. TERMINAL. Retrying a rejected
 *     password on a backoff loop is how an account gets locked; the operator
 *     has to change something before this can succeed.
 *   - `mailbox-unavailable` — the credential worked and the named mailbox does
 *     not exist. TERMINAL for the same reason: reconnecting does not create a
 *     folder. Authenticated is not readable, and this is the case that says so.
 *   - `server-unavailable` — the server said no for a reason that is about the
 *     SERVER, not the account: a connection limit, a capacity refusal, a
 *     temporary fault. NOT terminal. This exists because a refusal at the
 *     login step is not necessarily about the login: Gmail answers
 *     `NO [LIMIT] Too many simultaneous connections` right there, and it
 *     clears in seconds. Classifying that as a rejected credential stops a
 *     watcher permanently, and the symptom is a mailbox that looks quiet while
 *     mail piles up behind it — which is the failure this whole capability
 *     exists to end. We reach it routinely on our own account, because
 *     `EmailService` opens a fresh connection per request on top of the one a
 *     watcher holds permanently, and Gmail allows fifteen at once.
 *   - `connection-failed` — the socket, the greeting or the timing. Transient.
 *
 * When the server gives no response code and its wording is ambiguous, the
 * classification is deliberately the NON-terminal one. The asymmetry is not
 * close: guessing terminal stops mail delivery until a human notices, guessing
 * transient costs a retry.
 */
export type ImapOpenFailureReason =
  | 'authentication-rejected'
  | 'mailbox-unavailable'
  | 'server-unavailable'
  | 'connection-failed';

/** Reasons where retrying cannot help; something has to change first. */
const TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'authentication-rejected',
  'mailbox-unavailable',
  'credential-unavailable',
]);

/**
 * RFC 3501 / RFC 5530 response codes that describe the SERVER's condition
 * rather than the account's. None of these is a reason to stop.
 *
 * `LIMIT` is Gmail's too-many-connections refusal. `INUSE` is a mailbox
 * another session holds. `UNAVAILABLE` is the server saying so outright.
 * `SERVERBUG` and `CONTACTADMIN` describe a server fault, which is somebody
 * else's to fix and not a reason to stop asking.
 */
const TRANSIENT_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'LIMIT',
  'INUSE',
  'UNAVAILABLE',
  'SERVERBUG',
  'CONTACTADMIN',
  'OVERQUOTA',
]);

/** Response codes that name a credential the server will not accept. */
const AUTH_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'AUTHENTICATIONFAILED',
  'AUTHORIZATIONFAILED',
  'EXPIRED',
  'PRIVACYREQUIRED',
]);

/** Response codes that name a mailbox that is not there. */
const MAILBOX_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'NONEXISTENT',
  'TRYCREATE',
]);

/** Wording that means "the server is busy", used when no code was given. */
const TRANSIENT_WORDING = [
  /too many simultaneous/i,
  /too many connections/i,
  /connection limit/i,
  /rate limit/i,
  /temporarily/i,
  /try again/i,
  /server (is )?busy/i,
  /service unavailable/i,
  /system error/i,
];

/** Wording that means "this credential is not acceptable", when no code. */
const AUTH_WORDING = [
  /invalid credential/i,
  /invalid (user|username|password|login)/i,
  /authentication fail/i,
  /login fail/i,
  /bad (credential|password|username)/i,
  /password.*(incorrect|wrong)/i,
  /(incorrect|wrong).*password/i,
  /application-specific password required/i,
  /web login required/i,
];

/** Wording that means "no such folder", when no code. */
const MAILBOX_WORDING = [
  /no such mailbox/i,
  /unknown mailbox/i,
  /mailbox does ?n'?o?t exist/i,
  /does not exist/i,
  /no such folder/i,
];

/** The bracketed response code of a `NO`/`BAD` line, upper-cased, or ''. */
function responseCodeOf(serverMessage: string): string {
  const match = /\[([A-Za-z-]+)[\s\]]/.exec(serverMessage);
  return (match?.[1] ?? '').toUpperCase();
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * What a server refusal actually means, read from the refusal itself.
 *
 * The phase a refusal arrived in is a hint, not the answer. A `NO` at the
 * login step is only an authentication failure when it says something about
 * authentication; when it says `[LIMIT]` it is about the server, and treating
 * the two the same is how a transient condition becomes permanent silence.
 * `phaseReason` is used only when the refusal itself is ambiguous AND the
 * phase's own reason is not the terminal guess.
 */
export function classifyServerRefusal(
  serverMessage: string,
  phaseReason: ImapOpenFailureReason,
): ImapOpenFailureReason {
  const code = responseCodeOf(serverMessage);
  if (TRANSIENT_RESPONSE_CODES.has(code)) return 'server-unavailable';
  if (AUTH_RESPONSE_CODES.has(code)) return 'authentication-rejected';
  if (MAILBOX_RESPONSE_CODES.has(code)) return 'mailbox-unavailable';

  if (matchesAny(TRANSIENT_WORDING, serverMessage)) return 'server-unavailable';
  if (matchesAny(AUTH_WORDING, serverMessage)) return 'authentication-rejected';
  if (matchesAny(MAILBOX_WORDING, serverMessage)) return 'mailbox-unavailable';

  // Nothing in the refusal says what it was about. Prefer the answer that
  // keeps trying: a wrong "terminal" stops mail until a human notices, a wrong
  // "transient" costs a retry.
  return TERMINAL_REASONS.has(phaseReason) ? 'server-unavailable' : phaseReason;
}

/**
 * An `open()` that did not reach a readable mailbox, with the reason named.
 *
 * The message is composed so it still contains the underlying wording — the
 * server's own text where the server gave any — because "IMAP command failed"
 * with no further detail is what made these three indistinguishable before.
 */
export class ImapOpenError extends Error {
  readonly reason: ImapOpenFailureReason;
  /** The server's own words, or the original failure text. '' when neither. */
  readonly serverMessage: string;
  /** The mailbox this attempt was for. */
  readonly mailbox: string;
  /** True only when retrying cannot help; something has to change first. */
  readonly terminal: boolean;
  /**
   * The routable record. A supervisor reads this and delivers it; it does not
   * have to re-derive from a message string what the failure was, and a
   * terminal failure therefore cannot end as a log line nobody reads.
   */
  readonly notice: EmailCapabilityFailureNotice;

  constructor(input: {
    readonly reason: ImapOpenFailureReason;
    readonly summary: string;
    readonly serverMessage: string;
    readonly mailbox: string;
  }) {
    super(
      input.serverMessage.length > 0
        ? `${input.summary} ${input.serverMessage}`
        : input.summary,
    );
    this.name = 'ImapOpenError';
    this.reason = input.reason;
    this.serverMessage = input.serverMessage;
    this.mailbox = input.mailbox;
    this.terminal = TERMINAL_REASONS.has(input.reason);
    this.notice = {
      reason: input.reason,
      terminal: this.terminal,
      mailbox: input.mailbox,
      ownerMessage: ownerMessageForFailure(input.reason, input.mailbox),
      serverMessage: input.serverMessage,
    };
  }
}

/**
 * What a connection turned out to be able to do, established at open time.
 *
 * Returned by `open()` rather than assumed, because "the socket connected and
 * the password was accepted" answers neither "can I read this mailbox" nor
 * "can this connection be held open with IDLE", and a caller that treats it as
 * though it did has no way to find out it was wrong except by getting nothing.
 */
export interface ImapConnectionReport {
  /**
   * Capability atoms the server volunteered, upper-cased. Empty means it
   * volunteered none — ask `capabilities()`, which will request them.
   */
  readonly advertisedCapabilities: readonly string[];
  /**
   * Whether `IDLE` (RFC 2177) was advertised — as two cases, not three values.
   *
   * A tri-state whose third value can be read as falsy looks careful and
   * behaves carelessly: `if (report.supportsIdle)` would compile and would
   * quietly mean "poll forever against a server that supports push". This
   * shape does not permit that. `.supported` does not exist until `.known` has
   * been narrowed to true, so a caller either handles "the server said
   * nothing" or does not compile.
   *
   * The way to handle it is `resolveIdleSupport(client)`, which answers the
   * unknown case by actually asking.
   */
  readonly idle: ImapIdleSupport;
  /** The mailbox that was EXAMINEd, and what the server said about it. */
  readonly mailbox: ImapMailboxStatus & { readonly name: string };
  /**
   * Whether a connect-time BODY.PEEK probe confirmed the mailbox will hand
   * over message content — see `ImapBodyProbeVerdict`.
   *
   * Plain `open()` never probes: this reads `{ probed: false }` for every
   * ordinary connection, which is accurate (no round trip happened) rather
   * than a claim. Only the inbound watcher's connection wiring
   * (`inbound/connection.ts`) actually calls `probeBodyAccess()` and replaces
   * this field with what it found, because only a long-lived watcher needs
   * the answer before it opens an expectation nobody can satisfy.
   */
  readonly bodyProbe: ImapBodyProbeVerdict;
}

/**
 * What the server said about IDLE, in a shape that cannot be read as a boolean
 * by accident.
 *
 * Two cases, not three values: either the server told us (`known: true`, with
 * the answer) or it told us nothing (`known: false`, with no answer to read).
 * `supported` is deliberately absent from the second case rather than present
 * and undefined — present-and-undefined is falsy, which is the exact mistake
 * this shape exists to make impossible.
 */
export type ImapIdleSupport =
  | { readonly known: true; readonly supported: boolean }
  | { readonly known: false };

/**
 * What a connect-time BODY.PEEK probe found out about a mailbox, in the same
 * discipline as `ImapIdleSupport` and for the identical reason: a caller that
 * can read this as a plain boolean has already made the mistake this shape
 * exists to rule out.
 *
 * `IDLE` support is a two-case question — the server said yes/no, or it said
 * nothing. Body access is a THREE-case question, because IMAP has no
 * `CAPABILITY` atom that declares it the way `IDLE` is declared: permission is
 * discoverable only by asking for data, and on an empty mailbox there is
 * nothing to ask for. So the cases are:
 *
 *   - `probed: false` — nothing was fetched, because the mailbox held no
 *     message to fetch (or, for the rare fetch that named an already-expunged
 *     UID, because nothing came back for it). This is **not** the same as
 *     `ok: true`. No round trip confirmed anything, and reading an unprobed
 *     mailbox as proven-fine is exactly the silent-degradation mistake this
 *     design exists to refuse everywhere else. The reactive path — a real
 *     fetch refused later, once there is a real message to refuse — remains
 *     the answer for a mailbox in this state.
 *   - `probed: true, ok: true` — the server handed over a byte of the newest
 *     message. Body access is confirmed before any expectation could be
 *     opened.
 *   - `probed: true, ok: false` — the server refused to hand over the byte it
 *     was asked for, with its own wording in `detail`. The caller turns this
 *     into the SAME `fetch-refused` / `insufficient` verdict the reactive path
 *     already produces (`inbound/capability.ts`) — this is that finding,
 *     reached sooner, not a second kind of finding.
 *
 * `ok` does not exist until `probed` has been narrowed to `true`, exactly as
 * `supported` does not exist until `known` has been narrowed to `true` on
 * `ImapIdleSupport` — so `if (verdict.ok)` on an unnarrowed verdict does not
 * compile, rather than compiling and quietly treating "never asked" as
 * "asked and fine".
 */
export type ImapBodyProbeVerdict =
  | { readonly probed: false }
  | { readonly probed: true; readonly ok: true }
  | { readonly probed: true; readonly ok: false; readonly detail: string };

/** The verdict for a connection that never probes. Accurate, not a guess. */
export const NOT_PROBED: ImapBodyProbeVerdict = { probed: false };

/** Build the IDLE case from a capability set, empty meaning "said nothing". */
export function idleSupportFrom(capabilities: readonly string[]): ImapIdleSupport {
  if (capabilities.length === 0) return { known: false };
  return { known: true, supported: capabilities.includes('IDLE') };
}

/** Whether IDLE can be used, and how that was established. */
export interface ImapIdleDecision {
  readonly supported: boolean;
  /**
   * `advertised` — the server named IDLE.
   * `not-advertised` — the server listed its capabilities and IDLE was not one.
   * `server-would-not-say` — it never listed them, even when asked. Polling is
   *   the right fallback, and the reason belongs in the surfaced status so the
   *   owner can see WHY it is polling rather than assume the provider cannot
   *   do better.
   */
  readonly reason: 'advertised' | 'not-advertised' | 'server-would-not-say';
}

/**
 * Resolve IDLE support, asking the server when it volunteered nothing.
 *
 * This is the accessor the watcher goes through. It exists so that "the server
 * said nothing" is answered by a `CAPABILITY` command rather than by a
 * shrug — an unknown resolved into a real answer, or into a named reason for
 * not having one.
 */
export async function resolveIdleSupport(
  client: Pick<ImapClient, 'capabilities'>,
): Promise<ImapIdleDecision> {
  const capabilities = await client.capabilities();
  if (capabilities.length === 0) {
    return { supported: false, reason: 'server-would-not-say' };
  }
  return capabilities.includes('IDLE')
    ? { supported: true, reason: 'advertised' }
    : { supported: false, reason: 'not-advertised' };
}

// ---------------------------------------------------------------------------
// Surfacing a failure to the owner
// ---------------------------------------------------------------------------

/**
 * Why a mailbox capability is unavailable, in a form a supervisor can route.
 *
 * `credential-unavailable` sits alongside the three open failures because it
 * is the same fact from one step earlier: there is nothing to sign in with.
 * It is called out separately because its fix is different from a rejected
 * password — the secret is missing rather than wrong.
 */
export type EmailCapabilityFailureReason =
  | ImapOpenFailureReason
  | 'credential-unavailable';

/**
 * A terminal failure that must reach the owner, not merely a log line.
 *
 * A watcher that stops permanently has to say so somewhere authoritative and
 * name the step that fixes it. Silence is the failure this whole capability
 * exists to end: an inbox that looks quiet while mail piles up in it is
 * indistinguishable, from the outside, from an inbox with no mail in it.
 */
export interface EmailCapabilityFailureNotice {
  readonly reason: EmailCapabilityFailureReason;
  /** True when retrying cannot help; something has to change first. */
  readonly terminal: boolean;
  /** The mailbox this was about, or '' when it was not about one. */
  readonly mailbox: string;
  /** One or two sentences for the owner, naming the step that fixes it. */
  readonly ownerMessage: string;
  /** The server's own words, or the underlying failure text. '' when neither. */
  readonly serverMessage: string;
}

/** The owner-facing sentence for each reason, naming the step that fixes it. */
export function ownerMessageForFailure(
  reason: EmailCapabilityFailureReason,
  mailbox: string,
): string {
  switch (reason) {
    case 'credential-unavailable':
      return 'No mail password is stored where the daemon reads secrets. Nothing '
        + 'will be read until the secret named by email.passwordRef exists at '
        + 'daemon scope. A credential saved by another surface is not visible '
        + 'here and is deliberately not searched for — reading one would work on '
        + 'the machine that saved it and fail everywhere else.';
    case 'authentication-rejected':
      return 'The mail server rejected the sign-in. Nothing will be read until '
        + 'the stored password is replaced: put a working password in the secret '
        + 'named by email.passwordRef, at daemon scope, and reconnect. The '
        + 'rejected credential is not retried, because repeated rejected '
        + 'sign-ins are how an account gets locked.';
    case 'mailbox-unavailable':
      return `Sign-in worked, but the folder '${mailbox}' could not be opened. `
        + 'Nothing will be read from it until email.mailbox names a folder that '
        + 'exists on the server.';
    case 'server-unavailable':
      return 'The mail server refused the connection for now — it reported a '
        + 'limit or a fault of its own, not a problem with the account. The '
        + 'usual cause is too many mailbox connections at once. This is retried '
        + 'automatically on a longer backoff; no change is needed unless it '
        + 'keeps happening.';
    case 'connection-failed':
      return 'Could not reach the mail server. This is retried automatically, so '
        + 'no change is needed unless it keeps happening.';
  }
}

/**
 * Read the routable notice off a failure, whatever threw it.
 *
 * Structural rather than `instanceof`, so a credential failure raised before
 * any socket exists — in a module this one must not import — is routed by the
 * same path as an open failure.
 */
export function describeEmailCapabilityFailure(
  error: unknown,
): EmailCapabilityFailureNotice | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { readonly notice?: unknown }).notice;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const notice = candidate as Partial<EmailCapabilityFailureNotice>;
  if (typeof notice.reason !== 'string' || typeof notice.ownerMessage !== 'string') return null;
  if (typeof notice.terminal !== 'boolean') return null;
  return notice as EmailCapabilityFailureNotice;
}

/**
 * The live wire session of each open client.
 *
 * A module-scoped map rather than a public getter, so `ImapClient`'s method
 * surface stays "the commands this client speaks" and holding a client is not
 * itself a way to put arbitrary bytes on the mailbox connection. Weak, so a
 * client that is dropped without `logout()` does not pin its session here.
 */
const liveConnections = new WeakMap<ImapClient, ImapSession>();

/**
 * The wire connection of an OPEN client, for protocol work that cannot be
 * expressed as "send a command, read its response".
 *
 * IDLE is why this exists: it sends `IDLE`, waits for a `+`, reads untagged
 * responses for up to twenty-seven minutes, sends the bare line `DONE`, and
 * only then collects the completion of the tag it issued at the start.
 *
 * Deliberately a free function, and deliberately not re-exported from
 * `email/index.ts`: it is reachable from the modules that sit beside this one
 * and from nowhere else.
 */
export function imapConnection(client: ImapClient): ImapConnection {
  const session = liveConnections.get(client);
  if (session === undefined) throw new Error(NOT_OPEN_MESSAGE);
  return session;
}

/**
 * Compose a named open failure, keeping the underlying wording.
 *
 * `refusedReason` is what the failing phase means when the SERVER said no. A
 * phase that timed out or lost the socket instead did not get an answer at
 * all, and calling that a rejected credential would mark a transient network
 * stall terminal and stop a watcher from ever retrying it. So the
 * classification is made on what actually happened, not on which phase it
 * happened in.
 */
export function composeOpenFailure(input: {
  readonly refusedReason: ImapOpenFailureReason;
  readonly refusedSummary: string;
  readonly error: unknown;
  readonly mailbox: string;
}): ImapOpenError {
  const serverMessage = input.error instanceof Error
    ? input.error.message
    : String(input.error ?? '');

  // A credential that cannot be put on the wire at all never reached the
  // server, so there is no refusal to read: it is the credential, terminally.
  if (serverMessage.startsWith('Invalid IMAP ')) {
    return new ImapOpenError({
      reason: 'authentication-rejected',
      summary: 'The stored mail credentials cannot be sent to a mail server.',
      serverMessage,
      mailbox: input.mailbox,
    });
  }

  // The server said no. What it said is the authority on what it meant — the
  // phase only supplies the fallback, and only when it is not the terminal
  // guess.
  if (serverMessage.startsWith('IMAP command failed:')) {
    const reason = classifyServerRefusal(serverMessage, input.refusedReason);
    return new ImapOpenError({
      reason,
      summary: reason === input.refusedReason
        ? input.refusedSummary
        : summaryForReason(reason, input.mailbox),
      serverMessage,
      mailbox: input.mailbox,
    });
  }

  // No refusal at all: a timeout, a closed socket, a greeting that never came.
  return new ImapOpenError({
    reason: 'connection-failed',
    summary: input.refusedReason === 'connection-failed'
      ? input.refusedSummary
      : `The connection to the mail server failed before the mailbox `
        + `'${input.mailbox}' was open for reading.`,
    serverMessage,
    mailbox: input.mailbox,
  });
}

/** The one-line summary for a reason the phase did not predict. */
function summaryForReason(reason: ImapOpenFailureReason, mailbox: string): string {
  switch (reason) {
    case 'authentication-rejected':
      return 'The mail server rejected the stored credentials.';
    case 'mailbox-unavailable':
      return `Signed in, but the mailbox '${mailbox}' could not be opened for reading.`;
    case 'server-unavailable':
      return 'The mail server refused the connection for now.';
    case 'connection-failed':
      return 'The mail server did not answer.';
  }
}

/** Record the live session of a client that has just connected. */
export function rememberConnection(client: ImapClient, session: ImapSession): void {
  liveConnections.set(client, session);
}

/** Forget a client's session; it is no longer usable. */
export function forgetConnection(client: ImapClient): void {
  liveConnections.delete(client);
}
