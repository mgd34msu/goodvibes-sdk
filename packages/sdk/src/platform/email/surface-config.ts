/**
 * surface-config.ts — driving `EmailService` from the daemon's own mailbox keys.
 *
 * `EmailService` reads a flat `email.*` namespace (`email.imapHost`,
 * `email.passwordRef`, …). The daemon's own mailbox is configured under
 * `surfaces.email.*`, which is a different shape for a good reason: it sits in
 * the `surfaces.` domain so it inherits that domain's daemon-ownership rule —
 * the daemon is the process that acts on the mailbox, so the daemon tier is the
 * only home for its settings and its password.
 *
 * This module is the adapter between the two, and nothing else. It is a
 * translation of key names and precedence; no setting is invented here, and
 * `EmailService` is not modified to know about `surfaces.`.
 *
 * Both spellings are live and both are supported
 * ──────────────────────────────────────────────
 * Two spellings of the same mailbox reached the daemon by different routes: a
 * nested one (`surfaces.email.imap.host`) written by the settings surface, and
 * a flat one (`surfaces.email.imapHost`) read by the inbound mail poller.
 * Config in the field uses each. Refusing either would break a working setup,
 * so both resolve, in a fixed order:
 *
 *   imap host  imap.host  →  host  →  imapHost
 *   imap port  imap.port  →  imapPort  →  993
 *   smtp host  smtp.host  →  host
 *   smtp port  smtp.port  →  465
 *   account    user       →  username  →  imapUser
 *   from       from       →  the account name
 *   mailbox    imap.mailbox        →  INBOX
 *   drafts     imap.draftsMailbox  →  the server's own `\Drafts` folder
 *
 * The nested spelling and the shared `host` come first because that is the
 * order the mail handlers already resolved in: a machine that worked before
 * resolves to exactly the same host afterwards. The flat keys are a last
 * resort, which only ever turns a setup that previously could not send mail
 * into one that can.
 *
 * Passwords never come from config
 * ────────────────────────────────
 * Every password is fetched from the secret store under the name the config key
 * derives (`daemonSecretKeyFor`), never read out of a settings file. The
 * fallbacks are the ones the mail handlers used:
 *
 *   IMAP/shared  surfaces.email.password → surfaces.email.imap.password
 *                (which is also where surfaces.email.imapPassword lands)
 *   SMTP         surfaces.email.smtp.password → the shared chain above
 *
 * so a provider that issues one app password works with one setting, and a
 * provider that issues separate SMTP credentials works without forcing the
 * shared one to be wrong.
 */

import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import type { EmailServiceDeps } from './email-service.js';

export const SURFACE_EMAIL_PREFIX = 'surfaces.email';

const SHARED_PASSWORD_CONFIG_KEY = `${SURFACE_EMAIL_PREFIX}.password`;
const IMAP_PASSWORD_CONFIG_KEY = `${SURFACE_EMAIL_PREFIX}.imap.password`;
const SMTP_PASSWORD_CONFIG_KEY = `${SURFACE_EMAIL_PREFIX}.smtp.password`;

/** Secret-store names, derived exactly the way setup writes them. */
const SHARED_PASSWORD_SECRET_KEY = daemonSecretKeyFor(SHARED_PASSWORD_CONFIG_KEY);
const SMTP_PASSWORD_SECRET_KEY = daemonSecretKeyFor(SMTP_PASSWORD_CONFIG_KEY);

/**
 * Both spellings of the IMAP password land on ONE secret name:
 * `surfaces.email.imap.password` and `surfaces.email.imapPassword` both derive
 * `GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD`, because the derivation splits
 * camelCase into the same underscore parts a dotted path produces. So the chain
 * is two entries, not three, and a password stored by either spelling is found
 * by the other — which is the behaviour anyone would expect and nobody would
 * think to check.
 */
const SHARED_PASSWORD_CHAIN: readonly string[] = [
  SHARED_PASSWORD_SECRET_KEY,
  daemonSecretKeyFor(IMAP_PASSWORD_CONFIG_KEY),
];

const SMTP_PASSWORD_CHAIN: readonly string[] = [SMTP_PASSWORD_SECRET_KEY, ...SHARED_PASSWORD_CHAIN];

/** The `email.passwordRef` value that points at the daemon's shared mail password. */
export const SURFACE_EMAIL_PASSWORD_REF =
  `goodvibes://secrets/goodvibes/${encodeURIComponent(SHARED_PASSWORD_SECRET_KEY)}`;

/** The `email.smtpPasswordRef` value that points at the daemon's SMTP password. */
export const SURFACE_EMAIL_SMTP_PASSWORD_REF =
  `goodvibes://secrets/goodvibes/${encodeURIComponent(SMTP_PASSWORD_SECRET_KEY)}`;

export type ConfigReader = (key: string) => unknown;

export interface SecretReader {
  get(key: string): Promise<string | null>;
}

/**
 * One config value as a trimmed, non-empty string.
 *
 * Guarded: `ConfigManager.get` throws for a section that does not exist, and on
 * a machine where nobody has set up mail that is the normal state. An
 * unreachable key reads as unset, so the caller reports "not configured"
 * instead of an `Invalid config path` exception surfacing as a 500.
 */
function readString(getConfig: ConfigReader, key: string): string | undefined {
  let value: unknown;
  try {
    value = getConfig(key);
  } catch {
    return undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

function readNumber(getConfig: ConfigReader, key: string): number | undefined {
  let value: unknown;
  try {
    value = getConfig(key);
  } catch {
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(getConfig: ConfigReader, key: string, fallback: boolean): boolean {
  let value: unknown;
  try {
    value = getConfig(key);
  } catch {
    return fallback;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes)$/i.test(value.trim())) return true;
    if (/^(false|0|no)$/i.test(value.trim())) return false;
  }
  return fallback;
}

/** The resolved, non-secret half of the daemon's mailbox settings. */
export interface SurfaceEmailSettings {
  readonly imapHost: string | undefined;
  readonly imapPort: number;
  /**
   * `surfaces.email.imap.secure`. True — the default, and every hosted provider
   * — means implicit TLS on the IMAP port. False means a plain connection, which
   * is what a mail server on localhost or a fake in a test offers.
   */
  readonly imapSecure: boolean;
  readonly smtpHost: string | undefined;
  readonly smtpPort: number;
  readonly smtpSecure: boolean;
  readonly username: string | undefined;
  readonly fromAddress: string | undefined;
  /** Mailbox to read. Absent means INBOX. */
  readonly mailbox: string | undefined;
  /** Drafts folder. Absent means let the server's `\Drafts` flag decide. */
  readonly draftsMailbox: string | undefined;
}

/** Resolve every non-secret mailbox setting, in the precedence documented above. */
export function readSurfaceEmailSettings(getConfig: ConfigReader): SurfaceEmailSettings {
  const host = readString(getConfig, `${SURFACE_EMAIL_PREFIX}.host`);
  const username = readString(getConfig, `${SURFACE_EMAIL_PREFIX}.user`)
    ?? readString(getConfig, `${SURFACE_EMAIL_PREFIX}.username`)
    ?? readString(getConfig, `${SURFACE_EMAIL_PREFIX}.imapUser`);
  return {
    imapHost: readString(getConfig, `${SURFACE_EMAIL_PREFIX}.imap.host`)
      ?? host
      ?? readString(getConfig, `${SURFACE_EMAIL_PREFIX}.imapHost`),
    imapPort: readNumber(getConfig, `${SURFACE_EMAIL_PREFIX}.imap.port`)
      ?? readNumber(getConfig, `${SURFACE_EMAIL_PREFIX}.imapPort`)
      ?? 993,
    imapSecure: readBoolean(getConfig, `${SURFACE_EMAIL_PREFIX}.imap.secure`, true),
    smtpHost: readString(getConfig, `${SURFACE_EMAIL_PREFIX}.smtp.host`) ?? host,
    smtpPort: readNumber(getConfig, `${SURFACE_EMAIL_PREFIX}.smtp.port`) ?? 465,
    smtpSecure: readBoolean(getConfig, `${SURFACE_EMAIL_PREFIX}.smtp.secure`, true),
    username,
    fromAddress: readString(getConfig, `${SURFACE_EMAIL_PREFIX}.from`) ?? username,
    mailbox: readString(getConfig, `${SURFACE_EMAIL_PREFIX}.imap.mailbox`),
    // Left absent when unset, rather than defaulted to the literal 'Drafts'
    // this setting used to fall back to. An unset folder now means the server
    // is asked which one carries the `\Drafts` flag — the answer that gets
    // Gmail's `[Gmail]/Drafts` right instead of creating a stray folder.
    draftsMailbox: readString(getConfig, `${SURFACE_EMAIL_PREFIX}.imap.draftsMailbox`),
  };
}

/**
 * A config reader that answers `email.*` from `surfaces.email.*`.
 *
 * Anything outside the `email.` namespace is passed through untouched, so the
 * same reader can back a service that also reads something else.
 *
 * `email.enabled` reports whether the mailbox is CONFIGURED. The daemon's own
 * mailbox has no separate enable switch — an operator who filled in a host, an
 * account and a password has enabled it, and asking them to also set a boolean
 * would only produce a mailbox that silently does nothing.
 */
export function createSurfaceEmailConfigReader(getConfig: ConfigReader): ConfigReader {
  return (key: string): unknown => {
    if (!key.startsWith('email.')) return getConfig(key);
    const settings = readSurfaceEmailSettings(getConfig);
    switch (key) {
      case 'email.enabled':
        return settings.imapHost !== undefined
          && settings.smtpHost !== undefined
          && settings.username !== undefined;
      case 'email.imapHost':
        return settings.imapHost ?? '';
      case 'email.imapPort':
        return settings.imapPort;
      // The same reasoning as `email.smtpSecurity` below: the operator answered
      // the question, so this reports their answer rather than guessing from the
      // port. 'tls' is implicit TLS on the IMAP port; 'plaintext' is an
      // unencrypted connection, which only a localhost or test server offers and
      // which is exactly what `surfaces.email.imap.secure: false` asks for.
      case 'email.imapSecurity':
        return settings.imapSecure ? 'tls' : 'plaintext';
      case 'email.smtpHost':
        return settings.smtpHost ?? '';
      case 'email.smtpPort':
        return settings.smtpPort;
      // A CalDAV-era `secure: true` means implicit TLS on the submission port,
      // and `false` means an upgrade with STARTTLS. Neither is 'auto': the
      // operator answered the question, so port-based guessing would be a
      // second, quieter answer that can disagree with theirs.
      case 'email.smtpSecurity':
        return settings.smtpSecure ? 'tls' : 'starttls';
      case 'email.username':
        return settings.username ?? '';
      case 'email.fromAddress':
        return settings.fromAddress ?? '';
      case 'email.mailbox':
        return settings.mailbox ?? '';
      case 'email.draftsMailbox':
        return settings.draftsMailbox ?? '';
      case 'email.passwordRef':
        return SURFACE_EMAIL_PASSWORD_REF;
      case 'email.smtpPasswordRef':
        return SURFACE_EMAIL_SMTP_PASSWORD_REF;
      default:
        return undefined;
    }
  };
}

async function firstStoredSecret(
  secrets: SecretReader,
  keys: readonly string[],
): Promise<string | null> {
  for (const key of keys) {
    const value = await secrets.get(key);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

/**
 * A secret reader that resolves the daemon's mail passwords through their
 * fallback chains, and passes every other key straight through.
 *
 * The chain lives here rather than in the ref itself because a reference names
 * ONE secret: expressing "the SMTP password, or the shared one" as a string
 * would mean inventing a ref syntax, and every reader of that string would have
 * to learn it.
 */
export function createSurfaceEmailSecretReader(secrets: SecretReader): SecretReader {
  return {
    async get(key: string): Promise<string | null> {
      if (key === SHARED_PASSWORD_SECRET_KEY) return firstStoredSecret(secrets, SHARED_PASSWORD_CHAIN);
      if (key === SMTP_PASSWORD_SECRET_KEY) return firstStoredSecret(secrets, SMTP_PASSWORD_CHAIN);
      return secrets.get(key);
    },
  };
}

/** What is missing before the daemon's mailbox can be used, in the operator's terms. */
export interface SurfaceEmailConfigProblem {
  readonly message: string;
  readonly code: string;
}

/**
 * Why the daemon's mailbox is not usable yet, or `null` when it is.
 *
 * Named separately from `validateEmailConfig` because the two speak about
 * different config: that one reports `email.imapHost is required`, which on a
 * daemon-configured machine names a key the operator does not have and cannot
 * set. These messages name the keys that are actually theirs, and are the same
 * sentences the mail handlers have always answered with.
 */
export async function describeSurfaceEmailConfigProblem(
  getConfig: ConfigReader,
  secrets: SecretReader,
): Promise<SurfaceEmailConfigProblem | null> {
  const settings = readSurfaceEmailSettings(getConfig);
  if (
    settings.imapHost === undefined
    || settings.smtpHost === undefined
    || settings.username === undefined
  ) {
    return {
      message: 'Email is not configured. Set surfaces.email.host, surfaces.email.user, and the email password secret.',
      code: 'EMAIL_NOT_CONFIGURED',
    };
  }
  const password = await firstStoredSecret(secrets, SHARED_PASSWORD_CHAIN);
  if (password === null) {
    return {
      message: 'Email password secret is missing from the daemon credential store.',
      code: 'EMAIL_CREDENTIALS_MISSING',
    };
  }
  return null;
}

/**
 * The same `EmailService` deps, reading the daemon's mailbox instead of the
 * `email.*` namespace. Everything else — transport, sender-claim describer,
 * ingest recorder, socket overrides — is passed through unchanged.
 */
export function withSurfaceEmailConfig(deps: EmailServiceDeps): EmailServiceDeps {
  return {
    ...deps,
    getConfig: createSurfaceEmailConfigReader(deps.getConfig),
    secretsManager: createSurfaceEmailSecretReader(deps.secretsManager),
  };
}
