/**
 * Taking up Google credentials that already exist as files on this machine.
 *
 * Split out of `setup-actions.ts` because it is not a step in any flow — no
 * runner calls it and it appears in no path. It is a route a PERSON asks for,
 * by naming a path or running the adopt command, and it is reached directly
 * from a command surface and from `connection-repair.ts`.
 *
 * Nothing scans for these files on its own. An earlier design probed
 * `~/.gmail-mcp` on every status call and offered to adopt whatever turned up;
 * ordinary people have no such directory, and a connector that goes looking
 * through home directories for another tool's credentials is doing something
 * nobody asked it to. So this runs when asked and not otherwise.
 *
 * The files are READ and never written. They belong to a tool that may still be
 * running against them, and rotating or rewriting them would break it.
 */

import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';
import { adoptGmailMcpCredentials, type GoogleFilePort } from './credential-adoption.js';

/**
 * Credentials that already exist on this machine.
 *
 * A gmail-mcp install holds a complete OAuth client and a refresh token, and
 * the owner's incident was the agent denying it could send mail while exactly
 * that sat on disk. Adoption reads those files, never writes them, and never
 * returns a value to a caller that would display it.
 */
export interface GoogleAdoptionOutcome {
  readonly adopted: boolean;
  /** Safe to display: provenance and scopes only, never a token. */
  readonly detail: string;
  readonly scopes: readonly string[];
  readonly location: string | null;
  /**
   * Set when adoption stopped because it would have REPLACED a credential
   * already in the store. Carries the sentence to put in front of the owner;
   * passing `confirmReplace: true` on a second call proceeds.
   */
  readonly needsConfirmation?: true;
  readonly prompt?: string;
}

/**
 * Take up credentials from a file layout on this machine.
 *
 * Only ever reached because someone asked for it — by naming a path or by
 * running the adopt command. Nothing calls this from a discovery or status
 * path; see discovery.ts for why there is no scan.
 *
 * The files are READ and left untouched: they belong to another tool that may
 * still be running against them, and rotating or rewriting them would break
 * it.
 */
export async function adoptExistingGoogleCredentials(deps: {
  readonly files: GoogleFilePort;
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  readonly homeDirectory: string;
  /**
   * The owner's explicit yes to REPLACING a credential that is already stored.
   * Absent by default, so an adoption can never quietly destroy a working
   * refresh token — which is the same protection credential-removal.ts gives
   * deletion, applied to the other way of losing a credential.
   */
  readonly confirmReplace?: boolean;
}): Promise<GoogleAdoptionOutcome> {
  const credentials = adoptGmailMcpCredentials(deps.files, deps.homeDirectory);
  if (credentials === null) {
    return {
      adopted: false,
      detail: `No adoptable Google credentials were found under ${deps.homeDirectory}/.gmail-mcp.`,
      scopes: [],
      location: null,
    };
  }

  // Overwriting a refresh token destroys it exactly as thoroughly as deleting
  // one, and the person went through a consent screen to get it. So a
  // replacement is confirmed, not assumed.
  const existing = await deps.secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken);
  const wouldReplace =
    typeof existing === 'string' && existing.trim().length > 0 && existing.trim() !== credentials.refreshToken;
  if (wouldReplace && deps.confirmReplace !== true) {
    return {
      adopted: false,
      needsConfirmation: true,
      detail: `Found Google credentials at ${credentials.location}, but a different refresh token is already stored.`,
      prompt:
        `Taking these up would replace the Google refresh token already in the encrypted store, and the replaced one cannot be recovered. `
        + 'Do you want me to replace it?',
      scopes: credentials.scopes,
      location: credentials.location,
    };
  }

  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientId, credentials.clientId);
  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, GOOGLE_CONFIG_KEYS.oauthClientSecretRef);
  await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, credentials.clientSecret);
  await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, credentials.refreshToken);

  return {
    adopted: true,
    detail:
      `Adopted the Google credentials at ${credentials.location} into the encrypted secret store`
      + `${wouldReplace ? ', replacing the token that was there' : ''}. `
      + 'The original files were read and left untouched.',
    scopes: credentials.scopes,
    location: credentials.location,
  };
}
