/**
 * The runners that make the Google setup flow do something.
 *
 * `google-setup-flow.ts` sequences steps and assembles a report; it is
 * deliberately free of Google specifics and names this module as the place the
 * concrete work lives. That module was written, tested and shipped — and this
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
import type {
  GoogleBrowserPort,
  GoogleCommandPort,
  GoogleConfigPort,
  GoogleSecretPort,
  GoogleSetupPath,
  GoogleStepId,
} from './types.js';
import { createAppPassword } from './app-password-flow.js';
import { createDesktopOAuthClient, publishApp, readPublishingStatus } from './console-flow.js';
import {
  clientCredentialsFromInput,
  readClientCredentialsFromJson,
  type GoogleClientCredentials,
  type GoogleClientIntakeResult,
} from './client-intake.js';
import { collectDownloadedClientFile, type DownloadScanPort } from './client-download.js';
import {
  checkAuthenticated,
  detectGcloud,
  enableServices,
  enabledServices,
  installGcloud,
  selectOrCreateProject,
} from './gcloud.js';
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generatePkcePair,
  type GoogleFetchPort,
  type GoogleLoopbackListenerFactory,
} from './oauth-loopback.js';
import { adoptGmailMcpCredentials, type GoogleFilePort } from './credential-adoption.js';
import { looksLikeGoogleSignIn } from './browser-elements.js';

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
  /** Real IMAP/SMTP connectivity check, so `gmail-verify` proves rather than assumes. */
  readonly verifyMail?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Real calendar feed read, so `calendar-verify` proves rather than assumes. */
  readonly verifyCalendar?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  readonly now?: () => number;
}

/** Cloud project ids this flow will reuse. Keeps re-runs from piling up projects. */
const GOOGLE_PROJECT_PREFIX = 'goodvibes-agent';

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
// Path A — app password
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
    const configured = readString(deps.config.get(GOOGLE_CONFIG_KEYS.emailUsername));
    const username = configured;
    if (username === null) {
      return needsHuman(
        'The Gmail address is not known yet.',
        'Gmail needs the account address to connect over IMAP and SMTP, and nothing on this machine records which address to use.',
        'Set it, then re-run: /google account <your-address@gmail.com>',
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
        'Check it yourself with: /email check',
      );
    }
    const outcome = await verify();
    return outcome.ok
      ? done(outcome.detail)
      : failed(
        'Could not connect to Gmail.',
        outcome.detail,
        'If IMAP reports AUTHENTICATIONFAILED the app password was mistyped — create a new one with /google setup and store it again.',
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
      'Google exposes the private iCal address only in the calendar settings UI, and it is a credential — anyone holding it can read the calendar.',
      `Open ${spec.url ?? 'Google Calendar settings'}, pick the calendar, click "Integrate calendar", copy the address under "Secret address in iCal format", then store it with: /google calendar-address <url>`,
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
        'Check it yourself with: /calendar refresh, then /calendar list',
      );
    }
    const outcome = await verify();
    return outcome.ok
      ? done(outcome.detail)
      : failed('Could not read the calendar feed.', outcome.detail, 'Re-copy the private address and store it again with: /google calendar-address <url>');
  };
}

// ---------------------------------------------------------------------------
// Path B — OAuth
// ---------------------------------------------------------------------------

/** Remembered between the gcloud steps of a single run. */
interface GcloudState {
  path: string | null;
}

function gcloudInstalledRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const detection = await detectGcloud(deps.commands, deps.homeDirectory);
    if (detection.ok) {
      state.path = detection.path;
      return alreadyDone(`gcloud is already installed (${detection.version}).`);
    }
    const install = await installGcloud(deps.commands, { homeDirectory: deps.homeDirectory });
    if (!install.ok) {
      return failed('gcloud could not be installed.', install.problem, install.fix);
    }
    state.path = install.path;
    return install.outcome === 'already-installed'
      ? alreadyDone('gcloud is already installed.')
      : done(`Installed gcloud into ${install.path}.`);
  };
}

function gcloudPath(state: GcloudState): string {
  return state.path ?? 'gcloud';
}

function gcloudAuthRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const check = await checkAuthenticated(deps.commands, gcloudPath(state));
    if (check.ok) {
      return alreadyDone(`gcloud is signed in as ${check.account}.`);
    }
    return needsHuman(
      'gcloud is not signed in.',
      'gcloud needs its own sign-in before it can create a project or enable APIs, and it opens its own browser to do it.',
      'Run: gcloud auth login — choose the Google account you want the agent to use, then re-run this flow.',
    );
  };
}

function gcloudProjectRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    // The prefix is what makes this idempotent: an existing goodvibes project
    // is reused rather than a second one piling up on every re-run.
    const result = await selectOrCreateProject(deps.commands, gcloudPath(state), {
      preferredPrefix: GOOGLE_PROJECT_PREFIX,
    });
    if (!result.ok) {
      return failed('No Cloud project could be selected.', result.problem, result.fix);
    }
    deps.config.set(GOOGLE_CONFIG_KEYS.oauthProjectId, result.projectId);
    return result.outcome === 'reused'
      ? alreadyDone(`Reusing the existing Cloud project ${result.projectId}.`)
      : done(`Created the Cloud project ${result.projectId}.`);
  };
}

function apisEnabledRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const projectId = readString(deps.config.get(GOOGLE_CONFIG_KEYS.oauthProjectId));
    if (projectId === null) {
      return failed(
        'No Cloud project is recorded.',
        'The project step did not record a project id, so there is nothing to enable APIs on.',
        'Re-run the flow so the project step runs first.',
      );
    }
    const already = await enabledServices(deps.commands, gcloudPath(state), projectId);
    if (already.ok && REQUIRED_SERVICES.every((service) => already.services.includes(service))) {
      return alreadyDone(`Already enabled: ${REQUIRED_SERVICES.join(', ')}.`);
    }
    const result = await enableServices(deps.commands, gcloudPath(state), projectId, REQUIRED_SERVICES);
    if (!result.ok) {
      return failed('The required Google APIs could not be enabled.', result.problem, result.fix);
    }
    return result.enabled.length === 0
      ? alreadyDone(`Already enabled: ${result.alreadyEnabled.join(', ')}.`)
      : done(`Enabled ${result.enabled.join(', ')} on ${projectId}.`);
  };
}

function brandingRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async (spec) => {
    // Google exposes no API for the consent screen; this is one of the two
    // places a person genuinely has to click.
    const browser = await deps.browser();
    if (spec.url !== undefined) await browser.navigate(spec.url);
    return needsHuman(
      'The OAuth consent screen needs filling in.',
      'Google exposes no API for the consent screen, so it has to be completed in the browser once.',
      `The browser is open at ${spec.url ?? 'the branding page'}. Fill in the app name and your support email, choose the "External" audience, then re-run.`,
    );
  };
}

/**
 * Publishing status. This is the step that decides whether the credential
 * survives a week, so it is read from the console rather than assumed, and a
 * `testing` status is carried out as a loud warning even when the run succeeds.
 */
function audienceProductionRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    const browser = await deps.browser();
    const status = await readPublishingStatus(browser);
    if (status.kind === 'needs-human') {
      return needsHuman('The publishing status could not be read.', status.problem, status.fix);
    }
    if (status.kind === 'failed') {
      return failed('The publishing status could not be read.', status.problem, status.fix);
    }
    if (status.status === 'in-production') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'in-production');
      return alreadyDone('The app is already published, so its refresh token does not expire.');
    }

    const published = await publishApp(browser);
    if (published.kind === 'needs-human') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'testing');
      return needsHuman('The app is still in Testing.', published.problem, published.fix);
    }
    if (published.kind === 'failed') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'testing');
      return failed('The app could not be published.', published.problem, published.fix);
    }
    deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'in-production');
    return done('Published the app, so the refresh token it issues does not expire after seven days.');
  };
}

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
        fix: 'Give the path to the client JSON the Google Cloud console downloaded, or run /google setup to walk through creating one.',
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
        fix: 'Re-run pointing straight at the file: /google client-file <path-to-client.json>',
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
    const storedId = readString(deps.config.get(GOOGLE_CONFIG_KEYS.oauthClientId));
    if (storedId !== null && (await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthClientSecret))) {
      return alreadyDone('An OAuth client is already configured.');
    }

    const intake = await obtainClientCredentials(deps);
    if (!intake.ok) {
      // A console walkthrough that stops at a sign-in or a dialog is a human
      // handoff, not a failure — the other routes are genuine failures.
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

    const clientId = readString(deps.config.get(GOOGLE_CONFIG_KEYS.oauthClientId));
    const clientSecret = await deps.secrets.get(GOOGLE_SECRET_KEYS.oauthClientSecret);
    if (clientId === null || readString(clientSecret) === null) {
      return failed(
        'No OAuth client is configured.',
        'Authorization needs a client id and secret, and one or both are missing.',
        'Run the client step first: /google setup --path oauth',
      );
    }

    const secret = readString(clientSecret);
    if (secret === null) {
      return failed(
        'No OAuth client secret is stored.',
        'Authorization needs the client secret and the encrypted store does not hold one.',
        'Run the client step first: /google setup --path oauth',
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
        scopes: OAUTH_SCOPES,
        codeChallenge: pkce.codeChallenge,
        state,
      });

      if (deps.openUrl !== undefined) {
        await deps.openUrl(url);
      } else {
        const browser = await deps.browser();
        await browser.navigate(url);
      }

      let code: string;
      try {
        // Rejects on mismatch, error redirect, or timeout — all of which mean
        // the person did not finish, which is a clean stop rather than a fault.
        const received = await listener.waitForCode(CONSENT_TIMEOUT_MS);
        code = received.code;
      } catch (error) {
        return needsHuman(
          'Consent was not completed.',
          `The browser did not return an authorization code: ${error instanceof Error ? error.message : String(error)}`,
          'Re-run /google setup --path oauth and finish the Google consent screen in the browser window it opens.',
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
          'Remove the agent at https://myaccount.google.com/permissions, then re-run /google setup --path oauth.',
        );
      }

      await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, tokens.refreshToken);
      const warnings = deps.config.get(GOOGLE_CONFIG_KEYS.oauthPublishingStatus) === 'in-production'
        ? []
        : ['The app is not published, so this refresh token expires seven days after it was issued. Publish the app and authorize again.'];
      return done('Authorized. The refresh token went straight into the encrypted store.', warnings);
    } finally {
      listener.close();
    }
  };
}

function oauthVerifyRunner(deps: GoogleSetupActionDeps): GoogleStepRunner {
  return async () => {
    if (!(await secretPresent(deps.secrets, GOOGLE_SECRET_KEYS.oauthRefreshToken))) {
      return failed(
        'There is no refresh token to check.',
        'Authorization did not store a refresh token, so there is nothing to verify.',
        'Re-run: /google setup --path oauth',
      );
    }
    const status = deps.config.get(GOOGLE_CONFIG_KEYS.oauthPublishingStatus);
    const warnings = status === 'in-production'
      ? []
      : ['Publishing status is not "In production", so the stored credential expires seven days after it was issued.'];
    return done('A refresh token is stored and the OAuth path is complete.', warnings);
  };
}

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

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
}

export async function adoptExistingGoogleCredentials(deps: {
  readonly files: GoogleFilePort;
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  readonly homeDirectory: string;
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

  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientId, credentials.clientId);
  deps.config.set(GOOGLE_CONFIG_KEYS.oauthClientSecretRef, GOOGLE_CONFIG_KEYS.oauthClientSecretRef);
  await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, credentials.clientSecret);
  await deps.secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, credentials.refreshToken);

  return {
    adopted: true,
    detail: `Adopted the Google credentials already on this machine (${credentials.location}) into the encrypted store. The original files were read and left untouched.`,
    scopes: credentials.scopes,
    location: credentials.location,
  };
}

// ---------------------------------------------------------------------------
// The runner map
// ---------------------------------------------------------------------------

/**
 * Bind every step of one path to the function that performs it.
 *
 * The executor throws on a missing runner, so a path is either completely bound
 * or fails loudly at the first gap — there is no silent skip.
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

  const state: GcloudState = { path: null };
  runners.set('gcloud-installed', gcloudInstalledRunner(deps, state));
  runners.set('gcloud-authenticated', gcloudAuthRunner(deps, state));
  runners.set('gcloud-project', gcloudProjectRunner(deps, state));
  runners.set('apis-enabled', apisEnabledRunner(deps, state));
  runners.set('oauth-branding', brandingRunner(deps));
  runners.set('oauth-audience-production', audienceProductionRunner(deps));
  runners.set('oauth-client', oauthClientRunner(deps));
  runners.set('oauth-authorize', oauthAuthorizeRunner(deps));
  runners.set('oauth-verify', oauthVerifyRunner(deps));
  return runners;
}

export type { GoogleClientCredentials };
