/**
 * What the Google setup runners need, and how the OAuth client is obtained.
 *
 * Its own module so both `setup-actions.ts` (the binder and the consent
 * exchange) and `setup-actions-cloud-project.ts` (gcloud and the console
 * pages) can take these without importing each other. A shared contract in one
 * of the two implementation files is how a circular import gets built.
 *
 * Everything here is a PORT. Not a line of the connector opens a file, binds a
 * socket, spawns a process or drives a browser on its own, which is what keeps
 * the whole flow runnable against fakes with no machine and no Google account.
 */

import type {
  GoogleBrowserPort,
  GoogleCommandPort,
  GoogleConfigPort,
  GoogleSecretPort,
} from './types.js';
import type { GoogleFilePort } from './credential-adoption.js';
import type { DownloadScanPort } from './client-download.js';
import type { GoogleFetchPort, GoogleLoopbackListenerFactory } from './oauth-loopback.js';

/** How the OAuth client credentials should be obtained, when they are not already stored. */
export type GoogleClientIntakeChoice =
  /** Drive the Cloud console in a browser and read the client back out of the dialog. */
  | { readonly kind: 'console-walkthrough' }
  /** Read a client JSON the user already downloaded. */
  | { readonly kind: 'client-json-file'; readonly path: string }
  /** Use a client id and secret the user pasted. */
  | { readonly kind: 'manual-entry'; readonly clientId: string; readonly clientSecret: string }
  /** Look in a downloads directory for the JSON the console just saved. */
  | { readonly kind: 'downloaded-file'; readonly directory: string; readonly since?: number };

/** Everything the runners need, all of it injected. */
export interface GoogleSetupActionDeps {
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  /**
   * Opens a browser port. Called only by steps that genuinely need one, so
   * building the runner map never launches a browser.
   */
  readonly browser: () => Promise<GoogleBrowserPort>;
  readonly commands: GoogleCommandPort;
  readonly fetchPort: GoogleFetchPort;
  readonly files: GoogleFilePort;
  /**
   * Opens the local HTTP listener Google redirects back to after consent.
   *
   * Injected because binding a port is real machine I/O: the whole consent
   * exchange — authorization URL, PKCE, state check, code-for-token — runs
   * against a fake listener with no socket. The shipped bun/node
   * implementation is `startLoopbackListener` in the `google/node` entry.
   */
  readonly loopback: GoogleLoopbackListenerFactory;
  readonly homeDirectory: string;
  /** How to obtain OAuth client credentials. Defaults to the console walkthrough. */
  readonly clientIntake?: GoogleClientIntakeChoice;
  /** Directory scanning, needed only by the `downloaded-file` intake route. */
  readonly downloadScan?: DownloadScanPort;
  /** Opens a URL for the human to complete consent in. */
  readonly openUrl?: (url: string) => Promise<void>;
  /**
   * Shows the consent URL to the person so they can click it themselves.
   *
   * Preferred over `openUrl` and over browser driving, and the reason is not
   * stylistic: Google blocks automated browsers at its sign-in wall ("this
   * browser or app may not be secure"), so driving the consent screen is the
   * route most likely to dead-end. Printing a link is one action for the
   * person — the only action the whole flow asks of them — and it always
   * works.
   */
  readonly announceConsentUrl?: (url: string) => void;
  /**
   * The Google address this consent should be granted by, used as the consent
   * screen's `login_hint`. Normally the configured mail account, falling back
   * to whatever gcloud is signed in as.
   */
  readonly loginHint?: string;
  /**
   * Proves the credential by reading mail and calendar with it. Injected so
   * `oauth-verify` can make real calls without this module owning a client.
   */
  readonly proveConnection?: () => Promise<{
    readonly ok: boolean;
    readonly detail: string;
    readonly problem?: string;
    readonly fix?: string;
  }>;
  /** Real IMAP/SMTP connectivity check, so `gmail-verify` proves rather than assumes. */
  readonly verifyMail?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Real calendar feed read, so `calendar-verify` proves rather than assumes. */
  readonly verifyCalendar?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly now?: () => number;
}
