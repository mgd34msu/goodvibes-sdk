/**
 * Email service — config, secret resolution, and orchestration.
 *
 * Config namespace: email.*
 * ─────────────────────────
 * The ConfigKey union is sealed and does not include email keys.
 * Email settings are accessed via ensureEmailConfigDefaults(), which
 * injects the email section into the ConfigManager's live config object
 * before first use. This follows the same pattern as other categories that
 * extend beyond the built-in schema.
 *
 * Settings registered:
 *   email.enabled        boolean   — feature gate (default: false)
 *   email.imapHost       string    — IMAP TLS host (default: '')
 *   email.imapPort       number    — default 993
 *   email.smtpHost       string    — SMTP submission host (default: '')
 *   email.smtpPort       number    — 465 (TLS) or 587 (STARTTLS, default)
 *   email.username       string    — login username (default: '')
 *   email.passwordRef    string    — goodvibes:// secret reference only;
 *                                    NEVER a raw password
 *   email.smtpPasswordRef string   — optional; a second goodvibes:// reference
 *                                    for providers that issue separate SMTP
 *                                    credentials. Empty means "same password"
 *   email.fromAddress    string    — From: address for outbound mail
 *   email.mailbox        string    — mailbox to read; empty means INBOX
 *   email.draftsMailbox  string    — Drafts folder; empty means ask the server
 *
 * Secret resolution
 * ─────────────────
 * `email.passwordRef` must be a goodvibes secret reference string.
 * The service calls `secretsManager.get(resolvedKey)` using the same
 * SecretsManager instance the product already has wired.
 * Plaintext passwords in config are rejected at validation time.
 *
 * Everything is injected
 * ──────────────────────
 * Not a line here opens a socket, reads a file or reaches for a global. The
 * transports (`EmailTransportPort`), the config reader, the secret store, the
 * sender-claim describer and the untrusted-ingest recorder all arrive as ports,
 * so the whole service runs against fakes with no machine. The concrete
 * bun/node transport lives in the sibling `email/node` entry.
 */

import { readSenderAuthentication } from '../google/sender-authentication.js';
import { ImapClient } from './imap-client.js';
import { SmtpClient, validateSmtpAddress, validateSmtpSubject } from './smtp-client.js';
import type {
  ImapAppendDraftResult,
  ImapEnvelope,
  ImapMessageDetail,
} from './imap-client.js';
import type { SmtpSendResult } from './smtp-client.js';
import type { EmailSenderClaim, EmailSenderClaimDescriber } from './sender-claim.js';
import type { Socket } from 'node:net';

// ---------------------------------------------------------------------------
// Email defaults injection
// ---------------------------------------------------------------------------

/** Email section defaults — injected once per ConfigManager instance. */
const EMAIL_DEFAULTS = {
  enabled: false,
  imapHost: '',
  imapPort: 993,
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'auto' as const,
  username: '',
  passwordRef: '',
  smtpPasswordRef: '',
  fromAddress: '',
  mailbox: '',
  draftsMailbox: '',
} as const;

/**
 * Inject the email config section into the ConfigManager's live config
 * object if it is not already present.
 *
 * DEFAULT_CONFIG does not include an email section. ConfigManager.resolvePath()
 * walks the live config object and throws for any section that does not exist.
 * Calling this helper once before any email.* access ensures the traversal
 * succeeds.
 *
 * The helper is safe to call multiple times — it is a no-op after the first
 * call for a given configManager instance.
 */
export function ensureEmailConfigDefaults(
  configManager: object,
): void {
  // Use the internal config object via an opaque cast. This is the sanctioned
  // extension pattern for categories absent from the built-in schema.
  const cm = configManager as unknown as { config: Record<string, unknown> };
  if (cm.config && !('email' in cm.config)) {
    cm.config['email'] = { ...EMAIL_DEFAULTS };
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** SMTP connection security mode. 'auto' = port-based default (465→tls, else starttls). */
export type SmtpSecurityMode = 'tls' | 'starttls' | 'auto';

export interface EmailConfig {
  readonly enabled: boolean;
  readonly imapHost: string;
  readonly imapPort: number;
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** SMTP connection security. Default: 'auto' (port-based). */
  readonly smtpSecurity: SmtpSecurityMode;
  readonly username: string;
  /** Secret reference string — never a raw password. */
  readonly passwordRef: string;
  /**
   * Secret reference for the SMTP password, when the provider issues one that
   * differs from the IMAP password. Empty — the common case — means submission
   * authenticates with `passwordRef` like everything else.
   */
  readonly smtpPasswordRef: string;
  readonly fromAddress: string;
  /**
   * Mailbox to read. Empty — the common case — means INBOX. Set when the
   * account delivers to a folder, which is what a per-signup alias mailbox is.
   */
  readonly mailbox: string;
  /**
   * Drafts folder. Empty means "ask the server", which is the better answer:
   * discovery reads the `\Drafts` special-use flag and gets `[Gmail]/Drafts`
   * right where a hard-coded `Drafts` silently creates a stray folder. Set it
   * only when the server does not advertise one.
   */
  readonly draftsMailbox: string;
}

export interface EmailSummary {
  /**
   * The IMAP UID this message is read back by. Carried through from the
   * envelope because a listing whose entries cannot be opened is a listing
   * nobody can act on.
   *
   * A UID, and never a sequence number: a listing is read from later, and a
   * sequence number stops naming the same message as soon as anything below it
   * is expunged.
   */
  readonly uid: number;
  /** The `Message-ID` header, for threading and correlation. '' when absent. */
  readonly messageId: string;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  /** First ~4 KB of the plain-text body, fetched read-only. Empty string when unavailable. */
  readonly bodyPreview: string;
  /**
   * The mailbox this message was fetched from. Delivery evidence: a message
   * cannot be talked into arriving in a mailbox that exists only for one
   * signup, which is what makes per-signup aliases worth minting.
   */
  readonly mailbox: string;
  /**
   * Delivery-agent trace, top-most first. Written by the receiving mail
   * server, so — unlike `To:` — a sender cannot set it. Safe to correlate on.
   */
  readonly deliveredTo: readonly string[];
  /**
   * The `To:` header verbatim. **Display only, never evidence.** The sender
   * writes this field, so it proves nothing about where the message landed.
   * Named so that correlating on it reads as obviously wrong.
   */
  readonly unverifiedToHeaderClaim: string;
  /**
   * The `From:` line described as a CLAIM, carrying the receiving server's
   * sender-authentication verdict as DISPLAY confidence.
   *
   * `senderClaim.commandAuthority` is the literal `'none'` and cannot hold any
   * other value. A message that passes DKIM, SPF and DMARC and writes the
   * owner's own address in its From header gets a more confident sentence for
   * a human to read, and exactly the same authority as a stranger's: none.
   */
  readonly senderClaim: EmailSenderClaim;
}

/**
 * Result of a connection verification pass (a connect-wizard "test connection"
 * step). Never includes the raw password; `error` messages come from the
 * underlying client's plain-language exceptions.
 */
export interface EmailConnectionTestResult {
  readonly ok: boolean;
  /** Which stage failed, when ok is false. 'config' means validation failed before any connection was attempted. */
  readonly stage?: 'config' | 'imap' | 'smtp';
  readonly error?: string;
}

export interface SendMailOptions {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Must be true at the call site; the service rejects sends without it. */
  readonly confirm: boolean;
}

/** What to list, for `listInbox`. Every field is optional. */
export interface EmailInboxListInput {
  /** Maximum messages to return. Default: 10. */
  readonly limit?: number | undefined;
  /** Restrict to messages the server dates on or after this day. */
  readonly since?: Date | undefined;
  /**
   * Unread messages only. Default: true — the historical behaviour of
   * `checkInbox`. Setting it false lists everything, which is a different
   * SEARCH, not the same one filtered afterwards.
   */
  readonly unreadOnly?: boolean | undefined;
}

export interface EmailInboxListResult {
  readonly messages: readonly EmailSummary[];
  /**
   * How many messages MATCHED, before `limit` truncated the list.
   *
   * Deliberately not `messages.length`: a caller needs to be able to tell "that
   * is all of them" from "that is the first ten", and a total that always
   * equalled the page size would say there is never any more mail.
   */
  readonly total: number;
}

/**
 * The fields a draft is composed from. `from` is the only optional one —
 * omitting it uses the configured `email.fromAddress`, which is what a caller
 * that is not choosing an identity should do.
 */
export interface EmailDraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Defaults to `email.fromAddress`. */
  readonly from?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
  /** Overrides Drafts-folder discovery. */
  readonly mailbox?: string | undefined;
}

/** Opens one transport connection to a mail host. */
export type EmailSocketFactory = (host: string, port: number) => Promise<Socket>;

/**
 * The three real connections this service can need.
 *
 * A port rather than a direct call so that the service half never imports
 * `node:tls`: the concrete implementation is `nodeEmailTransport` in the
 * sibling `email/node` entry, and a test supplies one that throws.
 */
export interface EmailTransportPort {
  /** IMAP over implicit TLS (port 993). */
  readonly connectImapTls: EmailSocketFactory;
  /** SMTP submission over implicit TLS (port 465). */
  readonly connectSmtpTls: EmailSocketFactory;
  /** SMTP submission over a plain connection upgraded with STARTTLS (port 587). */
  readonly connectSmtpStartTls: EmailSocketFactory;
}

export interface EmailServiceDeps {
  /** Untyped config getter — reads the `email.*` namespace. */
  readonly getConfig: (key: string) => unknown;
  /** SecretsManager-compatible interface for resolving secret refs. */
  readonly secretsManager: {
    readonly get: (key: string) => Promise<string | null>;
  };
  /** The real connections. Required: this module never opens one itself. */
  readonly transport: EmailTransportPort;
  /**
   * Describes a `From:` header as a claim, for display.
   *
   * Injected because the wording of a trust boundary belongs to the surface
   * that renders it, and because a second copy in the SDK would drift from the
   * product's own. Its `commandAuthority` is the literal `'none'`; see
   * `sender-claim.ts`.
   */
  readonly describeSenderClaim: EmailSenderClaimDescriber;
  /** Optional socket factory override for IMAP (injected in tests). */
  readonly imapSocketFactory?: EmailSocketFactory;
  /** Optional socket factory override for SMTP (injected in tests). */
  readonly smtpSocketFactory?: EmailSocketFactory;
  /**
   * Records that untrusted content entered the conversation.
   *
   * Reading a mailbox pulls in text written by anyone who knows the address,
   * which is the same exposure as loading a web page — and the outward-effect
   * guard only fires on exposure it has been told about. Injected rather than
   * reached for globally so the service stays testable and so a caller cannot
   * accidentally record into a different session's ledger.
   */
  readonly recordUntrustedIngest?: (ingest: {
    readonly surface: 'email';
    readonly origin: string;
    readonly at: string;
    /**
     * The message text that was read.
     *
     * Without it the guard downstream can only ask "has this process read
     * mail", which in a daemon is permanently true and therefore decides
     * nothing. With it, an outward action can be checked for DERIVATION from
     * this message — which is the owner's named threat: an injection arriving
     * by email.
     */
    readonly content?: string | undefined;
  }) => void;
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  return isFinite(n) ? n : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readSmtpSecurity(value: unknown): SmtpSecurityMode {
  if (value === 'tls' || value === 'starttls' || value === 'auto') return value;
  return 'auto';
}

export function readEmailConfig(getConfig: (key: string) => unknown): EmailConfig {
  return {
    enabled: readBoolean(getConfig('email.enabled'), false),
    imapHost: readString(getConfig('email.imapHost')),
    imapPort: readNumber(getConfig('email.imapPort'), 993),
    smtpHost: readString(getConfig('email.smtpHost')),
    smtpPort: readNumber(getConfig('email.smtpPort'), 587),
    smtpSecurity: readSmtpSecurity(getConfig('email.smtpSecurity')),
    username: readString(getConfig('email.username')),
    passwordRef: readString(getConfig('email.passwordRef')),
    smtpPasswordRef: readString(getConfig('email.smtpPasswordRef')),
    fromAddress: readString(getConfig('email.fromAddress')),
    mailbox: readString(getConfig('email.mailbox')),
    draftsMailbox: readString(getConfig('email.draftsMailbox')),
  };
}

/**
 * Which secret submission authenticates with: the SMTP-specific one when the
 * operator set it, otherwise the mailbox password. Resolved through one helper
 * so `sendMail` and `testConnection` cannot disagree about which credential a
 * send would actually use — a test that passes with the wrong password is worse
 * than no test.
 */
export function smtpPasswordRefFor(config: EmailConfig): string {
  return config.smtpPasswordRef.length > 0 ? config.smtpPasswordRef : config.passwordRef;
}

export function validateEmailConfig(config: EmailConfig): string[] {
  const errors: string[] = [];
  if (!config.imapHost) errors.push('email.imapHost is required');
  if (!config.smtpHost) errors.push('email.smtpHost is required');
  if (!config.username) errors.push('email.username is required');
  if (!config.passwordRef) {
    errors.push('email.passwordRef is required (must be a secret reference, not a raw password)');
  } else if (!config.passwordRef.startsWith('goodvibes://secrets/')) {
    errors.push('email.passwordRef must be a goodvibes secret reference (goodvibes://secrets/...)');
  }
  // Optional: an empty value means "same password as IMAP", which is the common
  // case. A non-empty one is held to the same rule as passwordRef — a raw
  // password here would be a raw password in a settings file.
  if (config.smtpPasswordRef.length > 0 && !config.smtpPasswordRef.startsWith('goodvibes://secrets/')) {
    errors.push('email.smtpPasswordRef must be a goodvibes secret reference (goodvibes://secrets/...)');
  }
  if (!config.fromAddress) errors.push('email.fromAddress is required');
  return errors;
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/**
 * Extract the storage key from a goodvibes://secrets/goodvibes/<key> ref.
 * For other secret ref types (env, file, bitwarden, etc.) we cannot resolve
 * them directly — the user should configure via the standard secret manager
 * path. We return the raw ref string for those cases so the SecretsManager
 * can attempt its own resolution chain.
 */
function extractSecretKey(passwordRef: string): string {
  const prefix = 'goodvibes://secrets/goodvibes/';
  if (passwordRef.startsWith(prefix)) {
    return decodeURIComponent(passwordRef.slice(prefix.length));
  }
  // Return the full ref for the SecretsManager to resolve
  return passwordRef;
}

export async function resolveEmailPassword(
  passwordRef: string,
  secretsManager: { readonly get: (key: string) => Promise<string | null> },
): Promise<string> {
  const key = extractSecretKey(passwordRef);
  const value = await secretsManager.get(key);
  if (!value) {
    throw new Error(
      'Email password secret could not be resolved. ' +
      'Verify that email.passwordRef points to a configured secret.',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// EmailService
// ---------------------------------------------------------------------------

export class EmailService {
  private readonly deps: EmailServiceDeps;

  constructor(deps: EmailServiceDeps) {
    this.deps = deps;
  }

  /** Returns a redacted status summary — never includes secret values. */
  getStatus(): { config: EmailConfig; errors: string[]; ready: boolean } {
    const config = readEmailConfig(this.deps.getConfig);
    const errors = validateEmailConfig(config);
    return {
      config: {
        ...config,
        // Redact the ref itself for display; keep structural info only
        passwordRef: config.passwordRef ? '[configured]' : '[missing]',
        // '[shared]' rather than '[missing]': an unset SMTP ref is not an
        // omission, it is the mailbox password doing both jobs.
        smtpPasswordRef: config.smtpPasswordRef ? '[configured]' : '[shared]',
      },
      errors,
      ready: errors.length === 0 && config.enabled,
    };
  }

  /**
   * Fetch up to `limit` unread inbox summaries.
   * Messages are read via EXAMINE (read-only); unread flag is never modified.
   *
   * The unread-only listing, unchanged. `listInbox` is the general form.
   */
  async checkInbox(limit = 10): Promise<EmailSummary[]> {
    const { messages } = await this.listInbox({ limit });
    return [...messages];
  }

  /**
   * List the inbox: unread only by default, everything when `unreadOnly` is
   * false, optionally bounded by a date.
   *
   * Read-only throughout — the mailbox is EXAMINEd and every fetch peeks, so
   * listing mail never marks it read. Returns the matched `total` alongside
   * the truncated page.
   */
  async listInbox(input: EmailInboxListInput = {}): Promise<EmailInboxListResult> {
    const limit = input.limit ?? 10;
    const unreadOnly = input.unreadOnly ?? true;
    const config = this.getValidatedConfig();
    const password = await resolveEmailPassword(config.passwordRef, this.deps.secretsManager);

    const socketFactory = this.deps.imapSocketFactory ?? this.deps.transport.connectImapTls;
    const socket = await socketFactory(config.imapHost, config.imapPort);

    const client = new ImapClient({
      socket,
      username: config.username,
      password,
      ...(config.mailbox.length > 0 ? { mailbox: config.mailbox } : {}),
    });

    try {
      await client.open();
      const uids = unreadOnly
        ? await client.searchUnseen(input.since)
        : await client.searchAll(input.since);
      const envelopes: ImapEnvelope[] = await client.fetchEnvelopes(uids, limit);

      // Fetch a body preview for the newest message OF THIS PAGE (read-only;
      // BODY.PEEK). The target is taken from `envelopes`, not from the search
      // results: a search returns ascending order and the page keeps the
      // highest UIDs, so the first search result is the oldest match and is
      // usually not on the page at all. Preview text taken from one message
      // and shown against another is worse than no preview — it attributes
      // words to a sender who did not write them, both in the listing and in
      // the untrusted-ingest record below.
      // Failures are non-fatal — the inbox summary is still returned.
      const previewIndex = envelopes.length - 1;
      const previewTarget = envelopes[previewIndex];
      let newestBodyPreview = '';
      if (previewTarget !== undefined) {
        try {
          newestBodyPreview = await client.fetchBodyPreview(previewTarget.uid);
        } catch {
          // best-effort: body preview unavailable, proceed without it
        }
      }

      // Which of these are actually unread. When the search was UNSEEN they
      // all are; when it was ALL, saying so would be a fabricated flag, so the
      // unseen set is asked for separately rather than assumed.
      const unseen = unreadOnly
        ? null
        : new Set<number>(await client.searchUnseen(input.since));

      await client.logout();

      // Delivery evidence is carried through deliberately. Dropping it here
      // would leave correlation with nothing but the sender-authored `To:`
      // header, which is the exact hole the evidence exists to close.
      this.recordIngest(envelopes.map((env, idx) => ({
        from: env.from,
        // The preview is fetched for one message only, so that is the one
        // whose words are available here; the rest contribute their subject,
        // which is itself attacker-written. The index is the one the preview
        // was fetched from, so the text is attributed to the sender who wrote
        // it.
        text: `${env.subject}\n${idx === previewIndex ? newestBodyPreview : ''}`.trim(),
      })));

      const messages = envelopes.map((env, idx) => ({
        uid: env.uid,
        messageId: env.messageId,
        from: env.from,
        subject: env.subject,
        date: env.date,
        unread: unseen === null ? true : unseen.has(env.uid),
        bodyPreview: idx === previewIndex ? newestBodyPreview : '',
        mailbox: env.mailbox,
        deliveredTo: env.deliveredTo,
        unverifiedToHeaderClaim: env.unverifiedToHeaderClaim,
        senderClaim: this.deps.describeSenderClaim(
          env.from,
          readSenderAuthentication(env.authenticationResults),
        ),
      }));
      return { messages, total: uids.length };
    } catch (err) {
      try { await client.logout(); } catch { /* best-effort */ }
      throw err;
    }
  }

  /**
   * Read one whole message by UID, or null when it is no longer there.
   *
   * Read-only (BODY.PEEK throughout) and attachment-metadata only. The full
   * body is MORE attacker-controlled text than a preview, not less, so it
   * records the same untrusted ingest the listing does — one path into the
   * product, one labelling.
   */
  async readMessage(uid: number): Promise<ImapMessageDetail | null> {
    const config = this.getValidatedConfig();
    const password = await resolveEmailPassword(config.passwordRef, this.deps.secretsManager);

    const socketFactory = this.deps.imapSocketFactory ?? this.deps.transport.connectImapTls;
    const socket = await socketFactory(config.imapHost, config.imapPort);
    const client = new ImapClient({
      socket,
      username: config.username,
      password,
      ...(config.mailbox.length > 0 ? { mailbox: config.mailbox } : {}),
    });

    try {
      await client.open();
      const detail = await client.fetchMessage(uid);
      await client.logout();
      if (detail !== null) {
        this.recordIngest([{
          from: detail.from,
          text: `${detail.subject}\n${detail.bodyText}`.trim(),
        }]);
      }
      return detail;
    } catch (err) {
      try { await client.logout(); } catch { /* best-effort */ }
      throw err;
    }
  }

  /**
   * Save a draft to the Drafts folder. Nothing is sent: a draft is the outcome
   * that leaves the decision to send with the owner.
   *
   * `from` defaults to the configured `email.fromAddress`. The folder is
   * discovered from the server's own `\Drafts` flag rather than guessed.
   */
  async createDraft(input: EmailDraftInput): Promise<ImapAppendDraftResult> {
    const config = this.getValidatedConfig();
    const password = await resolveEmailPassword(config.passwordRef, this.deps.secretsManager);
    const from = input.from !== undefined && input.from.trim().length > 0
      ? input.from
      : config.fromAddress;

    const socketFactory = this.deps.imapSocketFactory ?? this.deps.transport.connectImapTls;
    const socket = await socketFactory(config.imapHost, config.imapPort);
    const client = new ImapClient({ socket, username: config.username, password });

    try {
      await client.open();
      const result = await client.appendDraft({
        to: input.to,
        subject: input.subject,
        body: input.body,
        from,
        inReplyTo: input.inReplyTo,
        references: input.references,
        // Caller's choice first, then the configured folder, then discovery.
        // A configured name is an operator saying the server's own answer is
        // wrong for them, so it outranks discovery but not an explicit call.
        mailbox: input.mailbox ?? (config.draftsMailbox.length > 0 ? config.draftsMailbox : undefined),
      });
      await client.logout();
      return result;
    } catch (err) {
      try { await client.logout(); } catch { /* best-effort */ }
      throw err;
    }
  }

  /**
   * Record that mail text entered the conversation.
   *
   * Reading a mailbox is an untrusted ingest, exactly as loading a web page is:
   * the text was written by whoever chose to send it. The outward-effect guard
   * can only weigh exposure it has been told about, so it is told here rather
   * than after something has already been sent.
   *
   * Origin is the CLAIMED sender domain, and is labelled as claimed wherever it
   * surfaces. It is a useful label for the owner, never an identity check — the
   * claim is why the content is untrusted, not a reason to trust it.
   */
  private recordIngest(entries: readonly { readonly from: string; readonly text?: string | undefined }[]): void {
    const recordIngest = this.deps.recordUntrustedIngest;
    if (!recordIngest) return;
    const at = new Date().toISOString();
    for (const entry of entries) {
      const claimed = this.deps.describeSenderClaim(entry.from).claimedAddress;
      const domain = claimed.includes('@') ? claimed.slice(claimed.lastIndexOf('@') + 1) : '';
      recordIngest({
        surface: 'email',
        origin: domain.length > 0 ? `email:${domain} (claimed)` : 'email:unknown sender',
        at,
        // The subject and body ARE the injection surface. Recording the origin
        // without them leaves the guard unable to tell a send that repeats an
        // instruction from one that does not.
        ...(entry.text === undefined ? {} : { content: entry.text }),
      });
    }
  }

  /**
   * Verify the configured IMAP and SMTP connections without sending mail or
   * reading the inbox — a real connectivity + authentication check for a
   * connect-wizard "test connection" step. Does not require config.enabled;
   * callers that want to gate readiness on enabled should check separately.
   *
   * Never throws — returns a result describing which stage (if any) failed,
   * with a plain-language error message. Never includes the raw password.
   */
  async testConnection(): Promise<EmailConnectionTestResult> {
    const config = readEmailConfig(this.deps.getConfig);
    const errors = validateEmailConfig(config);
    if (errors.length > 0) {
      return { ok: false, stage: 'config', error: errors.join('; ') };
    }

    let password: string;
    try {
      password = await resolveEmailPassword(config.passwordRef, this.deps.secretsManager);
    } catch (err) {
      return { ok: false, stage: 'config', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const socketFactory = this.deps.imapSocketFactory ?? this.deps.transport.connectImapTls;
      const socket = await socketFactory(config.imapHost, config.imapPort);
      const client = new ImapClient({
        socket,
        username: config.username,
        password,
        // EXAMINE the mailbox that will actually be read, so a folder name
        // that does not exist fails the connection test rather than the first
        // real listing.
        ...(config.mailbox.length > 0 ? { mailbox: config.mailbox } : {}),
      });
      await client.open();
      await client.logout();
    } catch (err) {
      return { ok: false, stage: 'imap', error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const smtpPassword = await resolveEmailPassword(smtpPasswordRefFor(config), this.deps.secretsManager);
      const socketFactory = this.deps.smtpSocketFactory ?? this.defaultSmtpSocketFactory(config.smtpPort, config.smtpSecurity);
      const socket = await socketFactory(config.smtpHost, config.smtpPort);
      const client = new SmtpClient({ socket, hostname: config.smtpHost, username: config.username, password: smtpPassword });
      await client.verifyAuth();
    } catch (err) {
      return { ok: false, stage: 'smtp', error: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true };
  }

  /**
   * Send a plain-text email.
   * Requires `confirm: true` at the call site — throws without it.
   *
   * Returns the `Message-ID` the sent message carried and the instant the
   * server accepted it, both taken from the send itself. A caller that needs
   * to say what it sent gets the real values rather than inventing an id that
   * matches nothing in the owner's mailbox.
   */
  async sendMail(opts: SendMailOptions): Promise<SmtpSendResult> {
    if (!opts.confirm) {
      throw new Error('sendMail requires confirm: true at the call site');
    }

    const config = this.getValidatedConfig();
    const password = await resolveEmailPassword(smtpPasswordRefFor(config), this.deps.secretsManager);

    const socketFactory = this.deps.smtpSocketFactory ?? this.defaultSmtpSocketFactory(config.smtpPort, config.smtpSecurity);
    const socket = await socketFactory(config.smtpHost, config.smtpPort);

    const client = new SmtpClient({
      socket,
      hostname: config.smtpHost,
      username: config.username,
      password,
    });

    // Validate at the service boundary so injection is blocked regardless of
    // which client implementation is used.
    validateSmtpAddress(config.fromAddress, 'from');
    validateSmtpAddress(opts.to, 'to');
    validateSmtpSubject(opts.subject);

    return client.sendMail({
      from: config.fromAddress,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private getValidatedConfig(): EmailConfig {
    const config = readEmailConfig(this.deps.getConfig);
    if (!config.enabled) {
      throw new Error('Email is not enabled. Set email.enabled = true in config.');
    }
    const errors = validateEmailConfig(config);
    if (errors.length > 0) {
      throw new Error(`Email config is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    }
    return config;
  }

  private defaultSmtpSocketFactory(
    port: number,
    security: SmtpSecurityMode,
  ): EmailSocketFactory {
    // Honor an explicit smtpSecurity setting; fall back to port-based auto detection
    if (security === 'tls') return this.deps.transport.connectSmtpTls;
    if (security === 'starttls') return this.deps.transport.connectSmtpStartTls;
    // 'auto': use direct TLS on port 465, STARTTLS otherwise
    if (port === 465) return this.deps.transport.connectSmtpTls;
    return this.deps.transport.connectSmtpStartTls;
  }
}
