/**
 * Registering an OAuth client the owner just handed over, and getting the
 * consent link back in the same breath.
 *
 * ── Why this is not the setup-flow runner ──────────────────────────────────
 *
 * `oauthAuthorizeRunner` awaits the redirect: it blocks for up to five minutes
 * while a person visits Google. That is right for a command someone is
 * watching, and wrong for a conversational turn, which has to answer NOW. A
 * turn that blocks for five minutes is a turn that looks broken.
 *
 * So the consent is split in two. `beginGoogleConsent` binds the listener,
 * builds the URL and returns immediately; the exchange finishes on the
 * `completed` promise whenever the person actually approves. The caller hands
 * back the link in its reply and the refresh token lands in the encrypted store
 * on its own, without anybody being told to run anything afterwards.
 *
 * ── The rule about the secret ─────────────────────────────────────────────
 *
 * A client secret arrives here because the owner pasted it into a conversation.
 * It goes into the encrypted store and it is never returned, never echoed and
 * never put in a detail line. `registerGoogleClient` hands back the client id's
 * last few characters and nothing else, which is enough for a person to confirm
 * the right client was registered and useless to anyone reading the transcript
 * later. Google shows the full secret exactly once, at creation, so the value
 * arriving here is often the only copy, losing it means making a new client,
 * and echoing it means it lives in a log.
 */

import { clientCredentialsFromInput, type GoogleClientCredentials } from './client-intake.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkcePair,
  type GoogleFetchPort,
  type GoogleLoopbackListenerFactory,
} from './oauth-loopback.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, OAUTH_SCOPES } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';

/** How long the listener waits for the person before giving up. */
export const CONSENT_WAIT_MS = 600_000;

/**
 * How much of a client id is safe to show back.
 *
 * The tail rather than the head: a Google client id begins with a long numeric
 * project fragment that is identical across every client in one project, so the
 * first characters distinguish nothing. Client ids are not secrets (RFC 8252
 * says so plainly), but showing the whole thing back adds noise to a reply
 * whose job is to confirm, so the tail is the useful part.
 */
const CLIENT_ID_TAIL_CHARS = 12;

/** Safe-to-display confirmation that a client was registered. Carries no secret. */
export interface GoogleClientRegistration {
  readonly ok: true;
  /** The last characters of the client id. Never the secret, in any form. */
  readonly clientIdTail: string;
}

export interface GoogleClientRegistrationFailed {
  readonly ok: false;
  readonly problem: string;
  readonly fix: string;
}

export type GoogleClientRegistrationResult = GoogleClientRegistration | GoogleClientRegistrationFailed;

/** The tail of a client id, for a confirmation line. */
export function clientIdTail(clientId: string): string {
  const trimmed = clientId.trim();
  return trimmed.length <= CLIENT_ID_TAIL_CHARS ? trimmed : `...${trimmed.slice(-CLIENT_ID_TAIL_CHARS)}`;
}

/**
 * Store a client id and secret the owner supplied.
 *
 * The id goes to config, the secret to the encrypted store, and the reply
 * carries neither in full. Validation is `clientCredentialsFromInput`, the same
 * check every other intake route uses, so a mistyped pair is refused here
 * rather than at the consent screen.
 */
export async function registerGoogleClient(
  deps: { readonly config: GoogleConfigPort; readonly secrets: GoogleSecretPort },
  input: { readonly clientId: string; readonly clientSecret: string },
): Promise<GoogleClientRegistrationResult> {
  const intake = clientCredentialsFromInput(input);
  if (!intake.ok) {
    return { ok: false, problem: intake.problem, fix: intake.fix };
  }
  return storeClientCredentials(deps, intake.credentials);
}

/** Shared by both intake routes: config half, secret half, safe confirmation. */
export async function storeClientCredentials(
  deps: { readonly config: GoogleConfigPort; readonly secrets: GoogleSecretPort },
  credentials: GoogleClientCredentials,
): Promise<GoogleClientRegistration> {
  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientId, credentials.clientId);
  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, GOOGLE_CONFIG_KEYS.oauthClientSecretRef);
  await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, credentials.clientSecret);
  return { ok: true, clientIdTail: clientIdTail(credentials.clientId) };
}

/** How the consent ended. Safe to display; never carries a token. */
export interface GoogleConsentCompletion {
  readonly ok: boolean;
  readonly detail: string;
  readonly problem?: string;
  readonly fix?: string;
}

export interface GoogleConsentSession {
  /** The link to hand the person. This is the one action the flow asks of them. */
  readonly consentUrl: string;
  /**
   * Resolves when the person approves, or when the wait ends without them.
   *
   * Never rejects: a consent nobody completed is an ordinary outcome, not a
   * fault, and a rejected promise nobody awaited would surface as an unhandled
   * rejection in whatever process happened to be running.
   */
  readonly completed: Promise<GoogleConsentCompletion>;
  /** Release the port without waiting. Safe to call more than once. */
  cancel(): void;
}

export interface BeginGoogleConsentDeps {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  readonly loopback: GoogleLoopbackListenerFactory;
  readonly fetchPort: GoogleFetchPort;
  /** The account to preselect on the consent screen, when anything knows it. */
  readonly loginHint?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected so the CSRF token is deterministic in tests. */
  readonly generateState?: (() => string) | undefined;
}

function randomState(): string {
  // Web Crypto rather than node:crypto: this module is imported by surfaces
  // that run outside node, and a bare `randomBytes` import would break them.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Start a consent and return its link straight away.
 *
 * The caller gets the URL synchronously and can answer with it in the same
 * reply. Everything after the person clicks, the redirect, the state check,
 * the code exchange, storing the refresh token, happens on `completed`.
 */
export function beginGoogleConsent(deps: BeginGoogleConsentDeps): GoogleConsentSession {
  const pkce = generatePkcePair();
  // This run's CSRF token: the listener rejects any redirect not carrying it.
  const state = (deps.generateState ?? randomState)();
  const listener = deps.loopback({ expectedState: state });

  const consentUrl = buildAuthorizationUrl({
    clientId: deps.clientId,
    redirectUri: listener.redirectUri,
    // Every scope the platform's Google features need, in ONE consent, the
    // same list the setup flow uses, for the same reason.
    scopes: OAUTH_SCOPES,
    codeChallenge: pkce.codeChallenge,
    state,
    ...(deps.loginHint === undefined ? {} : { loginHint: deps.loginHint }),
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    listener.close();
  };

  const completed: Promise<GoogleConsentCompletion> = (async () => {
    try {
      let code: string;
      try {
        const received = await listener.waitForCode(deps.timeoutMs ?? CONSENT_WAIT_MS);
        code = received.code;
      } catch (error) {
        return {
          ok: false,
          detail: 'The Google consent was not completed.',
          problem: `No authorization code came back: ${error instanceof Error ? error.message : String(error)}`,
          fix: 'Open the consent link again and approve it; the link is good until it is used.',
        };
      }

      const tokens = await exchangeCodeForTokens(
        {
          clientId: deps.clientId,
          clientSecret: deps.clientSecret,
          code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: listener.redirectUri,
        },
        deps.fetchPort,
      );
      if (!tokens.ok) {
        return { ok: false, detail: 'Google refused the authorization code.', problem: tokens.problem, fix: tokens.fix };
      }
      // Google issues a refresh token only on a fresh consent. Without one
      // there is nothing durable to keep, so this is reported rather than
      // recorded as a success.
      if (tokens.refreshToken === undefined) {
        return {
          ok: false,
          detail: 'Google returned no refresh token.',
          problem: 'Google issues a refresh token only on a fresh consent, and this authorization reused an existing grant.',
          fix: 'Remove the app at https://myaccount.google.com/permissions, then approve a new consent link.',
        };
      }

      await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, tokens.refreshToken);
      return { ok: true, detail: 'Google approved. The credential is in the encrypted store.' };
    } finally {
      close();
    }
  })();

  return { consentUrl, completed, cancel: close };
}
