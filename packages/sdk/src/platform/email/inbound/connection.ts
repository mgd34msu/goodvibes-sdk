/**
 * The real `MailboxConnectionPort`: an `ImapClient` behind the narrow shape
 * the watcher was written against.
 *
 * The watcher deals in `MailboxConnection` — a report, a reader, a wire and a
 * close — because that is everything a listener needs and because a test can
 * build one by hand. This file is the one place that knows those come from an
 * `ImapClient`, `imapConnection()` and `logout()`.
 *
 * The socket arrives as a factory rather than a value. One connection is one
 * socket: a reconnect needs a NEW one, because a destroyed socket cannot be
 * re-opened and handing the same instance to a second `ImapClient` would give
 * it a session whose stream had already failed. The factory is also what keeps
 * `node:tls` out of this module's import graph — production passes
 * `createImapTlsSocket()` from the sibling node entry, and a test passes a
 * plain loopback socket.
 */

import type { Socket } from 'node:net';
import { ImapClient, imapConnection } from '../imap-client.js';
import type {
  MailboxConnection,
  MailboxConnectionPort,
  MailboxReader,
} from './ports.js';

export interface ImapMailboxConnectionOptions {
  /** Opens ONE socket. Called once per connection attempt. */
  readonly connect: () => Promise<Socket>;
  readonly username: string;
  /** An app password, or `Bearer <token>` for XOAUTH2. Never logged. */
  readonly password: string;
  /** The EXAMINE target. Read-only; nothing is ever marked `\Seen`. */
  readonly mailbox: string;
  /** Per-command deadline. Not the IDLE wait, which has none by design. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Open authenticated, EXAMINEd connections to one mailbox on demand.
 *
 * A failed `open()` destroys the socket it was given before the failure
 * propagates. Without that, every reconnect attempt against a server that
 * refuses at LOGIN leaks a live socket, and a watcher retrying on a five
 * minute ceiling leaks them for as long as the condition lasts — which for a
 * refused credential is "until somebody notices".
 */
export function imapMailboxConnectionPort(
  options: ImapMailboxConnectionOptions,
): MailboxConnectionPort {
  return {
    async open(): Promise<MailboxConnection> {
      const socket = await options.connect();
      const client = new ImapClient({
        socket,
        username: options.username,
        password: options.password,
        mailbox: options.mailbox,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      let report;
      try {
        const opened = await client.open();
        // The connect-time body probe belongs HERE, not inside `open()`
        // itself: `open()` is the general ImapClient entry, shared by every
        // ad hoc caller (`EmailService` included), and probing on every one
        // of those would spend a round trip nobody asked for. Only a
        // long-lived watcher needs the answer before it opens an expectation
        // nobody can satisfy, so only this wiring — the watcher's own
        // connection port — calls it, and folds the result into the report
        // the watcher actually reads.
        report = { ...opened, bodyProbe: await client.probeBodyAccess() };
      } catch (error) {
        try {
          socket.destroy();
        } catch {
          // Already gone; the original failure is the one worth raising.
        }
        throw error;
      }
      const reader: MailboxReader = {
        capabilities: () => client.capabilities(),
        fetchEnvelopes: (uids) => client.fetchEnvelopes(uids),
        fetchEnvelopeBatch: (uids) => client.fetchEnvelopeBatch(uids),
      };
      return {
        report,
        reader,
        wire: imapConnection(client),
        close: async () => {
          try {
            await client.logout();
          } catch {
            // Closing is best-effort: the caller is already moving on, and a
            // LOGOUT that fails on a socket we are discarding is not news.
          }
        },
      };
    },
  };
}
