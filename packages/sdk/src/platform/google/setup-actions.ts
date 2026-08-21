/**
 * The runners that make the Google setup flow do something.
 *
 * `google-setup-flow.ts` sequences steps and assembles a report; it is
 * deliberately free of Google specifics and names this module as the place the
 * concrete work lives. That module was written, tested and shipped, and this
 * one never was, so every flow module underneath it (`google-console-flow`,
 * `google-client-intake`, `google-app-password-flow`, `google-client-download`)
 * had no caller outside its own tests. The feature was green and unreachable at
 * the same time, because the tests exercised the modules directly and nothing
 * exercised a path starting from something a user types.
 *
 * So this module is the binding layer, and it is the only place that knows both
 * "step id" and "which function performs it". Everything it needs arrives
 * through ports, so the whole flow stays runnable against fakes.
 *
 * Two rules hold throughout:
 *   - A step reports `needs-human` when Google genuinely requires a person.
 *     That is a clean stop, not a failure, and the spec's own `manualSteps`
 *     are what the report shows.
 *   - Secrets go from the flow into the encrypted store and nowhere else. No
 *     detail string, progress line, warning or error carries a credential
 *     value.
 */

import { randomBytes } from 'node:crypto';
import {
  APP_PASSWORD_LABEL,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
  OAUTH_SCOPES,
  REQUIRED_SERVICES,
} from './setup-plan.js';
import type { GoogleStepRunner, GoogleStepRunnerResult } from './setup-flow.js';
import type { GoogleSecretPort, GoogleSetupPath, GoogleStepId } from './types.js';
import type { GoogleClientIntakeChoice, GoogleSetupActionDeps } from './setup-action-deps.js';
import { buildCloudProjectRunners } from './setup-actions-cloud-project.js';
import { createAppPassword } from './app-password-flow.js';
import { createDesktopOAuthClient } from './console-flow.js';
import {
  clientCredentialsFromInput,
  readClientCredentialsFromJson,
  type GoogleClientCredentials,
  type GoogleClientIntakeResult,
} from './client-intake.js';
import { collectDownloadedClientFile } from './client-download.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkcePair,
} from './oauth-loopback.js';
import { looksLikeGoogleSignIn } from './browser-elements.js';
import { safeConfigGet, safeConfigString } from './config-access.js';

/** How long to wait for the person to finish Google's consent screen. */
const CONSENT_TIMEOUT_MS = 300_000;

function base64UrlRandom(): string {
  return randomBytes(32).toString('base64url');
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function done(detail: string, warnings?: readonly string[]): GoogleStepRunnerResult {
  return warnings === undefined || warnings.length === 0 ? { outcome: 'done', detail } : { outcome: 'done', detail, warnings };
}

function alreadyDone(detail: string): GoogleStepRunnerResult {
  return { outcome: 'already-done', detail };
}

function needsHuman(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'needs-human', detail, problem, fix };
}

function failed(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'failed', detail, problem, fix };
}

// ---------------------------------------------------------------------------
// Path A, app password
// ---------------------------------------------------------------------------

function browserReadyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    try {
      await deps.browser();
      return done('A browser is available for the pages Google exposes through no API.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failed(
        'No browser could be opened.',
        `The browser this flow drives could not be started: ${message}`,
        'Reinstall the agent so its browser driver is present, then re-run.',
      );
    }
  };
}

/**
 * Signed-in check. Landing on Google's sign-in wall is the normal first-run
 * outcome and is reported as a clean stop, never as a failure.
 */
function signedInRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    const browser = await deps.browser();
    const url = spec.url;
    if (url !== undefined) await browser.navigate(url);
    const current = await browser.currentUrl();
    const elements = await browser.snapshot();
    if (looksLikeGoogleSignIn(current, elements)) {
      return needsHuman(
        'Google is asking for a sign-in.',
        `Google showed its sign-in page instead of the account page (currently at ${current}).`,
        'Sign in to the Google account you want the agent to use in the open browser window, complete any 2-Step prompt, then re-run. The sign-in is remembered from then on.',
      );
    }
    return done('Signed in to Google in the browser profile this flow uses.');
  };
}

function twoStepRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    const browser = await deps.browser();
    if (spec.url !== undefined) await browser.navigate(spec.url);
    const text = await browser.readText({ maxChars: 4000 });
    if (/2-step verification is on|2-step verification\s*:?\s*on\b/i.test(text)) {
      return alreadyDone('2-Step Verification is already on, which is what makes app passwords available.');
    }
    if (/turn on 2-step verification/i.test(text)) {
      return needsHuman(
        '2-Step Verification is off.',
        'Google only offers app passwords on accounts with 2-Step Verification enabled, and this account has it off.',
        `Open ${spec.url ?? 'the 2-Step Verification settings'}, click "Turn on 2-Step Verification", follow the prompts, then re-run.`,
      );
    }
    // An unreadable page is not proof of either state, so it is not claimed as one.
    return needsHuman(
      'Could not read the 2-Step Verification state.',
      'The 2-Step Verification page did not render text this flow could read, so its state is unknown rather than off.',
      `Open ${spec.url ?? 'the 2-Step Verification settings'} yourself and confirm it reads "2-Step Verification is on", then re-run.`,
    );
  };
}

function appPasswordRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    if (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.appPassword)) {
      return alreadyDone(`An app password labelled ${APP_PASSWORD_LABEL} is already in the encrypted store.`);
    }
    const browser = await deps.browser();
    const result = await createAppPassword(browser, { label: APP_PASSWORD_LABEL });
    if (result.kind === 'needs-human') {
      return needsHuman('Google needs a person for this step.', result.problem, result.fix);
    }
    if (result.kind === 'failed') {
      return failed('The app password was not created.', result.problem, result.fix);
    }
    // The only place the value is touched: straight into the encrypted store.
    await deps.secrets.set(GOOGLE_SECRET_KEYS.appPassword, result.password);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailPasswordRef, GOOGLE_CONFIG_KEYS.emailPasswordRef);
    return done('Created a Gmail app password and stored it in the encrypted secret store.');
  };
}

/**
 * Writes the Gmail endpoints. The account address is the one thing this cannot
 * invent: it is taken from config, or from an adopted credential, and asked for
 * when neither knows it.
 */
function gmailConfigRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const configured = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.emailUsername);
    const username = configured;
    if (username === null) {
      return needsHuman(
        'The Gmail address is not known yet.',
        'Gmail needs the account address to connect over IMAP and SMTP, and nothing on this machine records which address to use.',
        'Tell me which Gmail address to connect as and I will set it up.',
      );
    }

    deps.config.set(GOOGLE_CONFIG_KEYS.emailImapHost, GMAIL_IMAP_HOST);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailImapPort, GMAIL_IMAP_PORT);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpHost, GMAIL_SMTP_HOST);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpPort, GMAIL_SMTP_PORT);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailSmtpSecurity, 'starttls');
    deps.config.set(GOOGLE_CONFIG_KEYS.emailFromAddress, username);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailPasswordRef, GOOGLE_CONFIG_KEYS.emailPasswordRef);
    deps.config.set(GOOGLE_CONFIG_KEYS.emailEnabled, true);
    return done(`Pointed the mail surface at Gmail for ${username}.`);
  };
}

function gmailVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const verify = deps.verifyMail;
    if (verify === undefined) {
      return needsHuman(
        'Mail connectivity was not checked.',
        'This run had no way to open a real IMAP and SMTP session, so the credential is stored but unproven.',
        'Say the word and I will open a real IMAP and SMTP session to check it.',
      );
    }
    const outcome = await verify();
    return outcome.ok
      ? done(outcome.detail)
      : failed(
        'Could not connect to Gmail.',
        outcome.detail,
        'If IMAP reports AUTHENTICATIONFAILED the app password was mistyped, say so and I will walk you through making a new one.',
      );
  };
}

function calendarIcsRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    if (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.calendarIcsUrl)) {
      return alreadyDone('A private calendar address is already stored.');
    }
    // Google exposes no API for the private iCal address and it is a
    // credential in URL form, so it is collected by the person, not scraped.
    return needsHuman(
      'The private calendar address has not been captured.',
      'Google exposes the private iCal address only in the calendar settings UI, and it is a credential, anyone holding it can read the calendar.',
      `Open ${spec.url ?? 'Google Calendar settings'}, pick the calendar, click "Integrate calendar", copy the address under "Secret address in iCal format", and paste it here, I will store it in the encrypted store.`,
    );
  };
}

function calendarVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const verify = deps.verifyCalendar;
    if (verify === undefined) {
      return needsHuman(
        'The calendar feed was not read.',
        'This run had no way to fetch the calendar feed, so the address is stored but unproven.',
        'Say the word and I will fetch the feed and read the events back.',
      );
    }
    const outcome = await verify();
    return outcome.ok
      ? done(outcome.detail)
      : failed('Could not read the calendar feed.', outcome.detail, 'Copy the private address again and paste it here, I will store it.');
  };
}

// ---------------------------------------------------------------------------
// Path B, OAuth
// ---------------------------------------------------------------------------

/** Remembered between the gcloud steps of a single run. */
/** Turn whichever intake route was chosen into client credentials. */
async function obtainClientCredentials(deps: GoogleSetupActionDeps): Promise<GoogleClientIntakeResult> {
  const choice: GoogleClientIntakeChoice = deps.clientIntake ?? { kind: 'console-walkthrough' };

  if (choice.kind === 'manual-entry') {
    return clientCredentialsFromInput({ clientId: choice.clientId, clientSecret: choice.clientSecret });
  }

  if (choice.kind === 'client-json-file') {
    const raw = deps.files.readText(choice.path);
    if (raw === null) {
      return {
        ok: false,
        problem: `No readable file at ${choice.path}.`,
        fix: 'Tell me the right path and I will read it, or say so and I will walk you through creating a client.',
      };
    }
    return readClientCredentialsFromJson(raw);
  }

  if (choice.kind === 'downloaded-file') {
    const scan = deps.downloadScan;
    if (scan === undefined) {
      return {
        ok: false,
        problem: 'This run cannot scan a downloads directory.',
        fix: 'Tell me where the client JSON is and I will read it from there.',
      };
    }
    const collected = collectDownloadedClientFile(scan, choice.directory, {
      ...(choice.since === undefined ? {} : { since: choice.since }),
    });
    if (!collected.ok) return { ok: false, problem: collected.problem, fix: collected.fix };
    return readClientCredentialsFromJson(collected.file.contents);
  }

  const browser = await deps.browser();
  const created = await createDesktopOAuthClient(browser, { name: 'goodvibes agent' });
  if (created.kind === 'needs-human') return { ok: false, problem: created.problem, fix: created.fix };
  if (created.kind === 'failed') return { ok: false, problem: created.problem, fix: created.fix };
  return clientCredentialsFromInput({ clientId: created.clientId, clientSecret: created.clientSecret });
}

function oauthClientRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const storedId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    if (storedId !== null && (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthClientSecret))) {
      return alreadyDone('An OAuth client is already configured.');
    }

    const intake = await obtainClientCredentials(deps);
    if (!intake.ok) {
      // A console walkthrough that stops at a sign-in or a dialog is a human
      // handoff, not a failure, the other routes are genuine failures.
      const route = deps.clientIntake?.kind ?? 'console-walkthrough';
      return route === 'console-walkthrough'
        ? needsHuman('The OAuth client was not created.', intake.problem, intake.fix)
        : failed('The OAuth client credentials could not be read.', intake.problem, intake.fix);
    }

    deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientId, intake.credentials.clientId);
    deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, GOOGLE_CONFIG_KEYS.oauthClientSecretRef);
    await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, intake.credentials.clientSecret);
    return done(`Stored the Desktop OAuth client (via ${intake.route}); the secret went to the encrypted store.`);
  };
}

/**
 * The consent exchange.
 *
 * Runs a loopback listener, opens the consent URL, and trades the returned code
 * for a refresh token. PKCE is used so the code cannot be replayed by anything
 * else that sees the redirect.
 */
function oauthAuthorizeRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    if (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken)) {
      return alreadyDone('The agent is already authorized; a refresh token is in the encrypted store.');
    }

    const clientId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    const clientSecret = await deps.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret);
    if (clientId === null || readString(clientSecret) === null) {
      return failed(
        'No OAuth client is configured.',
        'Authorization needs a client id and secret, and one or both are missing.',
        'Nothing to authorize against yet, say the word and I will set the client up first.',
      );
    }

    const secret = readString(clientSecret);
    if (secret === null) {
      return failed(
        'No OAuth client secret is stored.',
        'Authorization needs the client secret and the encrypted store does not hold one.',
        'Nothing to authorize against yet, say the word and I will set the client up first.',
      );
    }

    const pkce = generatePkcePair();
    // The `state` value is this run's CSRF token: the listener rejects any
    // redirect that does not carry it back.
    const state = base64UrlRandom();
    const listener = deps.loopback({ expectedState: state });
    try {
      const url = buildAuthorizationUrl({
        clientId,
        redirectUri: listener.redirectUri,
        // Every scope the platform's Google features need, in ONE consent.
        // Asking for mail now and calendar later is what produced a stored
        // credential that worked for mail and refused calendar.
        scopes: OAUTH_SCOPES,
        codeChallenge: pkce.codeChallenge,
        state,
        ...(deps.loginHint === undefined ? {} : { loginHint: deps.loginHint }),
      });

      // Printing beats driving. Google's sign-in wall rejects automated
      // browsers, so a printed link is both the most reliable route and the
      // smallest ask, one click, which is the entire budget for this flow.
      if (deps.announceConsentUrl !== undefined) {
        deps.announceConsentUrl(url);
      } else if (deps.openUrl !== undefined) {
        await deps.openUrl(url);
      } else {
        const browser = await deps.browser();
        await browser.navigate(url);
      }

      let code: string;
      try {
        // Rejects on mismatch, error redirect, or timeout, all of which mean
        // the person did not finish, which is a clean stop rather than a fault.
        const received = await listener.waitForCode(CONSENT_TIMEOUT_MS);
        code = received.code;
      } catch (error) {
        return needsHuman(
          'Consent was not completed.',
          `The browser did not return an authorization code: ${error instanceof Error ? error.message : String(error)}`,
          'Say so and I will start a fresh consent and hand you the link.',
        );
      }

      const tokens = await exchangeCodeForTokens(
        {
          clientId,
          clientSecret: secret,
          code,
          codeVerifier: pkce.codeVerifier,
          redirectUri: listener.redirectUri,
        },
        deps.fetchPort,
      );
      if (!tokens.ok) {
        return failed('Google refused the authorization code.', tokens.problem, tokens.fix);
      }
      // Google omits the refresh token when it has already issued one for this
      // client; without it there is nothing durable to store, so it is reported
      // rather than recorded as success.
      if (tokens.refreshToken === undefined) {
        return failed(
          'Google returned no refresh token.',
          'Google issues a refresh token only on a fresh consent, and this authorization reused an existing grant.',
          'Remove the agent at https://myaccount.google.com/permissions, then tell me and I will start a fresh consent.',
        );
      }

      await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, tokens.refreshToken);
      const warnings = safeConfigGet(deps.config, GOOGLE_CONFIG_KEYS.oauthPublishingStatus) === 'in-production'
        ? []
        : ['The app is not published, so this refresh token expires seven days after it was issued. Publish the app and authorize again.'];
      return done('Authorized. The refresh token went straight into the encrypted store.', warnings);
    } finally {
      listener.close();
    }
  };
}

/**
 * The proving step.
 *
 * "A refresh token is stored" was the old answer and it is not evidence of
 * anything a person cares about, the owner's credential was stored, reported
 * connected, and refused the first calendar call it was asked to make. So this
 * uses the credential: it reads the mailbox and reads the calendar, and says
 * what it read. Both are reads; nothing is sent and nothing is changed.
 */
function oauthVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    if (!(await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken))) {
      return failed(
        'There is no refresh token to check.',
        'Authorization did not store a refresh token, so there is nothing to verify.',
        'Say the word and I will start the consent again.',
      );
    }

    const status = safeConfigGet(deps.config, GOOGLE_CONFIG_KEYS.oauthPublishingStatus);
    const warnings = status === 'in-production'
      ? []
      : ['Publishing status is not "In production", so the stored credential expires seven days after it was issued.'];

    const prove = deps.proveConnection;
    if (prove === undefined) {
      // Stored but unproven is stated as exactly that, never as success.
      return needsHuman(
        'The credential is stored but was not proven.',
        'This run had no way to make a real Google call, so the credential is stored but nothing has confirmed it can actually read mail or calendar.',
        'Say the word and I will read your mail and calendar to prove it.',
      );
    }

    const proof = await prove();
    if (!proof.ok) {
      return failed(
        'The credential is stored but does not work yet.',
        proof.problem ?? proof.detail,
        proof.fix ?? 'Say the word and I will start a fresh consent covering mail and calendar together.',
      );
    }
    return done(proof.detail, warnings);
  };
}


// ---------------------------------------------------------------------------
// The runner map
// ---------------------------------------------------------------------------

/**
 * Bind every step of one path to the function that performs it.
 *
 * The executor throws on a missing runner, so a path is either completely bound
 * or fails loudly at the first gap, there is no silent skip.
 */
export function buildGoogleSetupRunners(
  path: GoogleSetupPath,
  deps: GoogleSetupActionDeps,
): ReadonlyMap<GoogleStepId, GoogleStepRunner> {
  const runners = new Map<GoogleStepId, GoogleStepRunner>();

  if (path === 'app-password') {
    runners.set('browser-ready', browserReadyRunner(deps));
    runners.set('google-signed-in', signedInRunner(deps));
    runners.set('two-step-verification', twoStepRunner(deps));
    runners.set('app-password', appPasswordRunner(deps));
    runners.set('gmail-config', gmailConfigRunner(deps));
    runners.set('gmail-verify', gmailVerifyRunner(deps));
    runners.set('calendar-ics-address', calendarIcsRunner(deps));
    runners.set('calendar-verify', calendarVerifyRunner(deps));
    return runners;
  }

  // The existing-client path is two steps and no gcloud state, because a
  // stored client means the project, the APIs, the branding and the audience
  // all already exist, that is what having a client id MEANS. Walking those
  // steps again is exactly the defect this path was added to remove.
  if (path === 'existing-client') {
    runners.set('oauth-authorize', oauthAuthorizeRunner(deps));
    runners.set('oauth-verify', oauthVerifyRunner(deps));
    return runners;
  }

  // The six project-and-console steps live in setup-actions-cloud-project.ts;
  // they share a gcloud detection between them, which that module owns.
  for (const [id, runner] of buildCloudProjectRunners(deps)) runners.set(id, runner);
  runners.set('oauth-client', oauthClientRunner(deps));
  runners.set('oauth-authorize', oauthAuthorizeRunner(deps));
  runners.set('oauth-verify', oauthVerifyRunner(deps));
  return runners;
}

export type { GoogleClientCredentials };

// The contracts and the adoption route moved to their own modules when this
// file outgrew the line cap. Re-exported here so every existing importer, and
// the package index, keeps resolving them from the same place.
export type { GoogleClientIntakeChoice, GoogleSetupActionDeps } from './setup-action-deps.js';
export {
  adoptExistingGoogleCredentials,
  type GoogleAdoptionOutcome,
} from './setup-actions-adoption.js';
