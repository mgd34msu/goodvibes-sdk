/**
 * Getting OAuth client credentials into the agent — the pluggable front step.
 *
 * This module exists to draw one line: **everything downstream of it neither
 * knows nor cares where the client credentials came from.** Consent, refresh
 * token capture, automatic refresh, secret storage, the connector and its
 * capability registration are written once and take a
 * `GoogleClientCredentials` value.
 *
 * Three routes converge here:
 *
 *   1. `console-walkthrough` — the browser drives the user's own Google
 *      account through project → APIs → consent screen → Desktop client.
 *      This is the only UI-dependent, brittle part of the whole integration,
 *      and it is deliberately quarantined behind this boundary: a Google
 *      console redesign breaks the walkthrough and nothing else.
 *   2. `client-json-file` — point at a client JSON from any source. A user
 *      who already has one skips the walkthrough entirely. This is also how
 *      credentials from an existing local tool are adopted; that is not a
 *      special case, it is just this route.
 *   3. `manual-entry` — paste a client id and secret.
 *
 * Because routes 2 and 3 need no browser, the connector can be tested end to
 * end without ever launching one.
 *
 * There is no bundled client credential. Every user's OAuth client belongs to
 * their own Google account, so nothing about any particular account is
 * compiled into the product.
 */

/** OAuth client credentials for an installed ("Desktop app") client. */
export interface GoogleClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authUri: string;
  readonly tokenUri: string;
}

/** Which route supplied the credentials. Recorded for display, never behaviour. */
export type GoogleClientIntakeRoute = 'console-walkthrough' | 'client-json-file' | 'manual-entry';

export type GoogleClientIntakeResult =
  | { readonly ok: true; readonly credentials: GoogleClientCredentials; readonly route: GoogleClientIntakeRoute }
  | { readonly ok: false; readonly problem: string; readonly fix: string };

const DEFAULT_AUTH_URI = 'https://accounts.google.com/o/oauth2/auth';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A Google client id always ends in `.apps.googleusercontent.com`. Checking
 * shape here turns "pasted the wrong string" into an immediate, specific
 * message instead of an opaque `invalid_client` from Google three steps later.
 */
function validateClientId(clientId: string): string | null {
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    return 'That does not look like a Google OAuth client id — they end in ".apps.googleusercontent.com".';
  }
  return null;
}

/**
 * Route 2 — parse a downloaded client JSON.
 *
 * Google wraps the credentials in `installed` for Desktop clients and `web`
 * for web clients; some tools store them unwrapped. All three are accepted,
 * but a `web` client is rejected with a specific message, because a web client
 * cannot complete the loopback flow and the resulting failure is otherwise
 * baffling.
 */
export function readClientCredentialsFromJson(rawText: string): GoogleClientIntakeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      problem: 'That file is not valid JSON.',
      fix: 'Download the client JSON again from the Google Cloud console and point at the downloaded file.',
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      problem: 'That file does not contain a JSON object.',
      fix: 'Use the client JSON downloaded from the Google Cloud console.',
    };
  }

  if (isRecord(parsed.web) && !isRecord(parsed.installed)) {
    return {
      ok: false,
      problem: 'That is a Web application OAuth client. It cannot complete the loopback sign-in this agent uses.',
      fix: 'Create a new OAuth client and choose application type "Desktop app", then point at that file.',
    };
  }

  const inner = isRecord(parsed.installed) ? parsed.installed : parsed;
  const clientId = readString(inner.client_id);
  const clientSecret = readString(inner.client_secret);

  if (clientId === null || clientSecret === null) {
    return {
      ok: false,
      problem: 'That file has no client id and secret in it.',
      fix: 'Download the JSON for a Desktop app OAuth client from the Google Cloud console.',
    };
  }

  const shapeProblem = validateClientId(clientId);
  if (shapeProblem !== null) {
    return { ok: false, problem: shapeProblem, fix: 'Check you downloaded the right file.' };
  }

  return {
    ok: true,
    route: 'client-json-file',
    credentials: {
      clientId,
      clientSecret,
      authUri: readString(inner.auth_uri) ?? DEFAULT_AUTH_URI,
      tokenUri: readString(inner.token_uri) ?? DEFAULT_TOKEN_URI,
    },
  };
}

/** Route 3 — a client id and secret typed or pasted in directly. */
export function clientCredentialsFromInput(input: {
  readonly clientId: string;
  readonly clientSecret: string;
}): GoogleClientIntakeResult {
  const clientId = readString(input.clientId);
  const clientSecret = readString(input.clientSecret);

  if (clientId === null) {
    return { ok: false, problem: 'No client id was given.', fix: 'Paste the client id from the Google Cloud console.' };
  }
  if (clientSecret === null) {
    return {
      ok: false,
      problem: 'No client secret was given.',
      fix: 'Paste the client secret shown next to the client id in the Google Cloud console.',
    };
  }

  const shapeProblem = validateClientId(clientId);
  if (shapeProblem !== null) {
    return { ok: false, problem: shapeProblem, fix: 'Copy the client id again from the console.' };
  }

  return {
    ok: true,
    route: 'manual-entry',
    credentials: { clientId, clientSecret, authUri: DEFAULT_AUTH_URI, tokenUri: DEFAULT_TOKEN_URI },
  };
}

// ---------------------------------------------------------------------------
// One-time migration off plaintext credential files
// ---------------------------------------------------------------------------

/**
 * Legacy credential locations that predate the encrypted store.
 *
 * These files hold a refresh token in cleartext on disk, which is the worst
 * property of the setup they came from. Migration reads them exactly once,
 * copies what it finds into the encrypted secret store, and records that it
 * has done so; afterwards nothing reads them again.
 *
 * The files are deliberately **left in place and unmodified**. Another tool
 * may still be using them, and deleting a working credential out from under
 * a running program is not this code's decision to make.
 */
export interface LegacyCredentialLocation {
  readonly label: string;
  readonly clientFile: string;
  readonly tokenFiles: readonly string[];
}

/** Marker recording that migration already ran, so it is not repeated. */
export const LEGACY_MIGRATION_CONFIG_KEY = 'google.credentials.migratedFrom';

export interface LegacyMigrationOutcome {
  readonly migrated: boolean;
  /** Safe to display: what was moved, never a value. */
  readonly detail: string;
  readonly route: GoogleClientIntakeRoute | null;
}

/**
 * Decide whether a legacy migration should run.
 *
 * Kept as a pure decision so the policy is testable without touching a real
 * home directory or a real secret store.
 */
export function shouldMigrateLegacyCredentials(input: {
  readonly alreadyMigratedFrom: string | null;
  readonly legacyFilePresent: boolean;
  readonly storeAlreadyHasCredentials: boolean;
}): { readonly migrate: boolean; readonly reason: string } {
  if (input.storeAlreadyHasCredentials) {
    return { migrate: false, reason: 'The encrypted store already holds Google credentials.' };
  }
  if (input.alreadyMigratedFrom !== null) {
    return { migrate: false, reason: `Already migrated from ${input.alreadyMigratedFrom}.` };
  }
  if (!input.legacyFilePresent) {
    return { migrate: false, reason: 'No legacy credential file is present.' };
  }
  return { migrate: true, reason: 'A legacy credential file is present and the encrypted store is empty.' };
}
