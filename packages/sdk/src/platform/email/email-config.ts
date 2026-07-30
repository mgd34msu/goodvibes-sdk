/**
 * Reading the email config, and resolving the one secret it points at.
 *
 * Split out of `email-service.ts` to keep that file under the repository's
 * per-file line cap. Nothing here opens a socket: every function takes plain
 * values and a secret store, which is what lets the validation rules and the
 * credential-scope rule be exercised without a mail server.
 */

import { ownerMessageForFailure } from './imap-open.js';
import type { EmailCapabilityFailureNotice } from './imap-open.js';
// Type-only, so this is erased at build time and no runtime cycle exists
// between the two halves of what used to be one file.
import type {
  EmailConfig,
  EmailSocketFactory,
  EmailTransportPort,
  ImapSecurityMode,
  SmtpSecurityMode,
} from './email-service.js';

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

/**
 * `email.imapSecurity`, defaulting to TLS.
 *
 * Anything unrecognised — including an absent value, which is what a config that
 * predates the key produces — reads as 'tls'. The safe direction for a value
 * nobody can interpret is the encrypted connection, so the only way to get a
 * plaintext IMAP connection is to ask for one.
 */
function readImapSecurity(value: unknown): ImapSecurityMode {
  return value === 'plaintext' ? 'plaintext' : 'tls';
}

/**
 * Which transport member opens the IMAP connection.
 *
 * The IMAP counterpart of the SMTP selection in `EmailService`, and here rather
 * than beside it because that file is at the repository's per-file line cap.
 *
 * A transport with no `connectImapPlain` cannot honour a plaintext request, and
 * is refused by name: silently handing back the TLS factory would open a TLS
 * handshake against a plain listener and report a protocol error from a port the
 * operator never asked to be encrypted.
 */
export function imapSocketFactoryFor(
  transport: Pick<EmailTransportPort, 'connectImapTls' | 'connectImapPlain'>,
  security: ImapSecurityMode | undefined,
): EmailSocketFactory {
  if (security !== 'plaintext') return transport.connectImapTls;
  const plain = transport.connectImapPlain;
  if (!plain) {
    throw new Error(
      'surfaces.email.imap.secure is false, which asks for a plaintext IMAP connection, '
      + 'and this email transport provides no connectImapPlain to open one.',
    );
  }
  return plain;
}

export function readEmailConfig(getConfig: (key: string) => unknown): EmailConfig {
  return {
    enabled: readBoolean(getConfig('email.enabled'), false),
    imapHost: readString(getConfig('email.imapHost')),
    imapPort: readNumber(getConfig('email.imapPort'), 993),
    imapSecurity: readImapSecurity(getConfig('email.imapSecurity')),
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

/**
 * A mail password that is not where this process reads secrets.
 *
 * Carries the same routable `notice` an `ImapOpenError` does, so a supervisor
 * delivers a missing credential to the owner by the same path it delivers a
 * rejected one. Terminal: nothing about waiting makes a secret appear.
 */
export class EmailCredentialUnavailableError extends Error {
  readonly notice: EmailCapabilityFailureNotice;

  constructor(detail: string) {
    const ownerMessage = ownerMessageForFailure('credential-unavailable', '');
    super(`${ownerMessage} ${detail}`);
    this.name = 'EmailCredentialUnavailableError';
    this.notice = {
      reason: 'credential-unavailable',
      terminal: true,
      mailbox: '',
      ownerMessage,
      serverMessage: detail,
    };
  }
}

/**
 * Resolve the mail password from the secret store this process was given.
 *
 * ONE store is consulted: the one the composition root handed in, which for
 * the daemon is the daemon's own. There is deliberately no fallback to a
 * surface-local store. A credential captured by another surface is not visible
 * here, and reaching for it would produce a capability that works on the
 * machine where it happened to be captured and fails on every other one —
 * which is a far harder failure to diagnose than a missing secret. A secret
 * that is not here is reported as missing, by name, with the step that fixes
 * it.
 */
export async function resolveEmailPassword(
  passwordRef: string,
  secretsManager: { readonly get: (key: string) => Promise<string | null> },
): Promise<string> {
  const key = extractSecretKey(passwordRef);
  const value = await secretsManager.get(key);
  if (!value) {
    throw new EmailCredentialUnavailableError(
      `email.passwordRef names '${key}', and no secret by that name was found.`,
    );
  }
  return value;
}

