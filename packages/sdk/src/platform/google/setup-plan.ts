/**
 * The single source of truth for both Google setup paths.
 *
 * The executor (`google-setup-flow.ts`) runs these steps in order. The runbook
 * generator (`google-setup-runbook.ts`) renders the very same records into the
 * written fallback in `docs/google-setup-runbook.md`. Because there is exactly
 * one list, the automation and the written instructions cannot drift; a test
 * regenerates the doc and fails if the checked-in copy is stale.
 *
 * Facts encoded here were verified against Google's live documentation on
 * 2026-07-26, not from memory. The two that shape the design:
 *
 *  1. Google's CalDAV endpoint refuses HTTP Basic authentication outright.
 *     "The CalDAV server refuses to authenticate a request unless it arrives
 *     over HTTPS with OAuth 2.0 authentication of a Google Account. Attempting
 *     to connect over HTTP or using Basic Authentication results in an HTTP
 *     401 Unauthorized status code."
 *     — https://developers.google.com/workspace/calendar/caldav/v2/guide
 *     So an app password cannot reach Google Calendar over CalDAV. The
 *     app-password path uses the private iCal address instead, which is
 *     read-only. Calendar writes require Path B.
 *
 *  2. An OAuth app left in "Testing" publishing status issues refresh tokens
 *     that expire after seven days: "A Google Cloud Platform project with an
 *     OAuth consent screen configured for an external user type and a
 *     publishing status of 'Testing' is issued a refresh token expiring in 7
 *     days." — https://developers.google.com/identity/protocols/oauth2
 *     The exemption for openid/email/profile-only apps does not apply to us;
 *     Gmail and Calendar scopes are sensitive or restricted. Path B therefore
 *     treats reaching "In production" as a first-class, verified step.
 */

import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import type { GoogleSetupStepSpec, GoogleStepId, GoogleSetupPath } from './types.js';

/** Where the human creates an app password. Requires 2-Step Verification. */
export const APP_PASSWORD_URL = 'https://myaccount.google.com/apppasswords';

/** 2-Step Verification settings. */
export const TWO_STEP_URL = 'https://myaccount.google.com/signinoptions/twosv';

/** Google Calendar settings root; per-calendar "Integrate calendar" holds the iCal address. */
export const CALENDAR_SETTINGS_URL = 'https://calendar.google.com/calendar/u/0/r/settings';

/** Google Auth Platform — audience tab, where publishing status is changed. */
export const AUTH_AUDIENCE_URL = 'https://console.cloud.google.com/auth/audience';

/** Google Auth Platform — branding tab (app name, support email). */
export const AUTH_BRANDING_URL = 'https://console.cloud.google.com/auth/branding';

/** Google Auth Platform — clients tab, where the Desktop app client is created. */
export const AUTH_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';

/** Gmail IMAP/SMTP endpoints, per Google's IMAP/SMTP guide. */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;
export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 587;

/** The label the app password is created under, so re-runs can find it again. */
export const APP_PASSWORD_LABEL = 'goodvibes-agent';

/**
 * OAuth scopes requested by Path B.
 *
 * Deliberately just one, and deliberately not a Gmail scope. Google classes
 * `gmail.readonly`, `gmail.modify`, `gmail.metadata`, `gmail.compose` and
 * `https://mail.google.com/` as *restricted*, and a restricted scope forces a
 * third-party security assessment that the publisher pays for and must repeat
 * every twelve months. Calendar scopes are merely *sensitive*: ordinary
 * review, no assessment, no annual renewal.
 *
 * So mail is reached over IMAP/SMTP with an app password — which is not an
 * OAuth grant at all and sits entirely outside the verification regime — and
 * OAuth is used only for the one thing an app password genuinely cannot do,
 * which is write to the calendar. `calendar.events` rather than full
 * `calendar` because it is the narrowest scope that still delivers event
 * read and write, and Google requires justifying why a narrower scope would
 * not have sufficed.
 *
 * Full reasoning, with sources: docs/google-scope-strategy.md
 * Adding a restricted scope here is a recurring five-figure decision, not a
 * detail — a test in google-setup-flow.test.ts guards against it.
 */
export const OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Google APIs the OAuth path enables. Gmail's API is deliberately absent —
 * mail goes over IMAP/SMTP, so the project never needs it enabled.
 */
export const REQUIRED_SERVICES: readonly string[] = [
  'calendar-json.googleapis.com',
];

/**
 * Default (empty) `google` config section, seeded so get()/setDynamic() resolve
 * the nested path.
 *
 * ConfigManager.resolvePath() walks the live config object and throws
 * "Invalid config path" for any section that does not exist, and `google` is an
 * app-layer category absent from the SDK schema. Nothing called the connector,
 * so nothing ever hit that — `/google status` threw on its first real run.
 *
 * Mirrors ensureEmailConfigDefaults and ensureCalendarConfigDefaults, the
 * sanctioned pattern for this.
 */
const GOOGLE_CONFIG_DEFAULTS = {
  oauth: { projectId: '', publishingStatus: '', refreshToken: '' },
  credentials: { migratedFrom: '' },
};

/** Seed the google config section on the real ConfigManager if absent. */
export function ensureGoogleConfigDefaults(configManager: object): void {
  const cm = configManager as unknown as { config?: Record<string, unknown> };
  if (cm.config && !('google' in cm.config)) {
    cm.config['google'] = structuredClone(GOOGLE_CONFIG_DEFAULTS);
  }
}

/** Config keys written by the app-password path. */
export const GOOGLE_CONFIG_KEYS = {
  emailEnabled: 'email.enabled',
  emailImapHost: 'email.imapHost',
  emailImapPort: 'email.imapPort',
  emailSmtpHost: 'email.smtpHost',
  emailSmtpPort: 'email.smtpPort',
  emailSmtpSecurity: 'email.smtpSecurity',
  emailUsername: 'email.username',
  emailFromAddress: 'email.fromAddress',
  emailPasswordRef: 'email.passwordRef',
  oauthClientId: 'calendar.google.clientId',
  oauthClientSecretRef: 'calendar.google.clientSecretRef',
  oauthProjectId: 'google.oauth.projectId',
  oauthPublishingStatus: 'google.oauth.publishingStatus',
  oauthRefreshToken: 'google.oauth.refreshToken',
  calendarIcsUrl: 'calendar.google.icsUrl',
} as const;

/** Secret-store keys. Values live only in the encrypted store. */
/**
 * Secret-store names, DERIVED from the config paths above rather than written
 * out by hand.
 *
 * The derivation is the platform-wide one — literally `daemonSecretKeyFor`,
 * the same function the daemon uses — and matching it is load-bearing rather
 * than cosmetic: the daemon decides which credentials it owns, and therefore
 * which replicate to another node, by deriving names from daemon-owned config
 * paths with exactly this call. A hand-written name like
 * `goodvibes.email.passwordRef` matches nothing that derivation produces, so
 * the credential would silently sit outside daemon ownership and fail to
 * follow a handover. The symptom would be email going quiet on the node that
 * took over, with nothing in the logs to explain it.
 */
export const GOOGLE_SECRET_KEYS = {
  appPassword: daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.emailPasswordRef),
  oauthClientSecret: daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.oauthClientSecretRef),
  oauthRefreshToken: daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.oauthRefreshToken),
  calendarIcsUrl: daemonSecretKeyFor(GOOGLE_CONFIG_KEYS.calendarIcsUrl),
} as const;

// ---------------------------------------------------------------------------
// Path A — app password
// ---------------------------------------------------------------------------

const APP_PASSWORD_STEPS: readonly GoogleSetupStepSpec[] = [
  {
    id: 'browser-ready',
    path: 'app-password',
    title: 'Making sure a browser is available',
    purpose:
      'The app password and the calendar address both live behind pages Google exposes through no API, so they have to be read out of a real browser.',
    actor: 'automated',
    manualSteps: [
      'No action needed — this only matters to the automated flow. If you are following this runbook by hand, use whatever browser you normally use.',
    ],
  },
  {
    id: 'google-signed-in',
    path: 'app-password',
    title: 'Checking you are signed in to Google',
    purpose:
      'Google blocks automated browsers at its sign-in screen ("this browser or app may not be secure"), so the sign-in is done by hand exactly once. The browser profile is persistent, so it stays signed in for every later run.',
    actor: 'human-assisted',
    url: APP_PASSWORD_URL,
    manualSteps: [
      'A browser window will open. If it shows a Google sign-in page, sign in with the Google account you want the agent to use.',
      'Complete any 2-Step Verification prompt on your phone.',
      'Leave the window open and re-run the command. The sign-in is remembered from now on.',
    ],
    requires: ['browser-ready'],
  },
  {
    id: 'two-step-verification',
    path: 'app-password',
    title: 'Checking 2-Step Verification is on',
    purpose:
      'Google only offers app passwords on accounts with 2-Step Verification enabled. Without it the app password page is unavailable and this whole path is blocked.',
    actor: 'human-assisted',
    url: TWO_STEP_URL,
    manualSteps: [
      `Open ${TWO_STEP_URL}`,
      'If it says 2-Step Verification is off, click "Turn on 2-Step Verification" and follow the prompts (a phone number or an authenticator app is enough).',
      'Once it reports 2-Step Verification is on, continue.',
    ],
    requires: ['google-signed-in'],
  },
  {
    id: 'app-password',
    path: 'app-password',
    title: 'Creating the app password',
    purpose:
      'A 16-character app password lets Gmail be reached over IMAP and SMTP with no Google Cloud project, no OAuth client and no token that expires.',
    actor: 'automated',
    url: APP_PASSWORD_URL,
    manualSteps: [
      `Open ${APP_PASSWORD_URL}`,
      `In the "App name" box type: ${APP_PASSWORD_LABEL}`,
      'Click "Create".',
      'Google shows a 16-character password in a yellow box. Copy it. You cannot see it again after closing the dialog.',
      'Store it with: goodvibes-agent secret set GOODVIBES_EMAIL_PASSWORD_REF',
    ],
    requires: ['two-step-verification'],
  },
  {
    id: 'gmail-config',
    path: 'app-password',
    title: 'Pointing the mail surface at Gmail',
    purpose: 'Writes the Gmail IMAP and SMTP endpoints into config so the mail surface knows where to connect.',
    actor: 'automated',
    manualSteps: [
      `goodvibes-agent config set email.imapHost ${GMAIL_IMAP_HOST}`,
      `goodvibes-agent config set email.imapPort ${GMAIL_IMAP_PORT}`,
      `goodvibes-agent config set email.smtpHost ${GMAIL_SMTP_HOST}`,
      `goodvibes-agent config set email.smtpPort ${GMAIL_SMTP_PORT}`,
      'goodvibes-agent config set email.smtpSecurity starttls',
      'goodvibes-agent config set email.username <your-address@gmail.com>',
      'goodvibes-agent config set email.fromAddress <your-address@gmail.com>',
      'goodvibes-agent config set email.enabled true',
    ],
    requires: ['app-password'],
  },
  {
    id: 'gmail-verify',
    path: 'app-password',
    title: 'Connecting to Gmail over IMAP and SMTP',
    purpose:
      'Proves the credential actually works by opening a real IMAP session and a real authenticated SMTP session. Nothing is sent and nothing is marked read.',
    actor: 'automated',
    manualSteps: [
      'goodvibes-agent email test',
      'A successful run reports both the IMAP and the SMTP stage as connected.',
      'If IMAP fails with AUTHENTICATIONFAILED, the app password was mistyped — create a new one and store it again.',
    ],
    requires: ['gmail-config'],
  },
  {
    id: 'calendar-ics-address',
    path: 'app-password',
    title: 'Capturing the private calendar address',
    purpose:
      'Google refuses Basic authentication on its CalDAV endpoint, so an app password cannot reach Calendar that way. The private iCal address is the credential-free route that does work. It is read-only; calendar writes need the OAuth path.',
    actor: 'automated',
    url: CALENDAR_SETTINGS_URL,
    manualSteps: [
      `Open ${CALENDAR_SETTINGS_URL}`,
      'In the left panel under "Settings for my calendars", click the calendar you want.',
      'Click "Integrate calendar".',
      'Under "Secret address in iCal format", click the copy button.',
      'Store it with: goodvibes-agent secret set GOODVIBES_CALENDAR_GOOGLE_ICS_URL',
      'Treat this URL as a password — anyone holding it can read your calendar.',
    ],
    requires: ['google-signed-in'],
  },
  {
    id: 'calendar-verify',
    path: 'app-password',
    title: 'Reading calendar events',
    purpose: 'Fetches and parses the calendar feed so the run ends having actually read real events, not just stored a URL.',
    actor: 'automated',
    manualSteps: [
      'goodvibes-agent calendar refresh',
      'goodvibes-agent calendar list',
      'A successful run prints upcoming events from the subscribed feed.',
    ],
    requires: ['calendar-ics-address'],
  },
];

// ---------------------------------------------------------------------------
// Path B — OAuth
// ---------------------------------------------------------------------------

const OAUTH_STEPS: readonly GoogleSetupStepSpec[] = [
  {
    id: 'gcloud-installed',
    path: 'oauth',
    title: 'Making sure gcloud is installed',
    purpose: 'The project and API-enablement steps are scriptable through gcloud, which keeps the console clicking down to the two things Google exposes no API for.',
    actor: 'automated',
    manualSteps: [
      'Check whether it is already there: gcloud --version',
      'If it is missing, install it into your home directory without root:',
      '  curl -sSLO https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz',
      '  tar -xzf google-cloud-cli-linux-x86_64.tar.gz -C "$HOME"',
      '  "$HOME/google-cloud-sdk/install.sh" --quiet',
      '  export PATH="$HOME/google-cloud-sdk/bin:$PATH"',
    ],
  },
  {
    id: 'gcloud-authenticated',
    path: 'oauth',
    title: 'Signing gcloud in to your Google account',
    purpose: 'gcloud needs its own sign-in before it can create a project or enable APIs.',
    actor: 'human-assisted',
    manualSteps: [
      'gcloud auth login',
      'A browser opens. Choose the Google account you want the agent to use, then click "Allow".',
      'Confirm it worked: gcloud auth list',
    ],
    requires: ['gcloud-installed'],
  },
  {
    id: 'gcloud-project',
    path: 'oauth',
    title: 'Selecting or creating the Cloud project',
    purpose: 'Every OAuth client belongs to a Cloud project. An existing project is reused rather than piling up new ones on re-runs.',
    actor: 'automated',
    manualSteps: [
      'List what you already have: gcloud projects list',
      'To reuse one: gcloud config set project <PROJECT_ID>',
      'To make a new one: gcloud projects create goodvibes-agent-<random> --name="goodvibes agent"',
      'Then: gcloud config set project <PROJECT_ID>',
    ],
    requires: ['gcloud-authenticated'],
  },
  {
    id: 'apis-enabled',
    path: 'oauth',
    title: 'Enabling the Gmail and Calendar APIs',
    purpose: 'Without these two services enabled on the project, every API call fails with a service-disabled error rather than an auth error, which is confusing to debug.',
    actor: 'automated',
    manualSteps: [
      `gcloud services enable ${REQUIRED_SERVICES.join(' ')}`,
      `Confirm: gcloud services list --enabled --filter="${REQUIRED_SERVICES[0]}"`,
    ],
    requires: ['gcloud-project'],
  },
  {
    id: 'oauth-branding',
    path: 'oauth',
    title: 'Filling in the OAuth consent screen',
    purpose:
      'Google exposes no API for the consent screen, so this is one of the two places the browser has to be driven. Without it the client cannot be created.',
    actor: 'human-assisted',
    url: AUTH_BRANDING_URL,
    manualSteps: [
      `Open ${AUTH_BRANDING_URL}`,
      'If prompted, click "Get started".',
      'App name: goodvibes agent',
      'User support email: your own address',
      'Audience: choose "External".',
      'Contact email: your own address',
      'Agree to the user data policy and click "Create".',
    ],
    requires: ['apis-enabled'],
  },
  {
    id: 'oauth-audience-production',
    path: 'oauth',
    title: 'Setting publishing status to In production',
    purpose:
      'This is the step that decides whether the integration keeps working. An app left in "Testing" is issued refresh tokens that expire after seven days, so the integration dies once a week and does so silently. Moving to "In production" removes that expiry. It is self-certified: no Google review is needed, you just click through an "unverified app" warning once when you authorize.',
    actor: 'human-assisted',
    url: AUTH_AUDIENCE_URL,
    manualSteps: [
      `Open ${AUTH_AUDIENCE_URL}`,
      'Find the "Publishing status" box. If it reads "Testing", click "PUBLISH APP".',
      'A dialog asks you to confirm pushing the app to production. Click "Confirm".',
      'The status box must now read "In production". If it still reads "Testing", the credential you create next will stop working in seven days.',
      'You do not need to submit for verification. Sensitive and restricted scopes on an unverified app still work for personal use, capped by Google at 100 users.',
    ],
    requires: ['oauth-branding'],
  },
  {
    id: 'oauth-client',
    path: 'oauth',
    title: 'Creating the Desktop app OAuth client',
    purpose:
      'The second thing Google exposes no API for. A Desktop app client is the right type: it permits the loopback redirect the agent uses and needs no hosted redirect URL.',
    actor: 'human-assisted',
    url: AUTH_CLIENTS_URL,
    manualSteps: [
      `Open ${AUTH_CLIENTS_URL}`,
      'Click "CREATE CLIENT".',
      'Application type: choose "Desktop app".',
      'Name: goodvibes agent',
      'Click "Create".',
      'A dialog shows the Client ID and Client secret. Copy both.',
      'Store them with:',
      '  goodvibes-agent config set calendar.google.clientId <CLIENT_ID>',
      '  goodvibes-agent secret set GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF',
    ],
    requires: ['oauth-audience-production'],
  },
  {
    id: 'oauth-authorize',
    path: 'oauth',
    title: 'Authorizing the agent',
    purpose:
      'Exchanges a one-time consent for a long-lived refresh token, which is what the agent actually uses from then on. Before it opens: Google will show a red "Google hasn\'t verified this app" warning. That is expected here and is not a sign anything is wrong — the app is one you just created in your own Google Cloud account, and you are its only user, so there is nobody for Google to have verified it for. You will click "Advanced", then "Go to goodvibes agent (unsafe)". This happens once.',
    actor: 'human-assisted',
    manualSteps: [
      '/google setup --path oauth',
      'A browser opens on a Google consent screen.',
      'Expect a red warning screen saying "Google hasn\'t verified this app". This is normal for an app you created yourself and are the only user of — there is no third party for Google to have verified it on behalf of.',
      'Because the app is self-certified rather than Google-verified, you will see "Google hasn\'t verified this app". Click "Advanced", then "Go to goodvibes agent (unsafe)". This is expected for a personal install and only happens once.',
      'Tick the Gmail and Calendar permissions, then click "Continue".',
      'The browser lands on a local page confirming the agent is connected.',
    ],
    requires: ['oauth-client'],
  },
  {
    id: 'oauth-verify',
    path: 'oauth',
    title: 'Checking the credential and its lifetime',
    purpose:
      'Confirms the refresh token works by making a real API call, and re-reads the publishing status so a seven-day-expiry credential is reported loudly instead of discovered a week later.',
    actor: 'automated',
    manualSteps: [
      '/google status',
      'A successful run reports the account it connected as and the publishing status.',
      'If publishing status reads "Testing", go back to the audience page and publish the app, then authorize again — the existing token still expires.',
    ],
    requires: ['oauth-authorize'],
  },
];

/** Every step, both paths, in execution order. */
export const GOOGLE_SETUP_STEPS: readonly GoogleSetupStepSpec[] = [
  ...APP_PASSWORD_STEPS,
  ...OAUTH_STEPS,
];

/** The ordered steps for one path. */
export function stepsForPath(path: GoogleSetupPath): readonly GoogleSetupStepSpec[] {
  return GOOGLE_SETUP_STEPS.filter((step) => step.path === path);
}

/** Look up one step by id. Throws on an unknown id so typos fail loudly. */
export function stepSpec(id: GoogleStepId): GoogleSetupStepSpec {
  const found = GOOGLE_SETUP_STEPS.find((step) => step.id === id);
  if (!found) {
    throw new Error(`Unknown Google setup step: ${id}`);
  }
  return found;
}

/** The anchor a step's section carries in the generated runbook. */
export function runbookAnchor(id: GoogleStepId): string {
  return `#${id}`;
}
