/**
 * schema-domain-connectors.ts, the mail and calendar connector's config
 * (`email.*`, `calendar.*`, `google.*`).
 *
 * ── What failed before this file existed ──────────────────────────────────
 *
 * The daemon really stores these keys, a Gmail app password reference, an
 * OAuth client id and secret reference, the private calendar feed address,
 * under exactly these paths, seeded at runtime onto the live config object by
 * `connector-config-sections.ts` (a structural cast that bypasses
 * `CONFIG_SCHEMA`/`DEFAULT_CONFIG` entirely, because `email`, `calendar` and
 * `google` were never CONFIG_SCHEMA categories). Nothing else about them was
 * declared anywhere.
 *
 * The settings surface's whole authority is `isValidConfigKey` /
 * `configManager.getSchema()`, both of which read `CONFIG_SCHEMA`
 * (schema.ts). A key absent from `CONFIG_SCHEMA` is "Unknown setting", full
 * stop, so the agent's settings surface answered "Unknown setting
 * calendar.google.clientId" for a key the daemon reads and writes every time
 * it composes mail or refreshes a calendar, and a catalog query for
 * `google.oauth.refreshToken` matched 0 of the schema's rows. A connection
 * the daemon had genuinely made was invisible to the one place an operator
 * would look to confirm it.
 *
 * This is the same migration `config-ownership.ts` already records for
 * `surfaces.email.*` / `surfaces.calendar.*` (see its trailing comment,
 * schema-domain-daemon-mailbox.ts): promoting an app-layer section seeded by
 * a cast into real, schema-registered, described settings makes the key
 * daemon-owned, renders it in the settings modal, and puts it in the walk
 * that `listDaemonOwnedConfigPaths()` derives credential names from. Doing
 * it here removes 19 of the paths `config-ownership.ts` used to have to hand-
 * enumerate on `DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS` because nothing else
 * declared them.
 *
 * ── Why `calendar.google.icsUrl` is added here too ────────────────────────
 *
 * It was always a real daemon-owned path (`config-ownership.ts`'s non-schema
 * list carried it), but `connector-config-sections.ts`'s seed defaults never
 * included it, a section shape and its schema now have to agree, so it is
 * added to both in this change.
 *
 * ── Why these are a different domain from `surfaces.email.*` /
 *    `surfaces.calendar.*` ─────────────────────────────────────────────────
 *
 * `surfaces.email.*` (schema-domain-daemon-mailbox.ts) is read by the
 * inbound-mail watcher. `email.*` here is the connector `EmailService`
 * composes, sends and lists mail through (see
 * `control-plane/routes/email-composition.ts`, "the daemon's own mailbox").
 * Both are real, both are read in production, and unifying them is a
 * separate piece of work from giving each one a real schema row, this
 * change does the latter only, for the keys `connector-config-sections.ts`
 * already seeds.
 *
 * ── Secret-bearing rows ────────────────────────────────────────────────────
 *
 * `email.passwordRef`, `email.smtpPasswordRef`, `calendar.google.clientSecretRef`,
 * `calendar.microsoft.clientSecretRef`, `calendar.google.icsUrl` and
 * `google.oauth.refreshToken` are declared in
 * `secret-bearing-config-keys.ts` (`SECRET_BEARING_CONFIG_PATHS`) already,
 * that is what routes a write into the encrypted secret store and masks a
 * render. Each row's own description says so, the same house phrasing
 * `surfaces.email.password` / `surfaces.calendar.caldavPassword` use in
 * schema-domain-daemon-mailbox.ts: the value held here is a reference into
 * the secret store, and the secret itself is never held in config.
 */
import { type ConfigSettingDefinition } from './schema-shared.js';
import type {
  CalendarConnectorConfig,
  EmailConnectorConfig,
  GoogleConnectorConfig,
} from './schema-types-connectors.js';

export type {
  CalendarConnectorConfig,
  CalendarConnectorProviderConfig,
  EmailConnectorConfig,
  EmailConnectorImapSecurity,
  EmailConnectorSmtpSecurity,
  GoogleConnectorConfig,
} from './schema-types-connectors.js';

declare module './schema-types.js' {
  interface GoodVibesConfig {
    email: EmailConnectorConfig;
    calendar: CalendarConnectorConfig;
    google: GoogleConnectorConfig;
  }
}

/** Defaults for the connector's `email` section: an IMAP/SMTP mailbox and where its password is kept. */
const EMAIL_CONNECTOR_DEFAULTS: EmailConnectorConfig = {
  enabled: false,
  imapHost: '',
  imapPort: 993,
  imapSecurity: 'tls',
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'auto',
  username: '',
  passwordRef: '',
  smtpPasswordRef: '',
  fromAddress: '',
  mailbox: '',
  draftsMailbox: '',
};

/** Defaults for the connector's `calendar` section: one entry per OAuth calendar provider. */
const CALENDAR_CONNECTOR_DEFAULTS: CalendarConnectorConfig = {
  google: { clientId: '', clientSecretRef: '', icsUrl: '' },
  microsoft: { clientId: '', clientSecretRef: '' },
};

/** Defaults for the connector's `google` section: the Cloud project and the OAuth app's state. */
const GOOGLE_CONNECTOR_DEFAULTS: GoogleConnectorConfig = {
  oauth: { projectId: '', publishingStatus: '', refreshToken: '' },
  credentials: { migratedFrom: '' },
};

export const connectorConfigDefaults: {
  email: EmailConnectorConfig;
  calendar: CalendarConnectorConfig;
  google: GoogleConnectorConfig;
} = {
  email: EMAIL_CONNECTOR_DEFAULTS,
  calendar: CALENDAR_CONNECTOR_DEFAULTS,
  google: GOOGLE_CONNECTOR_DEFAULTS,
};

export const connectorConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'email.enabled',
    type: 'boolean',
    default: false,
    description:
      'Turns on the mail connector: the account the daemon composes, sends and lists mail through. Off by default, a mailbox is only usable once host, username and a stored password reference are set below.',
  },
  {
    key: 'email.imapHost',
    type: 'string',
    default: '',
    description: 'IMAP hostname the connector reads from, e.g. imap.gmail.com',
  },
  {
    key: 'email.imapPort',
    type: 'number',
    default: 993,
    description: 'IMAP port the connector reads from',
  },
  {
    key: 'email.imapSecurity',
    type: 'enum',
    default: 'tls',
    description:
      'IMAP connection security. "tls" is implicit TLS on the IMAP port and is the safe default; "plaintext" is an unencrypted connection, legitimate only for a localhost or test server. There is no "auto" here, the operator either asks for TLS or asks not to have it.',
    enumValues: ['tls', 'plaintext'],
  },
  {
    key: 'email.smtpHost',
    type: 'string',
    default: '',
    description: 'SMTP submission hostname the connector sends through, e.g. smtp.gmail.com',
  },
  {
    key: 'email.smtpPort',
    type: 'number',
    default: 587,
    description: 'SMTP port the connector sends through: 465 for implicit TLS, or 587 (the default) for STARTTLS',
  },
  {
    key: 'email.smtpSecurity',
    type: 'enum',
    default: 'auto',
    description:
      '"auto" (the default) picks implicit TLS on port 465 and STARTTLS everywhere else. "tls" and "starttls" force one of the two regardless of port, for a provider whose port does not match the usual convention.',
    enumValues: ['auto', 'tls', 'starttls'],
  },
  {
    key: 'email.username',
    type: 'string',
    default: '',
    description: 'Login username the connector authenticates as, on both IMAP and SMTP',
  },
  {
    key: 'email.passwordRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store (goodvibes://secrets/...) naming the mailbox password or app password, never a raw password. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'email.smtpPasswordRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store for the SMTP password, only when the provider issues one that differs from the IMAP password. Empty, the common case, means submission authenticates with email.passwordRef like everything else. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'email.fromAddress',
    type: 'string',
    default: '',
    description: 'From: address on mail the connector sends; usually the same address as email.username',
  },
  {
    key: 'email.mailbox',
    type: 'string',
    default: '',
    description: 'Mailbox to read. Empty, the common case, means INBOX. Set when the account delivers to a folder, such as a per-signup alias mailbox.',
  },
  {
    key: 'email.draftsMailbox',
    type: 'string',
    default: '',
    description: 'Drafts folder. Empty means ask the server, which is the better answer for a provider like Gmail whose Drafts folder is not literally named "Drafts". Set only when the server does not advertise one.',
  },
  {
    key: 'calendar.google.clientId',
    type: 'string',
    default: '',
    description: 'The OAuth client id for a Google Calendar app registered by whoever set up this environment. Client ids are not secrets (RFC 8252) and are stored in plain config.',
  },
  {
    key: 'calendar.google.clientSecretRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the Google OAuth client secret, needed only for a confidential (Web-app) client registration, a Desktop-app client using PKCE needs none. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'calendar.google.icsUrl',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the private calendar feed address (the "secret address in iCal format" from Google Calendar\'s Integrate Calendar settings). It is a URL rather than a password, but it grants read access to the operator\'s calendar to anyone holding it, so it is treated as a credential: the address itself is stored in the daemon secret tier, never in config. This is the read-only, credential-free route used when an app password is the mail connection, Google refuses Basic authentication on its CalDAV endpoint, so an app password cannot reach Calendar that way. Calendar writes require the OAuth path (calendar.google.clientId and the refresh token below).',
  },
  {
    key: 'calendar.microsoft.clientId',
    type: 'string',
    default: '',
    description: 'The OAuth client id for a Microsoft Entra app registration, for connecting an Outlook calendar. Client ids are not secrets and are stored in plain config.',
  },
  {
    key: 'calendar.microsoft.clientSecretRef',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the Microsoft OAuth client secret, needed only for a confidential registration, a public client with "Allow public client flows" enabled needs none. The secret itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'google.oauth.projectId',
    type: 'string',
    default: '',
    description: 'The Google Cloud project id the OAuth calendar client and its enabled APIs belong to, recorded so a re-run reuses the same project instead of creating another one.',
  },
  {
    key: 'google.oauth.publishingStatus',
    type: 'string',
    default: '',
    description:
      'The OAuth consent screen\'s last-known publishing status ("testing" or "in-production"), cached after being read from the Cloud Console since it cannot be probed any other way. An app left in "Testing" is issued refresh tokens that expire after seven days; moving it to "In production" (self-certified, no Google review needed) removes that expiry. Empty until a setup or verification run has read it.',
  },
  {
    key: 'google.oauth.refreshToken',
    type: 'string',
    default: '',
    description:
      'A reference into the secret store naming the long-lived OAuth refresh token the calendar connector authenticates with after the one-time authorization. The token itself is stored in the daemon secret tier, never in config.',
  },
  {
    key: 'google.credentials.migratedFrom',
    type: 'string',
    default: '',
    description:
      'Marker recording that a legacy on-disk Google credential (from before credentials lived in the encrypted secret store) was already migrated in, so migration is not repeated on every start. Names where it came from; holds no credential value itself.',
  },
];
