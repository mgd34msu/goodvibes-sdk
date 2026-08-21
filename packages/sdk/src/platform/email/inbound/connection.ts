/**
 * The real `MailboxConnectionPort`: an `ImapClient` behind the narrow shape
 * the watcher was written against.
 *
 * The watcher deals in `MailboxConnection`, a report, a reader, a wire and a
 * close, because that is everything a listener needs and because a test can
 * build one by hand. This file is the one place that knows those come from an
 * `ImapClient`, `imapConnection()` and `logout()`.
 *
 * It is also where "authenticated" stops standing in for "can read the mail".
 * IMAP publishes no scope list, so before a connection is handed over it reads
 * one existing message and checks what came back against what the server's own
 * BODYSTRUCTURE declared, see `imap-body-probe.ts`. A connection that cannot
 * produce message content raises here instead of becoming a watcher that
 * reports a mailbox as permanently quiet.
 *
 * The socket arrives as a factory rather than a value. One connection is one
 * socket: a reconnect needs a NEW one, because a destroyed socket cannot be
 * re-opened and handing the same instance to a second `ImapClient` would give
 * it a session whose stream had already failed. The factory is also what keeps
 * `node:tls` out of this module's import graph, production passes
 * `createImapTlsSocket()` from the sibling node entry, and a test passes a
 * plain loopback socket.
 */

import type { Socket } from 'node:net';
import { ImapClient, imapConnection } from '../imap-client.js';
import {
  bodyCapabilityFailure,
  type ImapBodyProbe,
} from '../imap-body-probe.js';
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
 * minute ceiling leaks them for as long as the condition lasts, which for a
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
        // The runtime half of the same check the probe makes at connect time:
        // a body that comes back empty for a message the server said has
        // content in it is a withheld body, not an empty message.
        enforceBodyReadable: true,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      let opened;
      try {
        opened = await client.open();
      } catch (error) {
        try {
          socket.destroy();
        } catch {
          // Already gone; the original failure is the one worth raising.
        }
        throw error;
      }

      // Authenticated and EXAMINEd is not the same as being allowed to READ
      // the mail, and IMAP publishes no scope list to consult instead. So the
      // connection is asked to prove it, at connect time, before the watcher
      // opens an expectation nobody can satisfy.
      //
      // The probe belongs HERE rather than inside `ImapClient.open()`:
      // `open()` is the general entry, shared by every ad hoc caller
      // (`EmailService` included), and probing on each of those would spend
      // round trips nobody asked for. Only a long-lived watcher needs the
      // answer up front. Two round trips, once per connection, and both
      // command forms, see `probeMailboxBody` for why neither is droppable.
      let bodyCapability: ImapBodyProbe;
      try {
        bodyCapability = await client.probeBodyReadable();
        if (bodyCapability.outcome === 'unreadable') {
          // This account cannot read message content, either the server
          // accepted the fetch and returned nothing for a message it declared
          // has content, or it refused and named no condition any classifier
          // can place. No amount of reconnecting grants an account access
          // rights, so this is terminal, with its own reason and its own
          // remedy rather than the folder-and-access wording `fetch-refused`
          // carries.
          throw bodyCapabilityFailure({
            mailbox: options.mailbox,
            summary: bodyCapability.detail,
            serverMessage: bodyCapability.evidence.kind === 'refused'
              ? bodyCapability.evidence.serverMessage
              : '',
          });
        }
      } catch (error) {
        await client.logout().catch(() => undefined);
        throw error;
      }

      const report = opened;
      const reader: MailboxReader = {
        capabilities: () => client.capabilities(),
        fetchEnvelopes: (uids) => client.fetchEnvelopes(uids),
        fetchEnvelopeBatch: (uids) => client.fetchEnvelopeBatch(uids),
      };
      return {
        report,
        reader,
        bodyCapability,
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
