/**
 * Writing one draft: header safety, message composition, Drafts discovery.
 *
 * Headers are built, not concatenated
 * ───────────────────────────────────
 * `appendDraft` turns caller-supplied strings into real RFC 5322 header lines.
 * A bare CR or LF anywhere in `to`, `from`, `subject`, `inReplyTo` or
 * `references` would end the header being written and start one the caller
 * chose — `Bcc:` being the one that matters, because a draft the owner later
 * sends would carry it. Every field is REFUSED rather than sanitized: silently
 * stripping the newline would send something the caller did not ask for, and a
 * caller that meant to inject learns nothing from a rejection but an attacker
 * whose payload was quietly trimmed learns which filter to try next.
 *
 * The address and subject checks are the SMTP module's own
 * (`validateSmtpAddress`, `validateSmtpSubject`), reused rather than restated
 * so that both ways of getting a message out of this module agree on what is
 * allowed.
 *
 * Finding the Drafts folder
 * ─────────────────────────
 * `"Drafts"` is a guess that is wrong on the most common mail host there is:
 * Gmail's is `[Gmail]/Drafts`, and appending to a literal `Drafts` there
 * creates a new stray folder instead. `selectDraftsMailbox` reads the LIST
 * reply and prefers the folder the server itself flagged `\Drafts`
 * (RFC 6154), which is the only answer that is right by construction.
 */

import type { ImapAppendDraftInput } from './imap-client.js';
import { validateSmtpAddress, validateSmtpSubject } from './smtp-client.js';

const CRLF = '\r\n';

/** The fallback when a server tells us nothing about its folders. */
export const DEFAULT_DRAFTS_MAILBOX = 'Drafts';

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

/** CR, LF, and the other C0 and C1 control characters — same set as the SMTP side. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Validate a header value that is neither an address nor a subject —
 * `In-Reply-To` and `References`, both of which hold message ids.
 *
 * @throws Error with a plain-language message on invalid input.
 */
export function validateDraftHeaderValue(value: string, field: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: header values must not contain control characters (CR, LF, etc.).`,
    );
  }
}

/**
 * Refuse a draft whose fields would forge headers, before anything is sent.
 * Called by `appendDraft` ahead of any server conversation, and again by
 * `buildDraftMessage` so the composer is safe on its own.
 */
export function validateDraftInput(input: ImapAppendDraftInput): void {
  validateSmtpAddress(input.from, 'from');
  validateSmtpAddress(input.to, 'to');
  validateSmtpSubject(input.subject);
  if (input.inReplyTo !== undefined) {
    validateDraftHeaderValue(input.inReplyTo, 'inReplyTo');
  }
  if (input.references !== undefined) {
    validateDraftHeaderValue(input.references, 'references');
  }
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

const RFC5322_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC5322_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** `Mon, 27 Jul 2026 14:03:05 +0000` — RFC 5322 §3.3, always in UTC. */
export function formatRfc5322Date(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = RFC5322_DAYS[date.getUTCDay()] ?? 'Mon';
  const month = RFC5322_MONTHS[date.getUTCMonth()] ?? 'Jan';
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** Bytes of UTF-8 per encoded-word, chosen so each folded line stays under 76. */
const ENCODED_WORD_BYTE_BUDGET = 45;

/**
 * Encode a header value as RFC 2047 encoded-words when it is not plain ASCII.
 *
 * A subject in any language other than English is the ordinary case, not an
 * edge one, and mail clients read `=?UTF-8?B?..?=` everywhere while raw UTF-8
 * in a header is only understood by servers that announce RFC 6532 support.
 * Long values are split on character boundaries and folded, because an
 * encoded-word longer than 75 characters is not one.
 */
export function encodeHeaderValue(value: string): string {
  if (!/[^\x20-\x7e]/.test(value)) return value;

  const words: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  for (const char of value) {
    const width = Buffer.byteLength(char, 'utf8');
    if (chunkBytes + width > ENCODED_WORD_BYTE_BUDGET && chunk.length > 0) {
      words.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += width;
  }
  if (chunk.length > 0) words.push(chunk);

  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `);
}

/**
 * Compose the RFC 5322 message an APPEND uploads.
 *
 * The body goes out as UTF-8 with `Content-Transfer-Encoding: 8bit` rather
 * than being re-encoded, so what the owner later sees in the draft is exactly
 * the text that was handed in. That is also why the caller must count the
 * literal in bytes: this string is longer in bytes than in characters for any
 * body that is not pure ASCII.
 *
 * No `Message-ID` is written. The message has not been sent, and the id that
 * matters is the one the sending path stamps at send time; a second one
 * invented here would never match it.
 *
 * @throws Error when any field would forge a header.
 */
export function buildDraftMessage(input: ImapAppendDraftInput, now: Date): string {
  validateDraftInput(input);

  const headers = [
    `Date: ${formatRfc5322Date(now)}`,
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
  ];
  if (input.inReplyTo !== undefined && input.inReplyTo.length > 0) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
  }
  if (input.references !== undefined && input.references.length > 0) {
    headers.push(`References: ${input.references}`);
  }
  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset=utf-8');
  headers.push('Content-Transfer-Encoding: 8bit');

  const body = input.body.replace(/\r\n/g, '\n').replace(/\n/g, CRLF);
  const terminated = body.endsWith(CRLF) ? body : `${body}${CRLF}`;
  return `${headers.join(CRLF)}${CRLF}${CRLF}${terminated}`;
}

// ---------------------------------------------------------------------------
// LIST reading: which folder is Drafts
// ---------------------------------------------------------------------------

interface MailboxEntry {
  readonly name: string;
  readonly attributes: readonly string[];
  readonly delimiter: string;
}

const LIST_LINE = /^\* (?:LIST|LSUB|XLIST) \(([^)]*)\)\s+(?:"((?:[^"\\]|\\.)*)"|NIL)\s+(.*)$/i;

function unquoteMailboxName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    let out = '';
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed.charAt(i);
      if (ch === '\\' && i + 1 < trimmed.length) {
        out += trimmed.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  // Atom form, or a literal the session already inlined; take the first token.
  return trimmed.split(/\s+/)[0] ?? '';
}

/** Parse the mailboxes out of a LIST reply. Unreadable lines are skipped. */
export function parseMailboxList(lines: readonly string[]): MailboxEntry[] {
  const entries: MailboxEntry[] = [];
  for (const line of lines) {
    const match = LIST_LINE.exec(line);
    if (match === null) continue;
    const name = unquoteMailboxName(match[3] ?? '');
    if (name.length === 0) continue;
    entries.push({
      name,
      attributes: (match[1] ?? '').split(/\s+/).filter((a) => a.length > 0).map((a) => a.toLowerCase()),
      delimiter: match[2] ?? '',
    });
  }
  return entries;
}

/**
 * Choose the Drafts mailbox from a LIST reply, in descending order of how much
 * the server actually told us:
 *
 *   1. the folder carrying the `\Drafts` special-use attribute (RFC 6154) —
 *      the server's own answer, and the only one that survives a mailbox named
 *      in another language;
 *   2. a folder literally named `drafts`, case-insensitively;
 *   3. a folder whose last path segment is `drafts` — this is what finds
 *      Gmail's `[Gmail]/Drafts`;
 *
 * and null when the reply names none of those, which leaves the caller to fall
 * back to the plain `Drafts` name.
 *
 * `\Noselect` folders are skipped throughout: they are path nodes, and an
 * APPEND to one fails.
 */
export function selectDraftsMailbox(lines: readonly string[]): string | null {
  const entries = parseMailboxList(lines).filter(
    (entry) => !entry.attributes.includes('\\noselect'),
  );

  for (const entry of entries) {
    if (entry.attributes.includes('\\drafts')) return entry.name;
  }
  for (const entry of entries) {
    if (entry.name.toLowerCase() === 'drafts') return entry.name;
  }
  for (const entry of entries) {
    const delimiter = entry.delimiter.length > 0 ? entry.delimiter : '/';
    const segments = entry.name.split(delimiter);
    if ((segments[segments.length - 1] ?? '').toLowerCase() === 'drafts') return entry.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// APPENDUID
// ---------------------------------------------------------------------------

const APPENDUID = /\[APPENDUID\s+\d+\s+(\d+)\]/i;

/**
 * The UID the server assigned the appended message, when it advertises UIDPLUS
 * (RFC 4315) and says so in its tagged reply.
 *
 * Returns null when it does not. Nothing is guessed: a server that reports no
 * UID leaves the caller with `uid: null`, which is true, rather than with a
 * number that points at a different message.
 */
export function parseAppendUid(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = APPENDUID.exec(line);
    if (match === null) continue;
    const uid = parseInt(match[1] ?? '', 10);
    if (isFinite(uid) && uid > 0) return uid;
  }
  return null;
}
