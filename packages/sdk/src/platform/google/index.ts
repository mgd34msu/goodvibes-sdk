/**
 * @pellux/goodvibes-sdk/platform/google
 *
 * Gmail and Google Calendar as platform capability: connecting an account,
 * keeping the credential alive, and then actually reading and sending mail and
 * reading and writing events.
 *
 * This lives in the SDK rather than in any one product because every surface
 * is equally entitled to it — and because the daemon is one of those surfaces.
 * While this code sat inside a single product, the daemon had no
 * implementation to call, which is exactly why `email.send` and the calendar
 * methods shipped cataloged but `invokable: false`: there was nothing behind
 * the route. Scheduled work, triggers and channel replies could not send mail
 * at all. Hoisting it is the fix for that, not a tidy-up.
 *
 * ── Two setup paths, and they are genuinely different products ─────────────
 *
 *   Path A ("app-password") — no Google Cloud project at all. Gmail over
 *   IMAP/SMTP with a Google app password; Calendar read-only over the private
 *   iCal address. The fast lane, and the default.
 *
 *   Path B ("oauth") — a Cloud project, the Calendar API, and a Desktop OAuth
 *   client obtained through the console walkthrough, a downloaded client JSON,
 *   or pasted credentials. Needed for calendar writes.
 *
 * `setup-plan.ts` is the single source of truth for both: the executor runs
 * those records and the runbook generator renders the same records into the
 * written fallback, so automation and instructions cannot drift.
 *
 * ── Everything is injected ────────────────────────────────────────────────
 *
 * Not a single line here opens a file, binds a port, spawns a process, reads a
 * clock or drives a browser. Those arrive as ports — `GoogleBrowserPort`,
 * `GoogleCommandPort`, `GoogleConfigPort`, `GoogleSecretPort`,
 * `GoogleFilePort`, `GoogleFetchPort`, `GoogleLoopbackListenerFactory` — so
 * the entire connector, including the browser-driven Cloud Console
 * walkthrough, runs against fakes with no machine. The concrete bun/node
 * implementations live in the sibling `google/node` entry and are deliberately
 * NOT re-exported from here.
 *
 * ── Security properties this module is responsible for ────────────────────
 *
 * These are structural, not advisory, and each is load-bearing:
 *
 *  - **Delivery evidence is unforgeable.** `DeliveredRecipient` carries an
 *    unexported brand, so a `To:`/`Cc:`/`Bcc:` value — which the sender writes
 *    — cannot be passed where delivery evidence is required. There is no
 *    constructor that accepts one. Not a discouraged one. None.
 *  - **Top-most only.** Both `Delivered-To`/`X-Original-To` and
 *    `Authentication-Results` are read from index 0 and nowhere else. A sender
 *    can embed their own copies in the message they submit; those land BELOW
 *    the receiver's, and searching the list would hand the forgery back the
 *    moment a real check said `fail`.
 *  - **Sender authentication informs display, never authority.** DKIM/SPF/DMARC
 *    raise what a human reads. No branch anywhere turns one into a permission.
 *  - **Mail content is untrusted at the boundary.** Every message body carries
 *    `provenance: 'untrusted-external'` from the moment it is parsed.
 *  - **Verification expectations are scoped and single-use.** They correlate on
 *    the delivery-proven recipient address only, expire, and cannot be
 *    satisfied by a `To:` header.
 *  - **No secret reaches a message.** Tokens, client secrets, app passwords and
 *    the private iCal address are returned only in their own dedicated fields
 *    and never appear in a `detail`, `problem`, `fix` or log line.
 */

// ---------------------------------------------------------------------------
// Contracts and ports
// ---------------------------------------------------------------------------

export type {
  GoogleSetupPath,
  GoogleStepActor,
  GoogleStepOutcome,
  GoogleSetupStepSpec,
  GoogleStepId,
  GoogleStepResult,
  GoogleSetupReport,
  GoogleBrowserElement,
  GoogleBrowserPort,
  GoogleCommandResult,
  GoogleCommandPort,
  GoogleConfigPort,
  GoogleSecretPort,
  GoogleProgressPort,
} from './types.js';

// ---------------------------------------------------------------------------
// The step plan — one list, read by both the executor and the runbook
// ---------------------------------------------------------------------------

export {
  APP_PASSWORD_URL,
  TWO_STEP_URL,
  CALENDAR_SETTINGS_URL,
  AUTH_AUDIENCE_URL,
  AUTH_BRANDING_URL,
  AUTH_CLIENTS_URL,
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  APP_PASSWORD_LABEL,
  OAUTH_SCOPES,
  REQUIRED_SERVICES,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
  GOOGLE_SETUP_STEPS,
  ensureGoogleConfigDefaults,
  stepsForPath,
  stepSpec,
  runbookAnchor,
} from './setup-plan.js';

export { renderGoogleSetupRunbook, RUNBOOK_RELATIVE_PATH } from './setup-runbook.js';

export { repairHalfLandedGoogleConnection } from './connection-repair.js';
export type {
  GoogleConnectionRepairOutcome,
  GoogleConnectionRepairResult,
} from './connection-repair.js';

export {
  runGoogleSetupFlow,
  renderGoogleSetupReport,
  type GoogleStepRunner,
  type GoogleStepRunnerResult,
  type GoogleSetupFlowDeps,
} from './setup-flow.js';

export {
  detectGoogleSetupState,
  describeGoogleSetupState,
  appPasswordPathComplete,
  oauthPathComplete,
  type GoogleSetupState,
} from './setup-state.js';

export {
  buildGoogleSetupRunners,
  adoptExistingGoogleCredentials,
  type GoogleClientIntakeChoice,
  type GoogleSetupActionDeps,
  type GoogleAdoptionOutcome,
} from './setup-actions.js';

// ---------------------------------------------------------------------------
// Credentials — intake, adoption, refresh
// ---------------------------------------------------------------------------

export {
  gmailMcpLayout,
  adoptGmailMcpCredentials,
  summarizeCredentials,
  type GoogleCredentialOrigin,
  type GoogleFilePort,
  type GoogleOAuthCredentials,
  type GoogleCredentialSummary,
  type GmailMcpLayout,
} from './credential-adoption.js';

export {
  readClientCredentialsFromJson,
  clientCredentialsFromInput,
  shouldMigrateLegacyCredentials,
  LEGACY_MIGRATION_CONFIG_KEY,
  type GoogleClientCredentials,
  type GoogleClientIntakeRoute,
  type GoogleClientIntakeResult,
  type LegacyCredentialLocation,
  type LegacyMigrationOutcome,
} from './client-intake.js';

export {
  looksLikeDesktopClientJson,
  collectDownloadedClientFile,
  type DownloadScanPort,
  type CollectedClientFile,
  type CollectClientFileResult,
} from './client-download.js';

export {
  GoogleTokenManager,
  checkGoogleCredentialsAtBoot,
  type GoogleRefreshResult,
  type GoogleRefreshFailure,
  type GoogleRefreshOutcome,
  type GoogleRefreshFn,
  type GooglePersistFn,
  type GoogleTokenManagerDeps,
  type GoogleAccessToken,
  type GoogleAccessTokenOutcome,
  type GoogleBootCheckResult,
} from './token-manager.js';

export {
  buildAuthorizationUrl,
  generatePkcePair,
  exchangeCodeForTokens,
  refreshAccessToken,
  redactSecretsFromMessage,
  classifyLoopbackRedirect,
  renderLoopbackSuccessPage,
  renderLoopbackErrorPage,
  type AuthorizationUrlOptions,
  type PkcePair,
  type StartLoopbackListenerOptions,
  type LoopbackCodeResult,
  type LoopbackListener,
  type LoopbackRedirectOutcome,
  type GoogleLoopbackListenerFactory,
  type GoogleFetchPort,
  type TokenResponse,
  type TokenResponseOk,
  type TokenResponseFailed,
  type ExchangeCodeOptions,
  type RefreshTokenOptions,
} from './oauth-loopback.js';

// ---------------------------------------------------------------------------
// The live client
// ---------------------------------------------------------------------------

export {
  GoogleApiClient,
  MAIL_CONTENT_PROVENANCE,
  type GoogleApiFetchPort,
  type GoogleApiFailure,
  type GoogleApiResult,
  type GmailMessageSummary,
  type GmailMessageBody,
  type CalendarEventRecord,
  type SendMailInput,
  type CreateEventInput,
} from './api-client.js';

export {
  googleCredentialPaths,
  resolveGoogleCredentials,
  describeGoogleConnection,
  openGoogleConnection,
  type GoogleConnection,
  type GoogleConnectionSources,
} from './connection.js';

// ---------------------------------------------------------------------------
// Browser-driven pages (all against an injected GoogleBrowserPort)
// ---------------------------------------------------------------------------

export {
  createGoogleBrowserPort,
  type GoogleBrowserPortOptions,
} from './browser-port.js';

export {
  findElement,
  requireElement,
  describeElements,
  looksLikeGoogleSignIn,
  deriveTagFromRole,
  type GoogleElementQuery,
  type GoogleElementFound,
  type GoogleElementNotFound,
  type GoogleElementLookup,
} from './browser-elements.js';

export {
  createAppPassword,
  type AppPasswordReason,
  type AppPasswordOk,
  type AppPasswordNeedsHuman,
  type AppPasswordFailed,
  type CreateAppPasswordResult,
  type CreateAppPasswordOptions,
} from './app-password-flow.js';

export {
  captureIcsAddress,
  type CalendarIcsReason,
  type CalendarIcsOk,
  type CalendarIcsNeedsHuman,
  type CalendarIcsFailed,
  type CaptureIcsAddressResult,
  type CaptureIcsAddressOptions,
} from './calendar-ics-flow.js';

export {
  readPublishingStatus,
  publishApp,
  createDesktopOAuthClient,
  type PublishingStatus,
  type ConsoleReason,
  type ConsoleNeedsHuman,
  type ConsoleFailed,
  type ReadPublishingStatusOk,
  type ReadPublishingStatusResult,
  type ReadPublishingStatusOptions,
  type PublishAppOk,
  type PublishAppResult,
  type CreateDesktopOAuthClientOptions,
  type CreateOAuthClientOk,
  type CreateDesktopOAuthClientResult,
} from './console-flow.js';

// ---------------------------------------------------------------------------
// gcloud (all against an injected GoogleCommandPort)
// ---------------------------------------------------------------------------

export {
  detectGcloud,
  installGcloud,
  checkAuthenticated,
  listProjects,
  selectOrCreateProject,
  enabledServices,
  enableServices,
  GCLOUD_DEFAULT_DOWNLOAD_URL,
  GCLOUD_DEFAULT_TIMEOUT_MS,
  type GcloudDetected,
  type GcloudNotFound,
  type GcloudDetection,
  type InstallOptions,
  type InstallResult,
  type AuthAccount,
  type AuthCheckResult,
  type GcloudProject,
  type ListProjectsResult,
  type SelectOrCreateOptions,
  type SelectOrCreateResult,
  type EnabledServicesResult,
  type EnableServicesResult,
} from './gcloud.js';

// ---------------------------------------------------------------------------
// CalDAV
// ---------------------------------------------------------------------------

export {
  CalDavClient,
  type CalDavHttpPort,
  type CalDavHttpRequest,
  type CalDavHttpResponse,
  type CalDavAuth,
  type CalDavProblem,
  type CalDavResult,
  type CalDavCalendar,
  type CalDavListedEvent,
  type CalDavClientOptions,
} from './caldav-client.js';

export {
  parseMultistatus,
  isCalendarResourceType,
  parseCalendarDataEvents,
  unfoldIcsLines,
  type DavMultistatusEntry,
  type CalDavEventRecord,
} from './caldav-parse.js';

// ---------------------------------------------------------------------------
// Mail trust — the security properties named in the header
// ---------------------------------------------------------------------------

export {
  parseAuthenticationResults,
  readSenderAuthentication,
  hasAnySenderVerdict,
  type SenderProtocolResult,
  type SenderAuthenticationChecks,
} from './sender-authentication.js';

export {
  normalizeDeliveryAddress,
  deliveredRecipientFromAliasMailbox,
  deliveredRecipientFromDeliveryHeaders,
  bestDeliveryEvidence,
  deliveryEvidenceFromMessage,
  describeDeliveryEvidence,
  NO_ALIAS_MAILBOXES,
  type DeliveryEvidenceSource,
  type DeliveredRecipient,
} from './delivery-evidence.js';

export {
  VerificationExpectationBook,
  extractVerification,
  hostMatchesServiceDomain,
  DEFAULT_VERIFICATION_WINDOW_MS,
  MAX_VERIFICATION_WINDOW_MS,
  MIN_VERIFICATION_WINDOW_MS,
  MAX_OPEN_EXPECTATIONS,
  type VerificationExpectation,
  type OpenExpectationInput,
  type CandidateEmail,
  type UntrustedDisplayText,
  type SurfaceAuthorityProbe,
  type VerificationMatch,
  type VerificationArtifact,
  type VerificationExtraction,
  type MatchOptions,
} from './verification-expectations.js';

export {
  normalizeEmailAddress,
  splitAddress,
  normalizeDomain,
  mintAddressFor,
  mintCatchAllAddressFor,
  parseAlias,
  type SignupAlias,
  type ParsedSignupAlias,
  type MintAddressOptions,
} from './signup-address.js';

export {
  AgentAccountRegistry,
  ACCOUNT_REGISTRY_PATH_SEGMENTS,
  MAX_ACCOUNT_RECORDS,
  registerSignupBaseAddressFallback,
  resolveSignupBaseAddress,
  type SignupBaseAddressSource,
  type AgentAccountRecord,
  type AgentAccountCreateInput,
  type AgentAccountSweepInput,
  type AgentAccountSweepResult,
  type AgentAccountSnapshot,
  type AgentAccountRegistryOptions,
  type SecretLikeTextPredicate,
} from './account-registry.js';
