/**
 * What the gcloud CLI on this machine can tell us, and what it cannot do.
 *
 * The defect this exists to fix, in the owner's words: "it REFUSED to use the
 * google cli, completely... this could have been solved very easily." He was
 * signed in to gcloud in the same terminal, and the connector walked him
 * through creating a Cloud project anyway. An authenticated CLI sitting right
 * there is a first-class source of truth about who this person is and what
 * their project already has, and ignoring it is how a two-minute job became
 * twenty.
 *
 * ── What gcloud genuinely does for this flow ───────────────────────────────
 *
 *  1. Names the Google account. `gcloud auth list` gives the ACTIVE account,
 *     which is the single most useful fact in the whole flow: it becomes the
 *     `login_hint` on the consent URL so the person lands on the right account
 *     picker entry, and it is what makes an `invalid_grant` diagnosable rather
 *     than a shrug (see grant-diagnosis.ts, the personal-vs-agent-account
 *     trap is the most common cause and it is invisible without this).
 *  2. Finds the project without asking. `gcloud config get-value project`.
 *  3. Enables the Gmail and Calendar APIs with no clicking at all.
 *
 * ── What gcloud cannot do, stated plainly because pretending otherwise is
 *    what wasted the owner's evening ────────────────────────────────────────
 *
 *  - It cannot mint a user refresh token for Gmail or Calendar scopes on its
 *    own. `gcloud auth application-default login --scopes=...` reaches only
 *    Cloud-platform scopes under gcloud's built-in client; Google's own
 *    documentation says that for services outside Google Cloud you must supply
 *    your own client via `--client-id-file`. At that point our loopback flow is
 *    strictly better: it needs no temporary file holding a client secret on
 *    disk. So the consent step stays ours, and the URL gets PRINTED for the
 *    person to click rather than driven in an automated browser.
 *  - It cannot create the OAuth client. `gcloud iam oauth-clients create`
 *    exists but is workforce-identity-federation only; standard Desktop app
 *    clients are console-only, with no API and no CLI equivalent. This is the
 *    single unavoidable second user action in the whole product, and it only
 *    happens on a machine that has no client yet.
 *
 * Verified against Google's live documentation on 2026-08-05, not from memory:
 * https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login
 * https://support.google.com/cloud/answer/15549257
 */

import { checkAuthenticated, detectGcloud } from './gcloud.js';
import type { GoogleCommandPort } from './types.js';

/** Everything the CLI could tell us about this machine. Never a secret. */
export interface GcloudPosture {
  readonly installed: boolean;
  /** The executable that answered, when one did. */
  readonly path: string | null;
  readonly version: string | null;
  /** The ACTIVE gcloud account, which is a Google address. Not a secret. */
  readonly account: string | null;
  /** The configured default project, when one is set. */
  readonly projectId: string | null;
  /** True when gcloud is installed AND has an active account. */
  readonly usable: boolean;
  /** Plain-language posture line, safe for a transcript. */
  readonly detail: string;
}

/** `gcloud config get-value project`, or null when unset. */
async function readActiveProject(port: GoogleCommandPort, gcloudPath: string): Promise<string | null> {
  const result = await port.run(gcloudPath, ['config', 'get-value', 'project']);
  if (result.spawnError || result.timedOut || result.code !== 0) return null;
  const value = result.stdout.trim();
  // gcloud prints the literal string "(unset)" rather than an empty line when
  // no project is configured, and treating that as a project id would send
  // every later call to a project named "(unset)".
  if (value.length === 0 || value === '(unset)') return null;
  return value;
}

/**
 * Ask gcloud what it knows. Never throws: an absent or broken CLI is an
 * ordinary answer here, not an error, because the flow has other routes.
 */
export async function describeGcloudPosture(
  port: GoogleCommandPort,
  homeDirectory: string,
): Promise<GcloudPosture> {
  const detection = await detectGcloud(port, homeDirectory);
  if (!detection.ok) {
    return {
      installed: false,
      path: null,
      version: null,
      account: null,
      projectId: null,
      usable: false,
      detail: 'The gcloud CLI is not installed on this machine.',
    };
  }

  const auth = await checkAuthenticated(port, detection.path);
  if (!auth.ok) {
    return {
      installed: true,
      path: detection.path,
      version: detection.version,
      account: null,
      projectId: await readActiveProject(port, detection.path),
      usable: false,
      detail: 'The gcloud CLI is installed but has no signed-in account, so it cannot say which Google account to use.',
    };
  }

  const projectId = await readActiveProject(port, detection.path);
  return {
    installed: true,
    path: detection.path,
    version: detection.version,
    account: auth.account,
    projectId,
    usable: true,
    detail: projectId === null
      ? `The gcloud CLI is signed in as ${auth.account}, with no default project set.`
      : `The gcloud CLI is signed in as ${auth.account}, using project ${projectId}.`,
  };
}

/**
 * The honest list of what gcloud will not do here.
 *
 * Shown whenever the flow uses gcloud, so nobody is left wondering why a
 * signed-in CLI still needed them to click something.
 */
export function gcloudCannotDo(): readonly string[] {
  return [
    'gcloud cannot mint a Gmail or Calendar token by itself, those scopes sit outside Google Cloud, so consent has to be granted against this product\'s own OAuth client. That is the link you click.',
    'gcloud cannot create the OAuth client either; Google offers no API or CLI for a Desktop app client, only the Cloud console.',
  ];
}
