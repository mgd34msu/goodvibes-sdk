/**
 * Deciding how to connect Google, before doing anything about it.
 *
 * The defect this exists to fix: a machine that already held a working OAuth
 * client id and client secret was walked through the new-project Branding
 * workflow anyway, because the only OAuth path began at "install gcloud" and
 * marched through project creation, API enablement, consent-screen branding
 * and audience publishing before it ever reached the one step that was
 * actually outstanding. Twenty minutes of a person's evening went into
 * re-deciding facts the machine already knew.
 *
 * So nothing runs until this module has looked at what is already true. The
 * succession is fixed and it is short:
 *
 *   (a) A complete credential in the encrypted store — client, secret and
 *       refresh token. Use it. Refresh it. Zero user actions.
 *   (b) A client id and secret in the store with no refresh token. The only
 *       thing missing is a person's consent, so go STRAIGHT to a consent URL.
 *       Never to a project, a branding page or an audience setting — those
 *       already exist or the client could not.
 *   (c) An authenticated gcloud CLI. It names the Google account, finds the
 *       project and enables the APIs with no clicking (see gcloud-posture.ts).
 *   (d) Only then the guided path that creates a client from nothing.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * There is no filesystem scan. An earlier design probed `~/.gmail-mcp` on
 * every status call and offered to adopt whatever it found, and that is not
 * how this should behave: ordinary people do not have that directory, a
 * connector that goes looking through home directories for credential files
 * is doing something nobody asked it to, and an unprompted "I found some
 * credentials, shall I use them?" is a question rather than a connection.
 *
 * Credentials on disk are still fully supported — they are just USER-DIRECTED
 * rather than discovered. When someone names a path, adoption runs exactly as
 * it always did and says what it took up and where it now lives. That route
 * lives in setup-actions.ts, reached from an explicit command, and it is
 * never entered from here.
 */

import { describeGcloudPosture, type GcloudPosture } from './gcloud-posture.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import { safeConfigString } from './config-access.js';
import type { GoogleCommandPort, GoogleConfigPort, GoogleSecretPort, GoogleSetupPath } from './types.js';

/** Which route the flow should take. Ordered exactly as the succession above. */
export type GoogleConnectionRoute =
  /** (a) A complete credential is stored. Nothing to ask anyone. */
  | 'stored-credential'
  /** (b) A client exists; only consent is missing. Straight to the URL. */
  | 'stored-client-consent'
  /** (c) gcloud is signed in and can carry the project and API work. */
  | 'gcloud-assisted'
  /** (d) Nothing exists yet; the client has to be created in the console. */
  | 'guided-new-client';

export interface GoogleConnectionPlan {
  readonly route: GoogleConnectionRoute;
  /**
   * How many things the person has to do, counted honestly.
   *
   * The bar for this product is at most ONE — click a consent link and
   * approve. Any route that reports more carries its reason in `whyExtraSteps`
   * and that reason has to be a fact about Google, not a convenience for us.
   */
  readonly userActionsRequired: number;
  /** Present only when `userActionsRequired` exceeds one. */
  readonly whyExtraSteps: string | null;
  /** The setup path to run, when a flow run is what comes next. */
  readonly setupPath: GoogleSetupPath | null;
  /**
   * The Google account this connection is meant to be for, when anything
   * knows it. Becomes the consent screen's `login_hint`, which is what keeps
   * a person from approving as their personal account by reflex.
   */
  readonly intendedAccount: string | null;
  /** What gcloud said, when it was consulted. Null on routes (a) and (b). */
  readonly gcloud: GcloudPosture | null;
  /** Plain-language statement of what was found and what happens next. */
  readonly detail: string;
}

export interface GoogleDiscoverySources {
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  /** Consulted only when the store has nothing usable. */
  readonly commands: GoogleCommandPort;
  readonly homeDirectory: string;
}

/** True when a secret exists and is non-empty. Never returns the value. */
async function secretPresent(secrets: GoogleSecretPort, key: string): Promise<boolean> {
  try {
    const value = await secrets.get(key);
    return typeof value === 'string' && value.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Work out how to connect, without changing anything.
 *
 * Pure inspection: this reads config and probes for the presence of secrets,
 * and it runs gcloud only when the store cannot answer. It never writes, never
 * opens a browser and never asks anyone anything.
 */
export async function planGoogleConnection(
  sources: GoogleDiscoverySources,
): Promise<GoogleConnectionPlan> {
  const clientId = safeConfigString(sources.config, GOOGLE_CONFIG_KEYS.oauthClientId);
  const intendedAccount = safeConfigString(sources.config, GOOGLE_CONFIG_KEYS.emailUsername);

  const [hasClientSecret, hasRefreshToken] = await Promise.all([
    secretPresent(sources.secrets, GOOGLE_SECRET_KEYS.oauthClientSecret),
    secretPresent(sources.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken),
  ]);

  // (a) Everything is already here.
  if (clientId !== null && hasClientSecret && hasRefreshToken) {
    return {
      route: 'stored-credential',
      userActionsRequired: 0,
      whyExtraSteps: null,
      setupPath: null,
      intendedAccount,
      gcloud: null,
      detail: 'A complete Google credential is already in the encrypted store. Refreshing it and proving it works — nothing for you to do.',
    };
  }

  // (b) The client exists; only a person's consent is missing. This is the
  // case that used to trigger the whole new-project walkthrough.
  if (clientId !== null && hasClientSecret) {
    return {
      route: 'stored-client-consent',
      userActionsRequired: 1,
      whyExtraSteps: null,
      setupPath: 'existing-client',
      intendedAccount,
      gcloud: null,
      detail: 'An OAuth client is already configured, so the only thing missing is your consent. Opening a consent link — approve it and this is done.',
    };
  }

  // (c) No client, but the CLI may already know who this person is and which
  // project to use, which removes every question except the consent itself.
  const gcloud = await describeGcloudPosture(sources.commands, sources.homeDirectory);
  if (gcloud.usable) {
    return {
      route: 'gcloud-assisted',
      userActionsRequired: 2,
      whyExtraSteps:
        'Google offers no API and no gcloud command for creating a Desktop app OAuth client — only the Cloud console does it — so the client has to be created there once. '
        + 'gcloud covers everything else: the account, the project and enabling the APIs.',
      setupPath: 'oauth',
      intendedAccount: intendedAccount ?? gcloud.account,
      gcloud,
      detail: `${gcloud.detail} Using it for the project and the APIs; the OAuth client is created in the console once, then you approve one consent link.`,
    };
  }

  // (d) Nothing to work from.
  return {
    route: 'guided-new-client',
    userActionsRequired: 2,
    whyExtraSteps:
      'Google offers no API and no gcloud command for creating a Desktop app OAuth client, so it is created in the Cloud console once. After that, one consent link.',
    setupPath: 'oauth',
    intendedAccount,
    gcloud,
    detail: gcloud.installed
      ? `${gcloud.detail} Walking through creating an OAuth client, then one consent link.`
      : 'No Google credential is stored and the gcloud CLI is not available. Walking through creating an OAuth client, then one consent link.',
  };
}

/**
 * The plan as lines for a transcript or a status panel.
 *
 * Leads with what happens next rather than with an inventory, because the
 * question a person asked was "connect google", not "audit my machine".
 */
export function describeGoogleConnectionPlan(plan: GoogleConnectionPlan): readonly string[] {
  const lines: string[] = [plan.detail];

  if (plan.intendedAccount !== null) {
    lines.push(`Connecting as ${plan.intendedAccount}. Pick that account on the consent screen, not a personal one.`);
  }

  lines.push(
    plan.userActionsRequired === 0
      ? 'Steps for you: none.'
      : plan.userActionsRequired === 1
        ? 'Steps for you: one — approve the consent link.'
        : `Steps for you: ${plan.userActionsRequired}.`,
  );

  if (plan.whyExtraSteps !== null) {
    lines.push(plan.whyExtraSteps);
  }

  return lines;
}
