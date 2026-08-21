/**
 * What is already set up.
 *
 * Idempotency here is deliberately not a journal of "steps I previously ran".
 * A journal lies as soon as anything changes outside the flow, a revoked app
 * password, a deleted OAuth client, a project someone removed. Instead every
 * check probes the actual state: is the secret present, is the config written,
 * does the credential still work. Re-running after a partial failure therefore
 * resumes from what is genuinely true rather than from what was once recorded.
 *
 * The one thing that cannot be probed locally is the OAuth publishing status,
 * which lives only in the Cloud Console. It is cached in config after being
 * read, and re-read from the console during a verification run.
 */

import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';
import { safeConfigGet, safeConfigString } from './config-access.js';

/** A snapshot of what already exists, all of it probed rather than remembered. */
export interface GoogleSetupState {
  /** An app password is present in the secret store. */
  readonly hasAppPassword: boolean;
  /** Every Gmail IMAP/SMTP config key needed to connect is populated. */
  readonly hasGmailConfig: boolean;
  /** The mail surface is switched on. */
  readonly gmailEnabled: boolean;
  /** The account address Gmail is configured for, or null. Not a secret. */
  readonly gmailUsername: string | null;
  /** A private calendar address is present in the secret store. */
  readonly hasCalendarAddress: boolean;
  /** An OAuth client id is configured. Client ids are not secrets (RFC 8252). */
  readonly oauthClientId: string | null;
  /** An OAuth client secret is present in the secret store. */
  readonly hasOAuthClientSecret: boolean;
  /** A refresh token is present in the secret store. */
  readonly hasRefreshToken: boolean;
  /** The Cloud project id recorded for the OAuth path, or null. */
  readonly projectId: string | null;
  /** Last known publishing status. 'unknown' until the console has been read. */
  readonly publishingStatus: 'testing' | 'in-production' | 'unknown';
}

function readPublishingStatus(value: unknown): GoogleSetupState['publishingStatus'] {
  if (value === 'testing' || value === 'in-production') return value;
  return 'unknown';
}

/** True when a secret exists and is non-empty. Never returns the value itself. */
async function secretPresent(secrets: GoogleSecretPort, key: string): Promise<boolean> {
  try {
    const value = await secrets.get(key);
    return typeof value === 'string' && value.trim().length > 0;
  } catch {
    // An unreadable secret store is treated as "not present" so the flow
    // offers to set the value again rather than failing opaquely.
    return false;
  }
}

/** Probe everything the Google flows care about. */
export async function detectGoogleSetupState(deps: {
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
}): Promise<GoogleSetupState> {
  const { config, secrets } = deps;

  const username = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailUsername);
  const imapHost = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailImapHost);
  const smtpHost = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailSmtpHost);
  const passwordRef = safeConfigString(config, GOOGLE_CONFIG_KEYS.emailPasswordRef);

  const [hasAppPassword, hasCalendarAddress, hasOAuthClientSecret, hasRefreshToken] = await Promise.all([
    secretPresent(secrets, GOOGLE_SECRET_KEYS.appPassword),
    secretPresent(secrets, GOOGLE_SECRET_KEYS.calendarIcsUrl),
    secretPresent(secrets, GOOGLE_SECRET_KEYS.oauthClientSecret),
    secretPresent(secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken),
  ]);

  return {
    hasAppPassword,
    hasGmailConfig: username !== null && imapHost !== null && smtpHost !== null && passwordRef !== null,
    gmailEnabled: safeConfigGet(config, GOOGLE_CONFIG_KEYS.emailEnabled) === true,
    gmailUsername: username,
    hasCalendarAddress,
    oauthClientId: safeConfigString(config, GOOGLE_CONFIG_KEYS.oauthClientId),
    hasOAuthClientSecret,
    hasRefreshToken,
    projectId: safeConfigString(config, GOOGLE_CONFIG_KEYS.oauthProjectId),
    publishingStatus: readPublishingStatus(safeConfigGet(config, GOOGLE_CONFIG_KEYS.oauthPublishingStatus)),
  };
}

/**
 * A plain-language description of the current state, for `--check` and for the
 * opening line of a run so the owner can see what will be skipped. Contains no
 * secret values, only whether each one is present.
 */
export function describeGoogleSetupState(state: GoogleSetupState): readonly string[] {
  const lines: string[] = [];

  if (state.hasGmailConfig && state.hasAppPassword) {
    const account = state.gmailUsername ?? 'an account';
    lines.push(`Gmail: configured for ${account} with a stored app password${state.gmailEnabled ? '' : ' (currently switched off)'}.`);
  } else if (state.hasAppPassword) {
    lines.push('Gmail: an app password is stored but the mail settings are incomplete.');
  } else {
    lines.push('Gmail: not connected.');
  }

  lines.push(
    state.hasCalendarAddress
      ? 'Calendar: a private calendar address is stored (read-only access).'
      : 'Calendar: not connected.',
  );

  if (state.hasRefreshToken) {
    const expiry =
      state.publishingStatus === 'in-production'
        ? 'the app is published, so the credential does not expire'
        : state.publishingStatus === 'testing'
          ? 'WARNING: the app is still in Testing, so this credential expires seven days after it was issued'
          : 'publishing status has not been read yet, so the credential lifetime is unknown';
    lines.push(`OAuth: authorized, ${expiry}.`);
  } else if (state.oauthClientId !== null) {
    lines.push('OAuth: a client exists but the agent has not been authorized yet.');
  } else {
    lines.push('OAuth: not set up.');
  }

  return lines;
}

/**
 * Whether the app-password path has everything it needs. Used to answer
 * "is there anything left to do" without running the flow.
 */
export function appPasswordPathComplete(state: GoogleSetupState): boolean {
  return state.hasAppPassword && state.hasGmailConfig && state.gmailEnabled && state.hasCalendarAddress;
}

/** Whether the OAuth path is complete *and* not on a seven-day fuse. */
export function oauthPathComplete(state: GoogleSetupState): boolean {
  return (
    state.oauthClientId !== null &&
    state.hasOAuthClientSecret &&
    state.hasRefreshToken &&
    state.publishingStatus === 'in-production'
  );
}
