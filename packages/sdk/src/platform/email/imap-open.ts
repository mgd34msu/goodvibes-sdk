/**
 * Opening a connection: what it turned out to be able to do, and the three
 * distinct ways it can fail to become readable.
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
 * Why a connection could not be opened, as three distinct facts.
 *
 * They are distinct because they call for three different responses, and a
 * caller that cannot tell them apart necessarily gets two of the three wrong:
 *
 *   - `authentication-rejected` — the credential was refused, or could not be
 *     put on the wire at all. TERMINAL. Retrying a rejected password on a
 *     backoff loop is how an account gets locked; the operator has to change
 *     something before this can succeed.
 *   - `mailbox-unavailable` — the credential worked and the named mailbox did
 *     not open. TERMINAL for the same reason: reconnecting does not create a
 *     folder. Authenticated is not readable, and this is the case that says so.
 *   - `connection-failed` — the socket, the greeting or the timing. Transient,
 *     and the only one of the three worth retrying.
 */
export type ImapOpenFailureReason =
  | 'authentication-rejected'
  | 'mailbox-unavailable'
  | 'connection-failed';

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
  /** False only for `connection-failed`: nothing else is worth retrying. */
  readonly terminal: boolean;

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
    this.terminal = input.reason !== 'connection-failed';
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
   * Whether `IDLE` (RFC 2177) was advertised. `null` means the server said
   * nothing about its capabilities, which is not the same as "no". A watcher
   * choosing between push and polling must resolve a `null` by calling
   * `capabilities()`, never by treating it as false.
   */
  readonly supportsIdle: boolean | null;
  /** The mailbox that was EXAMINEd, and what the server said about it. */
  readonly mailbox: ImapMailboxStatus & { readonly name: string };
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
  const refused = serverMessage.startsWith('IMAP command failed:')
    || serverMessage.startsWith('Invalid IMAP ');
  return new ImapOpenError({
    reason: refused ? input.refusedReason : 'connection-failed',
    summary: refused || input.refusedReason === 'connection-failed'
      ? input.refusedSummary
      : `The connection to the mail server failed before the mailbox `
        + `'${input.mailbox}' was open for reading.`,
    serverMessage,
    mailbox: input.mailbox,
  });
}

/** Record the live session of a client that has just connected. */
export function rememberConnection(client: ImapClient, session: ImapSession): void {
  liveConnections.set(client, session);
}

/** Forget a client's session; it is no longer usable. */
export function forgetConnection(client: ImapClient): void {
  liveConnections.delete(client);
}
