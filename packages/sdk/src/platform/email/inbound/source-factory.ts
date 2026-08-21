/**
 * source-factory.ts, building the source the selection chose.
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
 * next restart, and a credential that is missing entirely throws from inside
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
 * the builder, over `GoogleApiClient.historyDeltaPort()` and
 * `currentHistoryId()`, which exist now, and passes it here.
 *
 * `deps.gmail` remains OPTIONAL, and that is a seam rather than a shrug: a test
 * exercising the IMAP arm should not have to supply a Gmail one. What is no
 * longer optional is the daemon composition's Gmail READER, so the shape that
 * used to reach production, every arm complete, nothing injected, `create()`
 * answering `null` on every machine, cannot recur silently.
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
import {
  INBOUND_CAPABILITY_POLICY_DEFAULT,
  type InboundCapabilityPolicy,
} from './capability-policy.js';
import { resolveWatcherSettings, systemWatcherClock } from './ports.js';
import { imapSocketFactoryFor, resolveEmailPassword } from '../email-config.js';
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

/**
 * The Gmail poll cadence, resolved from config into milliseconds.
 *
 * A named type rather than two loose numbers because they travel together
 * through three hops and are trivially swappable at every one of them, the
 * fast one is five seconds and the slow one is sixty, and nothing about
 * `(number, number)` would stop a caller getting them the wrong way round.
 */
export interface GmailPollIntervals {
  /** `surfaces.email.inbound.gmailPollSecondsExpecting`, in milliseconds. */
  readonly pollExpectingMs: number;
  /** `surfaces.email.inbound.gmailPollSecondsIdle`, in milliseconds. */
  readonly pollIdleMs: number;
}

/**
 * What the Gmail arm needs from whoever composed a Google credential.
 *
 * The two poll intervals are handed IN rather than left to the builder, and
 * that is the fix rather than a nicety. `GmailMailSourceDeps` documents
 * `pollExpectingMs` and `pollIdleMs` as coming from
 * `surfaces.email.inbound.gmailPollSecondsExpecting` and `…gmailPollSecondsIdle`,
 * and nothing anywhere mapped those keys onto those fields: both settings had a
 * schema row, a validated range, and a description the owner reads in the
 * settings UI, and not one reader. Leaving the builder to pick its own numbers
 * would have made that permanent, because the composition that can see the
 * config is not the one that knows how to talk to Google, so the numbers have
 * to cross that boundary explicitly or they never cross it at all.
 *
 * Resolved once, where config lives, and arriving here already in
 * milliseconds. A builder that invented its own would be answering a question
 * the owner has already answered.
 */
export type GmailSourceBuilder = (input: GmailPollIntervals & {
  readonly account: string;
  readonly mailbox: string;
  readonly sink: InboundMailSink;
  readonly observer: InboundMailObserver;
  /**
   * `surfaces.email.inbound.capabilityRecheckMinutes`, in milliseconds.
   *
   * Included because `GmailMailSourceDeps.capabilityRecheckMs` defaults to the
   * watcher's constant when omitted, and a Gmail source silently re-probing on
   * a different schedule from the one the owner configured is the same class of
   * defect as the two above, a setting that appears to apply and does not.
   */
  readonly capabilityRecheckMs: number;
  /**
   * `surfaces.email.inbound.onInsufficientCapability`.
   *
   * Handed in for the same reason the two intervals are: the composition that
   * can see the config is not the one that knows how to talk to Google, so the
   * value crosses that boundary explicitly or it never crosses it at all. This
   * is the key the schema has described since it was added and nothing read,
   * `notice-only` and `refuse-and-notify` were the same behaviour until this
   * argument existed.
   */
  readonly capabilityPolicy: InboundCapabilityPolicy;
}) => Promise<InboundMailSource | null>;

export interface InboundMailSourceFactoryDeps {
  /** Reads `surfaces.email.*`. The daemon tier, and only the daemon tier. */
  readonly getConfig: ConfigReader;
  /** Where the mail password is read from. One store, see `resolveEmailPassword`. */
  readonly secrets: SecretReader;
  /**
   * The real sockets. A test passes one whose members throw.
   *
   * `connectImapPlain` rides along because `surfaces.email.imap.secure` governs
   * the inbound connection exactly as it governs the mailbox service's: one key,
   * both IMAP paths, or it is honoured on one and quietly ignored on the other.
   * It is optional on the port itself, so a transport that predates it still
   * satisfies this.
   */
  readonly transport: Pick<EmailTransportPort, 'connectImapTls' | 'connectImapPlain'>;
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
   * before too, and nothing filled it, the daemon composition now does, and
   * ITS option is required, which is where the reachability is enforced rather
   * than here.
   */
  readonly gmail?: GmailSourceBuilder | undefined;
}

/** The shipped defaults, so an unset key produces the number the schema promises. */
const GMAIL_POLL_EXPECTING_DEFAULT_SECONDS = 5;
const GMAIL_POLL_IDLE_DEFAULT_SECONDS = 60;

/**
 * The Gmail cadence, read from the owner's settings.
 *
 * Read HERE rather than plumbed in from the composition root, because this is
 * already the module that reads `surfaces.email.*` to build a source, it takes
 * a `ConfigReader` for exactly that, and a second hop through the caller would
 * be two places that have to agree about two numbers.
 *
 * The schema's 2-60 s and 10-3600 s ranges are NOT restated. `ConfigManager`
 * refuses a value outside them at `set()`, and `GmailMailSource` floors what it
 * is handed; a third check here would be a third bound that can drift from the
 * other two. What this does is the one thing neither of those can: reject a
 * value that is not a usable number at all, which is what a hand-edited config
 * file can produce, and fall back to the shipped default rather than passing
 * `NaN` into an interval.
 *
 * The key literals sit INSIDE the `getConfig(...)` calls rather than being
 * passed to a local helper that reads them, and that is deliberate.
 * `test/inbound-email-config-schema.test.ts` decides whether a key is read by
 * looking for the key's own text inside a config-read call, a doc comment
 * naming it does not count, which is the distinction that caught these two in
 * the first place. A helper taking the key as an argument would be a genuine
 * read that the repository's own gate could not see, which is a worse place to
 * be than an unread key: it would look wired to a reader and unwired to the
 * check, and the next person to touch it would trust the wrong one.
 */
function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * `surfaces.email.inbound.onInsufficientCapability`, read at source-create time.
 *
 * Read HERE, beside the two poll intervals, for the reason stated above them:
 * this is already the module that reads `surfaces.email.*` to build a source,
 * and `create()` runs on every supervisor start, so an owner who changes this
 * while the daemon is running gets the new behaviour at the next source start
 * rather than at the next restart.
 *
 * The key literal sits INSIDE the `getConfig(...)` call, deliberately, for the
 * reason `readGmailPollIntervals` states: the repository's own gate in
 * `test/inbound-email-config-schema.test.ts` decides whether a key is read by
 * looking for the key's own text inside a config-read call, and a helper taking
 * the key as an argument would be a genuine read the gate could not see.
 *
 * An unrecognised value falls back to the shipped default rather than being
 * passed on. `ConfigManager.set()` refuses anything outside the enum, so the
 * only way to get here with something else is a hand-edited config file, and
 * the safe direction for an unreadable value is the policy that stops rather
 * than the one that announces mail it can never act on.
 */
function readCapabilityPolicy(getConfig: ConfigReader): InboundCapabilityPolicy {
  const configured = getConfig('surfaces.email.inbound.onInsufficientCapability' as never);
  return configured === 'notice-only' || configured === 'refuse-and-notify'
    ? configured
    : INBOUND_CAPABILITY_POLICY_DEFAULT;
}

function readGmailPollIntervals(getConfig: ConfigReader): GmailPollIntervals {
  return {
    pollExpectingMs: positiveSeconds(
      getConfig('surfaces.email.inbound.gmailPollSecondsExpecting' as never),
      GMAIL_POLL_EXPECTING_DEFAULT_SECONDS,
    ) * 1_000,
    pollIdleMs: positiveSeconds(
      getConfig('surfaces.email.inbound.gmailPollSecondsIdle' as never),
      GMAIL_POLL_IDLE_DEFAULT_SECONDS,
    ) * 1_000,
  };
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
        connect: () => imapSocketFactoryFor(
          deps.transport,
          settings.imapSecure ? 'tls' : 'plaintext',
        )(host, settings.imapPort),
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
          // The owner's own numbers, not the builder's. Read at CREATE time
          // rather than at factory construction so an interval edited while the
          // daemon runs is picked up by the next source start, which is the
          // same freshness rule `liveConnectionPort` applies to the IMAP host.
          ...readGmailPollIntervals(deps.getConfig),
          // Already resolved from `surfaces.email.inbound.capabilityRecheckMinutes`
          // by whoever built `settings`; passed on rather than re-read, so both
          // sources re-probe on the one schedule the owner set.
          capabilityRecheckMs: deps.settings.capabilityRecheckMs,
          // Read at CREATE time for the same freshness reason as the intervals
          // above: an owner who switches this while the daemon is running gets
          // the new behaviour at the next source start.
          capabilityPolicy: readCapabilityPolicy(deps.getConfig),
        });
      }

      // No host and no account is not a source that failed to connect, it is
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
