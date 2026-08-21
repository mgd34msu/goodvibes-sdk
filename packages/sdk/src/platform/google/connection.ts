/**
 * Turning credentials on this machine into a usable Google client.
 *
 * This is the composition root the connector never had. Every piece existed,
 * adoption, the token manager, the API client, the refresh call, and nothing
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
 * is not a substitute for connecting an account, `/google adopt` copies the
 * credentials into the encrypted store so they survive the other tool being
 * removed, but it means the capability is genuinely usable rather than
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
import { safeConfigGet, safeConfigString } from './config-access.js';
import { diagnoseInvalidGrant } from './grant-diagnosis.js';

/**
 * What the diagnosis needs to tell an account mix-up from a revocation.
 *
 * Assembled from config at connection time so the answer is available at the
 * moment a refresh fails, rather than requiring a second round of lookups
 * inside an error path.
 */
interface GrantContext {
  readonly intendedAccount: string | null;
  readonly signedInAccount: string | null;
  readonly publishingStatus: 'testing' | 'in-production' | 'unknown';
  readonly credentialOrigin: 'secret-store' | 'gmail-mcp' | null;
}

function readPublishingStatus(value: unknown): GrantContext['publishingStatus'] {
  return value === 'testing' || value === 'in-production' ? value : 'unknown';
}

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
 * Config reads go through the shared guard: resolvePath throws on an absent
 * section, and a throw here would turn a missing key into a broken tool rather
 * than "no account connected". See config-access.ts.
 */
function safeGet(sources: GoogleConnectionSources, key: string): unknown {
  return safeConfigGet({ get: sources.configGet }, key);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Credentials from the agent's own encrypted store, when a complete set is
 * there. A partial set is treated as absent, a client id with no refresh
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
 * Resolve the Google credentials this machine holds.
 *
 * The encrypted store, and by default nothing else. This used to fall through
 * to a scan of `~/.gmail-mcp` on every resolve, which meant an ordinary
 * capability check went looking through the home directory for another tool's
 * credential files. That is not something to do unasked: most people have no
 * such directory, and a connector that quietly picks up credentials it found
 * lying around is doing something nobody requested.
 *
 * Adoption is still fully supported and still works exactly as it did, it is
 * just user-directed now. Someone names a path (or runs the adopt command),
 * the credentials are copied into the encrypted store, and the reply says what
 * was taken up and where it now lives. `readDiskCredentials` exists for those
 * explicit callers; nothing reaches it by default.
 */
export async function resolveGoogleCredentials(
  sources: GoogleConnectionSources,
  options: { readonly includeDiskCredentials?: boolean } = {},
): Promise<GoogleOAuthCredentials | null> {
  const owned = await storeCredentials(sources);
  if (owned !== null) return owned;
  if (options.includeDiskCredentials !== true) return null;
  return adoptGmailMcpCredentials(sources.files, sources.homeDirectory);
}

/**
 * Read credentials from the known on-disk layout, for a caller that was
 * explicitly told to look there. Never called from a default path.
 */
export function readDiskCredentials(
  sources: Pick<GoogleConnectionSources, 'files' | 'homeDirectory'>,
): GoogleOAuthCredentials | null {
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
function refreshFn(fetchPort: GoogleFetchPort, context: GrantContext) {
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
      if (invalid) {
        // A dead grant gets a stated cause rather than a generic "re-run
        // setup". Six identical retries happened because nothing here ever
        // said WHY, so there was nothing to act on except trying again.
        const diagnosis = diagnoseInvalidGrant({
          googleError: response.problem,
          intendedAccount: context.intendedAccount,
          signedInAccount: context.signedInAccount,
          publishingStatus: context.publishingStatus,
          credentialOrigin: context.credentialOrigin,
        });
        return {
          ok: false,
          failure: 'grant-invalid',
          problem: diagnosis.problem,
          fix: diagnosis.fix,
        };
      }
      return {
        ok: false,
        failure: 'transient',
        problem: response.problem,
        fix: response.fix,
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
  /**
   * The same token manager the client calls through.
   *
   * Carried because `scopes()` is the only honest answer to "what is this grant
   * allowed to do", and it is only correct AFTER a refresh: credentials read
   * from the encrypted secret store are constructed with `scopes: []` (the
   * store records no scope list), and the real set arrives on the refresh
   * response. A caller that gates on scopes, `collectHistoryDelta` does, and
   * refuses with `no-gmail-scope` when it sees none, therefore has to be able
   * to force that refresh first, or it would read an empty list as a revoked
   * capability and report a working mailbox as unreadable.
   *
   * The SAME instance rather than a second one, for the same reason
   * `historyDeltaPort` exists: two managers are two access tokens, two refresh
   * races and two different answers to `scopes()`.
   */
  readonly tokens: GoogleTokenManager;
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
  ports: {
    readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
    /**
     * The account this machine is signed in as, when something knows it,
     * normally gcloud's active account. Supplied so an `invalid_grant` can be
     * diagnosed as an account mix-up instead of a shrug.
     */
    readonly signedInAccount?: string | null;
  },
  now: number = Date.now(),
): Promise<GoogleConnection | null> {
  const credentials = await resolveGoogleCredentials(sources);
  if (credentials === null) return null;

  const context: GrantContext = {
    intendedAccount: safeConfigString({ get: sources.configGet }, GOOGLE_CONFIG_KEYS.emailUsername),
    signedInAccount: ports.signedInAccount ?? null,
    publishingStatus: readPublishingStatus(safeGet(sources, GOOGLE_CONFIG_KEYS.oauthPublishingStatus)),
    credentialOrigin: credentials.origin,
  };

  const tokens = new GoogleTokenManager(credentials, { refresh: refreshFn(ports.fetch, context) });
  return {
    client: new GoogleApiClient(tokens, ports.fetch),
    tokens,
    credentials,
    summary: summarizeCredentials(credentials, now),
  };
}
