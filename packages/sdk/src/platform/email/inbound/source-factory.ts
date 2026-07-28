/**
 * source-factory.ts — building the source the selection chose.
 *
 * The supervisor decides WHICH source reads the mailbox; this file is the one
 * place that knows how to construct one. Split out for the same reason
 * `connection.ts` is: constructing an IMAP source means resolving a host, an
 * account and a stored secret, and a supervisor that reached for those itself
 * could not be exercised without a machine that has them.
 *
 * The credential is resolved per CONNECTION, not once at construction
 * ─────────────────────────────────────────────────────────────────
 * `MailboxConnectionPort.open()` is called again on every reconnect, and this
 * factory resolves the password inside it. A password rotated while the daemon
 * is running is therefore picked up by the next reconnect rather than at the
 * next restart — and a credential that is missing entirely throws from inside
 * `open()`, on the watcher's own connection path, where `classifyOpenFailure`
 * already turns it into a `credentials-missing` verdict with the step that
 * fixes it. That is why nothing here catches it: a second, quieter report of
 * the same fact would be the one nobody sees.
 *
 * The Gmail arm arrives as an injected builder
 * ────────────────────────────────────────────
 * `GmailMailSource` needs an `HistoryDeltaDeps` I/O slice over an adopted
 * Google credential and a `currentHistoryId()` probe, and neither is derivable
 * here for the same reason an IMAP password is not: they are composition-root
 * facts, and a factory that reached for them itself could not be exercised
 * without a machine that has Google adopted on it. `composeInboundMail` builds
 * the builder — over `GoogleApiClient.historyDeltaPort()` and
 * `currentHistoryId()`, which exist now — and passes it here.
 *
 * `deps.gmail` remains OPTIONAL, and that is a seam rather than a shrug: a test
 * exercising the IMAP arm should not have to supply a Gmail one. What is no
 * longer optional is the daemon composition's Gmail READER, so the shape that
 * used to reach production — every arm complete, nothing injected, `create()`
 * answering `null` on every machine — cannot recur silently.
 *
 * When there is no builder, `create()` returns `null` and the supervisor
 * REPORTS that; it does not fall back to IMAP. The refusal is the point:
 * quietly serving IMAP for a mailbox the owner asked to be read over Gmail is
 * the silent substitution §3.4d forbids, and quietly serving it under an `auto`
 * selection would report a `google-adopted` basis while running the other
 * source.
 */

import { imapMailboxConnectionPort } from './connection.js';
import { ImapMailSource } from './imap-source.js';
import { resolveWatcherSettings, systemWatcherClock } from './ports.js';
import { resolveEmailPassword } from '../email-config.js';
import {
  createSurfaceEmailSecretReader,
  readSurfaceEmailSettings,
  SURFACE_EMAIL_PASSWORD_REF,
  type ConfigReader,
  type SecretReader,
} from '../surface-config.js';
import type { EmailTransportPort } from '../email-service.js';
import type { MailboxCursorStore } from './cursor-store.js';
import type { InboundMailSource } from './source.js';
import type {
  InboundMailObserver,
  InboundMailSink,
  InboundWatcherSettings,
  MailboxConnection,
  MailboxConnectionPort,
  RandomSource,
  WatcherClock,
} from './ports.js';
import type { InboundMailSourceFactory } from './supervisor.js';

/** What the Gmail arm needs from whoever composed a Google credential. */
export type GmailSourceBuilder = (input: {
  readonly account: string;
  readonly mailbox: string;
  readonly sink: InboundMailSink;
  readonly observer: InboundMailObserver;
}) => Promise<InboundMailSource | null>;

export interface InboundMailSourceFactoryDeps {
  /** Reads `surfaces.email.*`. The daemon tier, and only the daemon tier. */
  readonly getConfig: ConfigReader;
  /** Where the mail password is read from. One store — see `resolveEmailPassword`. */
  readonly secrets: SecretReader;
  /** The real sockets. A test passes one whose members throw. */
  readonly transport: Pick<EmailTransportPort, 'connectImapTls'>;
  readonly cursors: MailboxCursorStore;
  /** Already resolved from config into milliseconds by the caller. */
  readonly settings: Omit<InboundWatcherSettings, 'account' | 'mailbox'>;
  readonly clock?: WatcherClock | undefined;
  readonly random?: RandomSource | undefined;
  /**
   * Supplied by `composeInboundMail`, which resolves an adopted Google
   * credential through `createDaemonGmailInboundReader`.
   *
   * Optional so the IMAP arm can be exercised without one. It was optional
   * before too, and nothing filled it — the daemon composition now does, and
   * ITS option is required, which is where the reachability is enforced rather
   * than here.
   */
  readonly gmail?: GmailSourceBuilder | undefined;
}

/**
 * A connection port that resolves host, account and password afresh on every
 * `open()`.
 *
 * Not a `MailboxConnectionPort` built once around captured values: the whole
 * reason the watcher re-opens is that the previous attempt failed, and half
 * the reasons it failed are settings the owner has just changed.
 */
function liveConnectionPort(
  deps: InboundMailSourceFactoryDeps,
  secrets: SecretReader,
  mailbox: string,
): MailboxConnectionPort {
  return {
    async open(): Promise<MailboxConnection> {
      const settings = readSurfaceEmailSettings(deps.getConfig);
      if (settings.imapHost === undefined || settings.username === undefined) {
        throw new Error(
          'No IMAP host or account is configured for the daemon mailbox, so inbound mail has '
          + 'nothing to connect to. Set surfaces.email.imap.host and surfaces.email.user.',
        );
      }
      const host = settings.imapHost;
      const username = settings.username;
      return imapMailboxConnectionPort({
        connect: () => deps.transport.connectImapTls(host, settings.imapPort),
        username,
        password: await resolveEmailPassword(SURFACE_EMAIL_PASSWORD_REF, secrets),
        mailbox,
        timeoutMs: deps.settings.operationTimeoutMs,
      }).open();
    },
  };
}

export function createInboundMailSourceFactory(
  deps: InboundMailSourceFactoryDeps,
): InboundMailSourceFactory {
  const secrets = createSurfaceEmailSecretReader(deps.secrets);
  return {
    async create(input): Promise<InboundMailSource | null> {
      if (input.kind === 'gmail') {
        if (!deps.gmail) return null;
        return deps.gmail({
          account: input.account,
          mailbox: input.mailbox,
          sink: input.sink,
          observer: input.observer,
        });
      }

      // No host and no account is not a source that failed to connect — it is
      // a mailbox nobody configured. Answering `null` puts that in status with
      // the step that fixes it, rather than opening a socket to nothing and
      // reporting the resulting DNS failure as a capability verdict.
      const settings = readSurfaceEmailSettings(deps.getConfig);
      if (settings.imapHost === undefined || settings.username === undefined) return null;

      return new ImapMailSource({
        settings: resolveWatcherSettings({
          ...deps.settings,
          account: input.account,
          mailbox: input.mailbox,
        }),
        connections: liveConnectionPort(deps, secrets, input.mailbox),
        cursors: deps.cursors,
        sink: input.sink,
        clock: deps.clock ?? systemWatcherClock,
        random: deps.random ?? Math.random,
        observer: input.observer,
      });
    },
  };
}
