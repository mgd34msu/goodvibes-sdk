/**
 * Turning credentials on this machine into a usable Google client.
 *
 * This is the composition root the connector never had. Every piece existed —
 * adoption, the token manager, the API client, the refresh call — and nothing
 * assembled them, so the agent held working credentials it could not reach.
 *
 * Precedence is native-first and deliberate:
 *
 *   1. The agent's own encrypted secret store. Credentials it owns, can
 *      refresh, and can write back to.
 *   2. An existing `~/.gmail-mcp` install. Read-only: these belong to another
 *      tool that may still be running, so a refreshed access token is never
 *      written back over them.
 *
 * The fallback is what makes the owner's machine work without a setup run. It
 * is not a substitute for connecting an account — `/google adopt` copies the
 * credentials into the encrypted store so they survive the other tool being
 * removed — but it means the capability is genuinely usable rather than
 * merely explainable.
 */

import { GoogleApiClient, type GoogleApiFetchPort } from './api-client.js';
import { GoogleTokenManager, type GoogleRefreshOutcome } from './token-manager.js';
import { refreshAccessToken, type GoogleFetchPort } from './oauth-loopback.js';
import {
  adoptGmailMcpCredentials,
  gmailMcpLayout,
  summarizeCredentials,
  type GoogleCredentialSummary,
  type GoogleFilePort,
  type GoogleOAuthCredentials,
} from './credential-adoption.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';

/** The paths adoption reads. Exported so the capability index probes the same list. */
export function googleCredentialPaths(homeDirectory: string): readonly string[] {
  const layout = gmailMcpLayout(homeDirectory);
  return [layout.clientFile, ...layout.tokenFiles];
}

export interface GoogleConnectionSources {
  readonly files: GoogleFilePort;
  readonly homeDirectory: string;
  /** Reads a config value. Never used for secret values. */
  readonly configGet: (key: string) => unknown;
  /** Reads a secret. Returns null when absent. */
  readonly secretGet: (key: string) => Promise<string | null>;
}

/**
 * Config reads are wrapped because resolvePath throws on an absent section.
 * Callers seed the sections, but a throw here would turn a missing key into a
 * broken tool rather than "no account connected".
 */
function safeGet(sources: GoogleConnectionSources, key: string): unknown {
  try {
    return sources.configGet(key);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Credentials from the agent's own encrypted store, when a complete set is
 * there. A partial set is treated as absent — a client id with no refresh
 * token cannot call anything, and reporting it as present would produce a
 * capability that claims to be ready and then fails on first use.
 */
async function storeCredentials(sources: GoogleConnectionSources): Promise<GoogleOAuthCredentials | null> {
  const clientId = readString(safeGet(sources, GOOGLE_CONFIG_KEYS.oauthClientId));
  if (clientId === null) return null;

  const [clientSecret, refreshToken] = await Promise.all([
    sources.secretGet(GOOGLE_SECRET_KEYS.oauthClientSecret),
    sources.secretGet(GOOGLE_SECRET_KEYS.oauthRefreshToken),
  ]);
  const secret = readString(clientSecret);
  const refresh = readString(refreshToken);
  if (secret === null || refresh === null) return null;

  return {
    clientId,
    clientSecret: secret,
    refreshToken: refresh,
    accessToken: null,
    expiresAtMs: null,
    // The store records no scope list; what the grant actually permits is
    // whatever Google honours, and the connector reports refusals plainly.
    scopes: [],
    tokenUri: 'https://oauth2.googleapis.com/token',
    origin: 'secret-store',
    location: 'the encrypted secret store',
  };
}

/**
 * Resolve whatever Google credentials this machine has, native store first.
 * Returns null when there are none — never a partial or guessed set.
 */
export async function resolveGoogleCredentials(
  sources: GoogleConnectionSources,
): Promise<GoogleOAuthCredentials | null> {
  const owned = await storeCredentials(sources);
  if (owned !== null) return owned;
  return adoptGmailMcpCredentials(sources.files, sources.homeDirectory);
}

/** Safe-to-display posture. Contains provenance and scopes, never a token. */
export async function describeGoogleConnection(
  sources: GoogleConnectionSources,
  now: number = Date.now(),
): Promise<GoogleCredentialSummary> {
  return summarizeCredentials(await resolveGoogleCredentials(sources), now);
}

/**
 * The refresh call, wrapped so the token manager's injected shape is satisfied
 * and so no token value can reach an error message.
 */
function refreshFn(fetchPort: GoogleFetchPort) {
  return async (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
    readonly tokenUri: string;
  }): Promise<GoogleRefreshOutcome> => {
    const response = await refreshAccessToken(
      { clientId: input.clientId, clientSecret: input.clientSecret, refreshToken: input.refreshToken },
      fetchPort,
    );
    if (!response.ok) {
      // Google answers a revoked or expired grant with invalid_grant; that
      // needs a person, whereas anything else is worth retrying.
      const invalid = /invalid_grant|expired|revoked/i.test(response.problem);
      return {
        ok: false,
        failure: invalid ? 'grant-invalid' : 'transient',
        problem: response.problem,
        fix: invalid
          ? 'Re-authorize the Google account with: /google setup --path oauth'
          : response.fix,
      };
    }
    return {
      ok: true,
      result: {
        accessToken: response.accessToken,
        expiresInSeconds: response.expiresInSeconds,
        scopes: response.scope.length > 0 ? response.scope.split(/\s+/).filter(Boolean) : null,
      },
    };
  };
}

export interface GoogleConnection {
  readonly client: GoogleApiClient;
  readonly credentials: GoogleOAuthCredentials;
  readonly summary: GoogleCredentialSummary;
}

/**
 * Build a live Google client, or explain why there is not one.
 *
 * Adopted credentials get no persist function: they belong to another tool and
 * are never written back.
 */
export async function openGoogleConnection(
  sources: GoogleConnectionSources,
  ports: { readonly fetch: GoogleFetchPort & GoogleApiFetchPort },
  now: number = Date.now(),
): Promise<GoogleConnection | null> {
  const credentials = await resolveGoogleCredentials(sources);
  if (credentials === null) return null;

  const tokens = new GoogleTokenManager(credentials, { refresh: refreshFn(ports.fetch) });
  return {
    client: new GoogleApiClient(tokens, ports.fetch),
    credentials,
    summary: summarizeCredentials(credentials, now),
  };
}
