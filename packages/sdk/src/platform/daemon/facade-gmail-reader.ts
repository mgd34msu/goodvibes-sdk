/**
 * facade-gmail-reader.ts — where the daemon's Google credential meets inbound
 * mail.
 *
 * The counterpart of `control-plane/routes/calendar-composition.ts`, and
 * assembled the same way and in the same tier for the same reason: the daemon
 * reads the connection from the DAEMON config and secret stores and from
 * nowhere else, so a Google setup performed in any surface — the agent, the
 * TUI, the web UI — is readable here the moment it lands and stays readable
 * after that surface has exited. The runtime that has to notice a verification
 * email at 3am is not the one the owner did the setup in.
 *
 * Why this is a separate file from `facade-inbound-mail.ts`
 * ────────────────────────────────────────────────────────
 * That file owns the inbound graph — three persisted stores, the expectation
 * book, the supervisor — and knows nothing about OAuth. This file owns exactly
 * one question: does this machine have a Google credential that can read the
 * mailbox, and if not, why not. Keeping them apart is what lets the inbound
 * composition be exercised with a reader that reports `unavailable` without a
 * credential store anywhere near the test.
 *
 * The provider is a FUNCTION, not a resolved reader
 * ─────────────────────────────────────────────────
 * It is called once per supervisor start rather than once at boot, so a
 * credential the owner adopts while the daemon is running is picked up on the
 * next start instead of at the next restart — the same property
 * `InboundMailSupervisorDeps.selectionFacts` already states for the two facts
 * it asks for.
 */

import {
  resolveGmailInboundReader,
  type GmailInboundReaderProvider,
  type GmailInboundReaderSources,
} from '../google/gmail-inbound-reader.js';
import { nodeGoogleFilePort } from '../google/node.js';

/** The slice of the daemon runtime this composition needs. Nothing wider. */
export interface DaemonGmailInboundReaderDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: { get(key: string): Promise<string | null> };
  /**
   * The daemon's own home. Absent in narrow compositions, and the adoption
   * probe cannot run without one — `~/.gmail-mcp` is a path, not a guess.
   */
  readonly homeDirectory?: string | undefined;
  /** Test seam: overrides the injected fetch, so no socket is opened. */
  readonly fetch?: GmailInboundReaderSources['fetch'] | undefined;
}

const NO_HOME: GmailInboundReaderProvider = async () => ({
  kind: 'unavailable',
  detail: 'This daemon composition was built without a home directory, so the Google credentials '
    + 'on this machine cannot be located and inbound mail cannot be read over Gmail.',
  fix: 'Start the daemon through its normal entry point, which supplies a home directory, or '
    + 'configure surfaces.email.imap.host and surfaces.email.user to read over IMAP.',
});

/**
 * The provider `composeInboundMail` takes.
 *
 * Always returns a function — never `undefined`. An optional Gmail arm is
 * exactly what let the whole path ship inert: `deps.gmail` was optional,
 * nothing filled it, and the absence looked identical to a machine with no
 * Google account. A provider that reports `unavailable` with a reason is the
 * same information without the silence.
 */
export function createDaemonGmailInboundReader(
  deps: DaemonGmailInboundReaderDeps,
): GmailInboundReaderProvider {
  const home = deps.homeDirectory;
  if (home === undefined) return NO_HOME;
  const fetchPort = deps.fetch ?? { fetch: (url: string, init: RequestInit) => fetch(url, init) };
  return async () => resolveGmailInboundReader({
    sources: {
      files: nodeGoogleFilePort,
      homeDirectory: home,
      // `get` throws on a config section that does not exist yet — the Google
      // section is app-layer and absent on a machine where nobody has run
      // setup. The connector reads every config value through its own guard
      // (platform/google/config-access.ts), so an absent section reads as "not
      // configured" rather than throwing out of the supervisor's start path.
      configGet: (key) => deps.configManager.get(key as never),
      secretGet: (key) => deps.secretsManager.get(key),
    },
    fetch: fetchPort,
  });
}
