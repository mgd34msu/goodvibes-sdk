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

import { type ConfigSettingDefinition, intRange } from './schema-shared.js';

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
    // The inbound-mail watcher's own settings — the inbound section of
    // surfaces.email. See docs/inbound-email.md §8 for the ruled defaults;
    // every one of them is the owner's to confirm or overturn.
    inbound: {
      enabled: false,
      accounts: '[]',
      source: 'auto',
      gmailPollSecondsExpecting: 5,
      gmailPollSecondsIdle: 60,
      mode: 'auto',
      pollIntervalSeconds: 120,
      idleReissueMinutes: 27,
      reconnect: {
        maxBackoffSeconds: 300,
      },
      notice: {
        route: 'default',
        mode: 'all',
      },
      expectationWindowMinutes: 15,
      dedupTtlMinutes: 60,
      retentionDays: 30,
      maxRecords: 5000,
      capabilityRecheckMinutes: 60,
      onInsufficientCapability: 'refuse-and-notify',
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

  // ── Inbound-mail watcher — the inbound section of surfaces.email ──────────
  // See docs/inbound-email.md §8 for the ruled defaults and the rationale
  // behind each one; every default here is the owner's to confirm.
  {
    key: 'surfaces.email.inbound.enabled',
    type: 'boolean',
    default: false,
    description: 'Turns on continuous IMAP watching of the configured inbound accounts below. Off by default — '
      + 'reading the owner\'s mail continuously is not a thing to start doing without being asked. Turn on after '
      + 'configuring at least one account in surfaces.email.inbound.accounts.',
  },
  {
    key: 'surfaces.email.inbound.accounts',
    type: 'string',
    default: '[]',
    description: 'JSON array of configured mailbox account identifiers to watch for inbound mail, e.g. '
      + '["primary"]. Empty means no mailbox is watched even when enabled is true. A list rather than a single '
      + 'switch because one address for signups and another for the owner\'s real mail is the expected shape.',
  },
  {
    key: 'surfaces.email.inbound.source',
    type: 'enum',
    default: 'auto',
    description: 'Which mechanism reads the mailbox. "auto" uses Gmail when Google credentials have been adopted '
      + 'and the configured mail account is a Gmail account, and IMAP otherwise — so connecting Google is the '
      + 'whole of the setup and no IMAP host, username or app password has to be found. "gmail" and "imap" force '
      + 'one of them. The two are not equivalent and the difference is a real cost: IMAP holds an IDLE '
      + 'connection, which is true push and delivers in under a second, while Gmail has no push available to a '
      + 'daemon on a home machine and is POLLED on a timer — its worst-case delay is the whole poll interval '
      + 'below, never less. Forcing "gmail" without adopted Google credentials, or on an account that is not a '
      + 'Gmail account, is refused rather than quietly served over IMAP.',
    enumValues: ['auto', 'gmail', 'imap'],
  },
  {
    key: 'surfaces.email.inbound.gmailPollSecondsExpecting',
    type: 'number',
    default: 5,
    description: 'How often the Gmail source asks Google what changed while something is actually being waited '
      + 'for — a signup mid-flight whose verification mail has not arrived yet. This is polling, not push: mail '
      + 'can sit unnoticed for up to this many seconds, and no setting makes Gmail faster than the interval. '
      + 'Five seconds is the floor worth having for a person watching a signup form; the underlying call costs 2 '
      + 'quota units against a daily budget in the billions, so a shorter interval buys latency rather than '
      + 'saving quota. Ignored entirely when the IMAP source is in use, which pushes instead.',
    ...intRange(2, 60),
  },
  {
    key: 'surfaces.email.inbound.gmailPollSecondsIdle',
    type: 'number',
    default: 60,
    description: 'How often the Gmail source asks Google what changed when nothing is being waited for. Again '
      + 'polling, not push: with nothing pending, mail is noticed up to this many seconds after it arrives. A '
      + 'minute keeps the daemon from asking Google every five seconds all week for mail nobody is waiting on; '
      + 'lowering it narrows that gap at the cost of a request every few seconds around the clock. Ignored '
      + 'entirely when the IMAP source is in use.',
    ...intRange(10, 3600),
  },
  {
    key: 'surfaces.email.inbound.mode',
    type: 'enum',
    default: 'auto',
    description: 'How the IMAP source receives new mail: "idle" holds a persistent IMAP IDLE connection, "poll" '
      + 'checks on a timer, "auto" uses IDLE when the server advertises it and falls back to polling when it '
      + 'does not. Leave at auto unless a specific provider needs to be forced one way. Applies only to the IMAP '
      + 'source; the Gmail source has no IDLE to hold and is always polled, on the two intervals above.',
    enumValues: ['idle', 'poll', 'auto'],
  },
  {
    key: 'surfaces.email.inbound.pollIntervalSeconds',
    type: 'number',
    default: 120,
    description: 'How often the fallback poller checks the mailbox when IDLE is unavailable. Lower is more '
      + 'responsive but closer to a provider\'s rate limit; higher delays notice of new mail by up to this many '
      + 'seconds. Only applies when the connection is not using IDLE.',
    ...intRange(30, 3600),
  },
  {
    key: 'surfaces.email.inbound.idleReissueMinutes',
    type: 'number',
    default: 27,
    description: 'How often an open IDLE connection is torn down and re-issued. RFC 2177 advises re-issuing at '
      + 'least every 29 minutes, or the server may silently log the connection off; raising this toward 29 trims '
      + 'reconnect churn but leaves less margin against a slow round trip.',
    ...intRange(5, 29),
  },
  {
    key: 'surfaces.email.inbound.reconnect.maxBackoffSeconds',
    type: 'number',
    default: 300,
    description: 'Ceiling on the exponential reconnect backoff after a dropped connection or provider error. '
      + 'Raising it tolerates a longer provider outage without hammering it; lowering it shortens the '
      + 'worst-case silence after a disconnect at the cost of retrying a still-down server more often.',
    ...intRange(10, 3600),
  },
  {
    key: 'surfaces.email.inbound.notice.route',
    type: 'string',
    default: 'default',
    description: 'Where the owner is told about inbound mail: the literal "default" inherits the owner\'s '
      + 'existing notice route binding; a specific route binding id sends inbound-mail notices somewhere else. '
      + 'A second place to configure "where to reach me" is a second place to get it wrong, so most '
      + 'installations should leave this at default.',
  },
  {
    key: 'surfaces.email.inbound.notice.mode',
    type: 'enum',
    default: 'all',
    description: 'How much inbound mail generates an owner notice: "all" announces every message, '
      + '"expected-only" announces only mail matching a registered expectation (quieter for a high-volume '
      + 'mailbox), "none" announces nothing. Choosing "none" means mail can arrive with no notice at all — a '
      + 'deliberate but silent choice.',
    enumValues: ['all', 'expected-only', 'none'],
  },
  {
    key: 'surfaces.email.inbound.expectationWindowMinutes',
    type: 'number',
    default: 15,
    description: 'Default lifetime, in minutes, of a verification expectation opened for inbound-mail matching '
      + '(for example an account signup awaiting its confirmation email). Raising it gives a slower-to-arrive '
      + 'confirmation more time to match; lowering it shrinks how long a stale expectation can be satisfied by a '
      + 'late message. Hard-capped at 60 to match MAX_VERIFICATION_WINDOW_MS.',
    ...intRange(1, 60),
  },
  {
    key: 'surfaces.email.inbound.dedupTtlMinutes',
    type: 'number',
    default: 60,
    description: 'How long an inbound message\'s identity is remembered, inside the running daemon, so an '
      + 'overlapping poll or a retried pass does not process it twice. This cache lives in memory only: a '
      + 'restart destroys it rather than expiring it, so no value here prevents a duplicate across a restart — '
      + 'the inbound record store does that, by remembering which messages were already announced. Seconds '
      + 'would be enough for what this covers; a larger value only costs a little memory.',
    ...intRange(5, 1440),
  },
  {
    key: 'surfaces.email.inbound.retentionDays',
    type: 'number',
    default: 30,
    description: 'How many days an inbound mail record (sender, subject, delivery evidence, link verdicts — '
      + 'never the full body) is kept before it is reaped. Longer keeps a longer history to explain "why did I '
      + 'get that message"; shorter bounds how much of the owner\'s mail metadata the daemon retains.',
    ...intRange(1, 365),
  },
  {
    key: 'surfaces.email.inbound.maxRecords',
    type: 'number',
    default: 5000,
    description: 'Hard cap on the number of inbound mail records kept regardless of age. Whichever of this and '
      + 'retentionDays is reached first wins, so this bounds worst-case storage even under a burst of mail.',
    ...intRange(100, 100_000),
  },
  {
    key: 'surfaces.email.inbound.capabilityRecheckMinutes',
    type: 'number',
    default: 60,
    description: 'How often a mailbox that reported it cannot do what inbound mail requires (for example a '
      + 'Gmail grant that authorizes listing but not reading message bodies, or a mailbox that does not exist) is '
      + 're-probed. Long enough that a refused account is not hammered in a tight loop; short enough that fixing '
      + 'the underlying scope or account problem is noticed without a daemon restart.',
    ...intRange(5, 1440),
  },
  {
    key: 'surfaces.email.inbound.onInsufficientCapability',
    type: 'enum',
    default: 'refuse-and-notify',
    description: '"refuse-and-notify" stops the watcher for that account and tells the owner once, naming what '
      + 'is missing and the exact step to fix it — the account is not watched again until the recheck above '
      + 'finds it fixed. "notice-only" is a deliberate downgrade: it keeps announcing that mail arrived using '
      + 'envelope fields alone (sender, subject, delivery evidence), stating plainly in every notice that bodies '
      + 'are unavailable, and it can never satisfy a verification expectation while degraded — an account signup '
      + 'or order confirmation will not work under it.',
    enumValues: ['refuse-and-notify', 'notice-only'],
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
    description: 'JSON object mapping a calendar id to its collection path, e.g. {"work":"/dav/calendars/work/"}. Empty means the CalDAV URL is the one calendar',
  },
];
