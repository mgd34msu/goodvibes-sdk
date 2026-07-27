/**
 * schema-domain-daemon-mailbox.ts — the daemon's OWN mailbox and calendar.
 *
 * These keys live under `surfaces.` and so ride the surface domain's ownership
 * rule, but they are not a chat adapter and they do not belong beside Slack,
 * Discord and Telegram: those describe an external service the daemon talks
 * TO, while these describe the mail account and calendar the daemon speaks AS.
 * Splitting them out keeps `schema-domain-surfaces.ts` a list of adapters and
 * gives this pair a file whose header can say what they are for.
 *
 * ── Why they are declared at all ──────────────────────────────────────────
 *
 * The daemon's email and calendar handlers read these long before anything
 * declared them. `CONFIG_SCHEMA` is what the schema-driven settings modal
 * renders from, so an undeclared key is a key the modal cannot show — and the
 * handlers' own failure text names them:
 *
 *   "Email is not configured. Set surfaces.email.host, surfaces.email.user…"
 *
 * goodvibes-webui's CalendarView points operators at
 * `surfaces.calendar.caldavUrl` / `caldavUser` / `caldavPassword`, and
 * goodvibes-tui's setup guidance points at `surfaces.email.*`, so two products
 * were telling operators to set keys their settings UI had no row for.
 * Declaring them here is what makes those instructions land somewhere real.
 *
 * ── Why both spellings ────────────────────────────────────────────────────
 *
 * Both are genuinely read. The inbox provider reads the flat
 * `imapHost`/`imapPort`/`imapUser`/`imapPassword`; the triage tagger and the
 * settings resolver read the nested `imap.*`/`smtp.*`. Declaring one spelling
 * would have stranded exactly the half a given machine happened to use.
 *
 * ── Why this also fixes credential storage ────────────────────────────────
 *
 * `config-ownership.ts` derives the daemon-owned SECRET set by walking
 * `listDaemonOwnedConfigPaths()`, which is `CONFIG_SCHEMA` keys the daemon
 * owns plus a hand-kept list of non-scalar paths. `surfaces.` has always been
 * a daemon-owned PREFIX, so `isDaemonOwnedConfigKey` already answered true for
 * these — but nothing ENUMERATED them, so the walk produced no daemon-owned
 * credential name for them and `GOODVIBES_SURFACES_EMAIL_PASSWORD` was filed
 * in whichever client silo the operator happened to be sitting in. The daemon
 * reads none of those, so a stored mail password looked set and did nothing.
 * Being real schema keys puts them in that walk, which is why they are here
 * rather than on the non-scalar list in `config-ownership.ts`.
 */

import type { ConfigSettingDefinition } from './schema-shared.js';

/** Defaults for the daemon's own mail account and calendar. */
export const daemonMailboxConfigDefaults = {
  email: {
    host: '',
    user: '',
    username: '',
    from: '',
    password: '',
    imapHost: '',
    imapPort: 993,
    imapUser: '',
    imapPassword: '',
    imap: {
      host: '',
      port: 993,
      user: '',
      password: '',
      secure: true,
      mailbox: 'INBOX',
      draftsMailbox: 'Drafts',
    },
    smtp: {
      host: '',
      port: 465,
      password: '',
      secure: true,
    },
  },
  calendar: {
    caldavUrl: '',
    caldavUser: '',
    caldavPassword: '',
    defaultCalendarId: '',
    calendars: '',
  },
};

/** Schema rows for the daemon's own mail account and calendar. */
export const daemonMailboxConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'surfaces.email.host',
    type: 'string',
    default: '',
    description: 'Mail server hostname used for both IMAP and SMTP unless overridden below',
  },
  {
    key: 'surfaces.email.user',
    type: 'string',
    default: '',
    description: 'Mailbox account name the daemon authenticates as',
  },
  {
    key: 'surfaces.email.username',
    type: 'string',
    default: '',
    description: 'Alternate spelling of the mailbox account name, read when user is unset',
  },
  {
    key: 'surfaces.email.from',
    type: 'string',
    default: '',
    description: 'From address on mail the daemon sends; defaults to the account name',
  },
  {
    key: 'surfaces.email.password',
    type: 'string',
    default: '',
    description: 'Mailbox password or app password. Stored in the daemon secret tier, never in config',
  },
  {
    key: 'surfaces.email.imapHost',
    type: 'string',
    default: '',
    description: 'IMAP hostname read by the inbox provider (e.g. imap.gmail.com)',
  },
  {
    key: 'surfaces.email.imapPort',
    type: 'number',
    default: 993,
    description: 'IMAP port read by the inbox provider',
  },
  {
    key: 'surfaces.email.imapUser',
    type: 'string',
    default: '',
    description: 'IMAP account name read by the inbox provider',
  },
  {
    key: 'surfaces.email.imapPassword',
    type: 'string',
    default: '',
    description: 'IMAP password read by the inbox provider. Daemon secret tier, never config',
  },
  {
    key: 'surfaces.email.imap.host',
    type: 'string',
    default: '',
    description: 'IMAP hostname, overriding surfaces.email.host',
  },
  {
    key: 'surfaces.email.imap.port',
    type: 'number',
    default: 993,
    description: 'IMAP port',
  },
  {
    key: 'surfaces.email.imap.user',
    type: 'string',
    default: '',
    description: 'IMAP account name, overriding surfaces.email.user',
  },
  {
    key: 'surfaces.email.imap.password',
    type: 'string',
    default: '',
    description: 'IMAP password, overriding surfaces.email.password. Daemon secret tier',
  },
  {
    key: 'surfaces.email.imap.secure',
    type: 'boolean',
    default: true,
    description: 'Connect to IMAP over TLS',
  },
  {
    key: 'surfaces.email.imap.mailbox',
    type: 'string',
    default: 'INBOX',
    description: 'Mailbox the daemon reads',
  },
  {
    key: 'surfaces.email.imap.draftsMailbox',
    type: 'string',
    default: 'Drafts',
    description: 'Mailbox drafts are appended to',
  },
  {
    key: 'surfaces.email.smtp.host',
    type: 'string',
    default: '',
    description: 'SMTP hostname, overriding surfaces.email.host',
  },
  {
    key: 'surfaces.email.smtp.port',
    type: 'number',
    default: 465,
    description: 'SMTP port',
  },
  {
    key: 'surfaces.email.smtp.password',
    type: 'string',
    default: '',
    description: 'SMTP password when it differs from the IMAP one. Daemon secret tier',
  },
  {
    key: 'surfaces.email.smtp.secure',
    type: 'boolean',
    default: true,
    description: 'Connect to SMTP over TLS',
  },
  {
    key: 'surfaces.calendar.caldavUrl',
    type: 'string',
    default: '',
    description: 'CalDAV server URL the daemon reads and writes events through',
  },
  {
    key: 'surfaces.calendar.caldavUser',
    type: 'string',
    default: '',
    description: 'CalDAV account name',
  },
  {
    key: 'surfaces.calendar.caldavPassword',
    type: 'string',
    default: '',
    description: 'CalDAV password. Stored in the daemon secret tier, never in config',
  },
  {
    key: 'surfaces.calendar.defaultCalendarId',
    type: 'string',
    default: '',
    description: 'Calendar used when a request names none',
  },
  {
    key: 'surfaces.calendar.calendars',
    type: 'string',
    default: '',
    description: 'Comma-separated calendar ids the daemon may read',
  },
];
