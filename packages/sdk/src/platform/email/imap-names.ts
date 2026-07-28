/**
 * Names and credentials as they go on the IMAP wire.
 *
 * Both problems here are the same problem: IMAP's wire format is 7-bit and
 * quoted, and a value that is not encoded for it either breaks the command or
 * — worse — extends it. A password with a newline in it would add a line the
 * server reads as a command; a Drafts folder called `Entwurfe` with an umlaut
 * cannot be written at all without modified UTF-7. Split out of
 * `imap-client.ts` to keep that file under the repository's per-file line cap.
 */

// ---------------------------------------------------------------------------
// IMAP credential quoting: LOGIN injection prevention
// ---------------------------------------------------------------------------

/**
 * Reject credentials containing CR or LF — these cannot be safely represented
 * in any IMAP quoted-string or literal.
 * Then return the credential as an RFC 3501 quoted string:
 *   - backslashes escaped as \\\\
 *   - double-quotes escaped as \\"
 * If the result would contain characters outside of printable US-ASCII
 * (which quoted strings cannot hold per RFC 3501), throw a plain-language error.
 */
export function imapQuoteCredential(value: string, name: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Invalid IMAP ${name}: credentials must not contain carriage return or newline characters.`,
    );
  }
  // RFC 3501 quoted-string is 7-bit only: only printable US-ASCII (0x20–0x7E) is
  // allowed. Reject anything outside that range — control chars (0x00–0x1F, 0x7F)
  // and 8-bit bytes (0x80–0xFF) both produce malformed wire data.
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(
      `Invalid IMAP ${name}: credentials must be printable US-ASCII characters; 8-bit or control characters aren't supported.`,
    );
  }
  // Escape backslash and double-quote per RFC 3501 §4.3
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// Mailbox names
// ---------------------------------------------------------------------------

/** The mailbox read when none is configured. */
export const DEFAULT_MAILBOX = 'INBOX';

/**
 * Encode a mailbox name as RFC 3501 §5.1.3 modified UTF-7.
 *
 * IMAP mailbox names are 7-bit on the wire, so a folder called `Entwürfe` or
 * `Черновики` — which is what a Drafts folder is called on most of the
 * planet — has to be written `Entw&APw-rfe`. Without this, every non-English
 * mailbox name is simply unusable: the quoted-string form rejects 8-bit
 * characters outright, which would have made "save a draft" work only for
 * people whose mail is in English.
 *
 * Runs of non-ASCII are base64'd as UTF-16BE with `/` written `,` and padding
 * dropped; a literal `&` becomes `&-`.
 */
function toModifiedUtf7(mailbox: string): string {
  let out = '';
  let run = '';
  const flush = (): void => {
    if (run.length === 0) return;
    const utf16be = Buffer.from(run, 'utf16le').swap16();
    out += `&${utf16be.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    run = '';
  };
  for (const char of mailbox) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '&') {
      flush();
      out += '&-';
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char;
      continue;
    }
    run += char;
  }
  flush();
  return out;
}

/**
 * Mailbox names that are plain atoms go on the wire bare; anything else is
 * sent as an RFC 3501 quoted string so spaces and delimiters stay intact.
 * Non-ASCII names are encoded first — see `toModifiedUtf7`.
 */
export function formatMailboxName(mailbox: string): string {
  const encoded = toModifiedUtf7(mailbox);
  return /^[A-Za-z0-9._/-]+$/.test(encoded)
    ? encoded
    : imapQuoteCredential(encoded, 'mailbox name');
}
