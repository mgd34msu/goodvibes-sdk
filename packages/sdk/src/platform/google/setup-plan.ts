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

import { ensureConnectorConfigSections } from '../config/connector-config-sections.js';
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
 * OAuth scopes requested at consent.
 *
 * ONE consent covers every Google feature the platform has. That is the whole
 * point of this list and it is why it is not shorter.
 *
 * The defect it fixes: a token was minted carrying Gmail scopes only, and the
 * first calendar call afterwards failed with "insufficient authentication
 * scopes". A grant carries exactly the scopes it was asked for, so a consent
 * that omits a scope produces a credential that looks connected, reports
 * connected, and then refuses one specific feature at the moment it is used.
 * Splitting a person's consent across two screens to save a line on the
 * permissions list is a bad trade; asking once for everything the product can
 * do is the honest one.
 *
 * Why each entry is here — every one has a live caller, none is speculative:
 *
 *  - `gmail.readonly` — `api-client.ts` reads messages through
 *    `GET gmail/v1/users/me/messages`, and `history-delta.ts` gates inbound
 *    mail on `GMAIL_HISTORY_SCOPES`. Without it inbound mail reports
 *    `no-gmail-scope` and reads nothing.
 *  - `gmail.send` — `api-client.ts` posts to `gmail/v1/users/me/messages/send`.
 *  - `calendar.events` — event read AND write, which is the one thing an app
 *    password genuinely cannot do. Narrower than full `calendar`, which would
 *    also grant calendar-list management the product never uses.
 *
 * On Google's scope tiers: `gmail.readonly` is *restricted* and the other two
 * are *sensitive*. The restricted tier matters when an app is published for
 * OTHER people's users — that is what triggers the third-party security
 * assessment. It does not apply here, because the model this connector is
 * built on is that each person creates the OAuth client in their own Google
 * Cloud account and is its only user: there is nobody for Google to vouch to,
 * the app is self-certified rather than verified, and the 100-user cap is
 * irrelevant to a one-user app. The consent screen shows the unverified-app
 * warning once, which the flow tells the person to expect.
 *
 * The guard that still applies is on WIDTH, not on tier: `gmail.modify` and
 * `https://mail.google.com/` grant deletion and full mailbox write, which
 * nothing in this product does. A test pins that neither is ever added.
 */
export const OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * Scopes this product must never request, whatever else changes.
 *
 * Both grant destructive mailbox access — `gmail.modify` can delete messages
 * and `https://mail.google.com/` is full IMAP-equivalent control. No feature
 * in this platform performs either, so requesting one would widen the blast
 * radius of a leaked credential for nothing. Exported so the guard test and
 * the runbook read the same list.
 */
export const FORBIDDEN_OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
];

/**
 * Every command invocation named in a user-facing string anywhere in this
 * connector — command AND subcommand, because the subcommand is what broke.
 *
 * This exists because of a specific failure: an error told the owner to
 * re-authorize with a missing scope by running the oauth setup subcommand, and
 * the command surface answered "Unknown setup item google". The command
 * existed; the subcommand did not. A fix line that names something which does
 * not resolve is worse than no fix line — it sends a person to a dead end
 * while sounding authoritative. Five more attempts died the same way on
 * "Unknown setting calendar".
 *
 * The contract is two-sided and both sides are tested. In this repo a test
 * scans every source file in `platform/google` for these invocations and fails
 * on one that is not listed here. In the agent repo a test walks this list and
 * fails if any entry does not resolve to a registered command with that
 * subcommand actually handled. Neither side can drift without going red.
 */
/**
 * What a turn must do when the person answers the walkthrough with values.
 *
 * The guided path walks someone to a Google console dialog and asks them to
 * copy two strings out of it. What happens next used to be "now go and type
 * /google client <id> <secret>", which is a chore handed over at the exact
 * moment the platform had everything it needed. The values ARE the answer to
 * the question the flow just asked, and a turn that receives them and asks
 * what to do with them has dropped the thread.
 *
 * Carried here, beside the step plan, so every surface that emits the
 * walkthrough emits the same contract for finishing it.
 */
export const GOOGLE_WALKTHROUGH_CONTINUATION_PROMPT = [
  'When the user pastes a Google OAuth client id and client secret, that is the continuation of this walkthrough, not a new request: register them and carry on.',
  'When they name a path to a client JSON instead, read it and carry on the same way.',
  'Registering is a local write of values they just handed over — store the secret encrypted, confirm by the client id\'s last characters only, and never echo the secret back.',
  'Answer with the consent link in the same reply, so the only thing left for them is to open it and approve.',
  'Never reply by telling them to run a command.',
].join('\n');

export const GOOGLE_REFERENCED_COMMANDS: readonly string[] = [
  '/google connect',
  '/google status',
  '/google adopt',
  '/google reauthorize',
  '/google forget',
  '/google setup',
  '/google client',
  '/google client-file',
  '/google account',
  '/google calendar-address',
  '/google runbook',
  '/email check',
  '/email config',
  '/email set',
  '/calendar refresh',
  '/calendar list',
];

/**
 * Google APIs the OAuth path enables.
 *
 * Both, now. Gmail's API used to be absent here on the reasoning that mail
 * went over IMAP/SMTP — but the platform reads mail through the Gmail API in
 * `api-client.ts` and `history-delta.ts`, and an API that is not enabled fails
 * with a service-disabled error rather than an auth error, which is a
 * genuinely confusing thing to debug. A scope without its API enabled is a
 * credential that passes every check and then refuses the first real call.
 *
 * These are enabled through gcloud with no clicking, so adding one costs the
 * person nothing.
 */
export const REQUIRED_SERVICES: readonly string[] = [
  'gmail.googleapis.com',
  'calendar-json.googleapis.com',
];


/**
 * Seed every config section this connector touches.
 *
 * All three, not just `google`. The flow writes `email.*`, `calendar.google.*`
 * and `google.oauth.*`, and ConfigManager throws on a section that is not on
 * the live config object — so seeding only `google` left the first
 * `calendar.google.clientId` write throwing "section 'calendar' does not
 * exist" in every product that did not separately carry a calendar seeder. One
 * did (goodvibes-agent, locally); the daemon, the TUI and the web UI did not,
 * which meant the connector could only ever run in one place. See
 * config/connector-config-sections.ts.
 */
export function ensureGoogleConfigDefaults(configManager: object): void {
  ensureConnectorConfigSections(configManager);
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
      'Paste it here and I will put it straight into the encrypted store — Google shows it only in this dialog.',
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
      'Tell me which Gmail address to connect as; everything else is written for you.',
      `Everything else is written for you: IMAP ${GMAIL_IMAP_HOST}:${GMAIL_IMAP_PORT}, SMTP ${GMAIL_SMTP_HOST}:${GMAIL_SMTP_PORT} with STARTTLS.`,
      'Ask what the mail settings are at any point and I will read them back.',
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
      'I open a real IMAP session and a real authenticated SMTP session and report both.',
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
      'Paste it here and I will put it in the encrypted store.',
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
      'I fetch the feed and read the events back, so the run ends having read real events rather than having stored a URL.',
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
      'The one thing in this whole flow that a person genuinely has to do in a browser. Google offers no API and no gcloud command for creating a Desktop app OAuth client — `gcloud iam oauth-clients create` exists but covers workforce identity federation only — so the Cloud console is the sole route. A Desktop app client is the right type: it permits the loopback redirect this product uses and needs no hosted redirect URL.',
    actor: 'human-assisted',
    url: AUTH_CLIENTS_URL,
    // These steps are quoted from Google's live documentation, checked on
    // 2026-08-05 rather than recalled: the Gmail API quickstart's "Authorize
    // credentials for a desktop application" and the Manage OAuth Clients help
    // page (support.google.com/cloud/answer/15549257). Two facts from that
    // check shape the wording below.
    //
    // First, the client secret is shown ONCE: "you will only be able to view
    // and download the full client secret once, at the time of its creation.
    // After the initial creation, the Google Cloud Console will only display
    // the last four characters of the client secret." So the instruction to
    // copy both values out of the creation dialog is not a nicety — miss it
    // and the client has to be recreated.
    //
    // Second, and this is why no file is mentioned anywhere here: Google's
    // current console pages do not document a "download the JSON" action for
    // OAuth client IDs at all. The Manage OAuth Clients page has no such
    // action, and the quickstart says only "Save the downloaded JSON file as
    // credentials.json" without naming the control or where it appears. We
    // could not verify those steps precisely against the live console, so the
    // guided path does not send anyone looking for a file. It uses the two
    // values the dialog definitely shows. Handing over a JSON path still works
    // and is fully supported — it is just user-directed, via /google client-file
    // <path>, never something this path talks a person into.
    manualSteps: [
      `Open ${AUTH_CLIENTS_URL}`,
      'If it asks you to register your app before continuing, do that first — Google requires it before a client can be created.',
      'Click "Create client".',
      'Application type: choose "Desktop app".',
      'In the "Name" field type: goodvibes agent — this name is only ever shown in the Cloud console.',
      'Click "Create".',
      'The "OAuth client created" dialog appears showing a Client ID and a Client secret. Copy BOTH now: Google shows the full secret only at this moment and afterwards displays just its last four characters.',
      'Paste both values here and I will register them and continue — Google shows the full secret only in this dialog, so copy it before you close it.',
    ],
    requires: ['oauth-audience-production'],
  },
  {
    id: 'oauth-authorize',
    path: 'oauth',
    // Also the whole of the existing-client path. When a client id and secret
    // are already stored, consent is the ONLY outstanding work, and this is
    // the step that collects it.
    alsoInPaths: ['existing-client'],
    title: 'Authorizing the agent',
    purpose:
      'Exchanges a one-time consent for a long-lived refresh token, which is what the agent actually uses from then on. This is the one action asked of you. The link is printed rather than driven in an automated browser: Google blocks automated browsers at its sign-in wall, and clicking a link yourself is both faster and the only thing that reliably works. Before it opens: Google will show a red "Google hasn\'t verified this app" warning. That is expected here and is not a sign anything is wrong — the app is one you created in your own Google Cloud account, and you are its only user, so there is nobody for Google to have verified it for. You will click "Advanced", then "Go to goodvibes agent (unsafe)". This happens once.',
    actor: 'human-assisted',
    manualSteps: [
      'I hand you a consent link. Open it.',
      'Check the account at the top of the consent screen. If it is not the account you want the agent to use, choose "Use another account" — approving as a personal account by reflex is the single most common way this goes wrong, and it produces a credential that fails later with no obvious cause.',
      'Expect a red warning screen saying "Google hasn\'t verified this app". This is normal for an app you created yourself and are the only user of — there is no third party for Google to have verified it on behalf of. Click "Advanced", then "Go to goodvibes agent (unsafe)".',
      'Leave every permission ticked — mail and calendar are requested together so one approval covers both — then click "Continue".',
      'The browser lands on a local page confirming the agent is connected.',
    ],
    requires: ['oauth-client'],
  },
  {
    id: 'oauth-verify',
    path: 'oauth',
    alsoInPaths: ['existing-client'],
    title: 'Reading mail and calendar to prove it works',
    purpose:
      'Storing a credential is not evidence that the credential does the job. A token can be valid and still carry the wrong scopes or belong to the wrong account, and both look exactly like success at the moment of storage — which is how a Gmail-only consent was stored as a success and then failed on the first calendar call. So this step reads the mailbox and reads the calendar with the credential just obtained, and reports what it read. Both are reads: nothing is sent, nothing is marked, no event is created.',
    actor: 'automated',
    manualSteps: [
      'I read your mailbox and your calendar with the new credential and report the account it connected as, that both answered, and the publishing status.',
      'If publishing status reads "Testing", publish the app at the audience page and tell me — I will start a fresh consent, because the existing token still expires seven days after it was issued.',
    ],
    requires: ['oauth-authorize'],
  },
];

/** Every step, all paths, in execution order. */
export const GOOGLE_SETUP_STEPS: readonly GoogleSetupStepSpec[] = [
  ...APP_PASSWORD_STEPS,
  ...OAUTH_STEPS,
];

/**
 * The ordered steps for one path, with dependencies pruned to that path.
 *
 * The pruning is what makes `existing-client` work. `oauth-authorize` requires
 * `oauth-client` on the full OAuth path, but on the existing-client path the
 * client is already stored — that is the entire premise of the path — so the
 * requirement names a step that is deliberately absent. Left unpruned, the
 * executor would see an unmet dependency and skip the only step that matters,
 * which is how a "go straight to consent" path would quietly do nothing.
 */
export function stepsForPath(path: GoogleSetupPath): readonly GoogleSetupStepSpec[] {
  const selected = GOOGLE_SETUP_STEPS.filter(
    (step) => step.path === path || (step.alsoInPaths ?? []).includes(path),
  );
  const present = new Set(selected.map((step) => step.id));
  return selected.map((step) => {
    const requires = (step.requires ?? []).filter((id) => present.has(id));
    return requires.length === (step.requires ?? []).length
      ? step
      : { ...step, requires };
  });
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
