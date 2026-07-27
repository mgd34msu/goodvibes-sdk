/**
 * Minimal IMAP4rev1 client over an injectable transport socket.
 *
 * Scope and honest boundaries
 * ────────────────────────────
 * Supported:
 *   - LOGIN with plain credentials (tag AUTH LOGIN user pass)
 *   - EXAMINE <mailbox> (read-only SELECT; messages are never marked \Seen)
 *   - SEARCH UNSEEN and SEARCH SINCE <date>
 *   - FETCH BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID TO AUTHENTICATION-RESULTS
 *     DELIVERED-TO X-ORIGINAL-TO)] — envelope plus delivery evidence
 *
 * Delivered-to vs To:
 * ────────────────────
 * The address a message was actually delivered to is NOT the To: header, and
 * it is NOT IMAP's ENVELOPE To field — RFC 3501 builds ENVELOPE by parsing the
 * message headers, so both are written by the sender and both are forgeable.
 * This client reports, in descending order of trust: the mailbox it read from,
 * then the top-most Delivered-To/X-Original-To stamped by the delivery agent.
 * The To: header is surfaced only as `unverifiedToHeaderClaim`.
 *   - FETCH BODY.PEEK[TEXT]<0.N> — bounded plain-text body preview
 *   - UID FETCH of one whole message: headers, BODYSTRUCTURE, and only the
 *     text/plain and text/html sections. Attachments are REPORTED, never
 *     downloaded — see `fetchMessage`.
 *   - APPEND of a draft with the \Draft flag, to the folder the server flags
 *     `\Drafts` (RFC 6154) rather than to a hardcoded name — see `appendDraft`
 *   - XOAUTH2 pass-through: if imapPassword starts with 'Bearer ' the client
 *     sends AUTHENTICATE XOAUTH2 with the base64-encoded SASL token; token
 *     acquisition is out of scope.
 *   - {n} literal continuations on server responses, counted in bytes
 *   - Per-await timeouts via AbortSignal
 *   - LOGOUT
 *
 * Sequence numbers vs UIDs
 * ────────────────────────
 * `searchUnseen`/`searchAll` return sequence numbers, which are only valid
 * inside the session that produced them. `fetchMessage` therefore speaks UID
 * FETCH: the caller that reads a message is a later request holding an
 * identifier from an earlier listing, and a sequence number from then may by
 * now belong to a different message.
 *
 * Not supported (document boundaries):
 *   - IDLE / NOTIFY push
 *   - STARTTLS upgrade (use TLS-direct port 993)
 *   - Attachment CONTENT — metadata only, deliberately
 *   - COPY, MOVE, EXPUNGE, STORE, and every other flag or deletion command
 *   - Credentials are never logged; callers must not log them either
 *
 * Transport injection
 * ────────────────────
 * Accept a `SocketLike` instead of creating a TLS socket directly so that
 * unit tests can supply a plain net.Socket connected to an in-process fake
 * server.  Production callers pass the result of `createImapTlsSocket()`,
 * which lives in the sibling `email/node` entry so that importing this module
 * never drags a runtime-specific implementation in behind it.
 */

import type { Socket } from 'node:net';
import {
  attachmentsFromParts,
  decodeTextPart,
  extractBodyStructure,
  extractFetchSection,
  hasFetchResponse,
  parseBodyStructure,
  selectBodyPart,
  type ImapBodyPart,
} from './imap-bodystructure.js';
import {
  DEFAULT_DRAFTS_MAILBOX,
  buildDraftMessage,
  parseAppendUid,
  selectDraftsMailbox,
  validateDraftInput,
} from './imap-draft.js';
import {
  extractAuthenticationResults,
  extractDeliveryEvidence,
  extractHeader,
  parseFetchBody,
  parseFetchHeaders,
  parseSequenceNumbers,
  formatImapDate,
  type DeliveryEvidence,
} from './imap-headers.js';
import { ImapSession } from './imap-session.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImapEnvelope {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
  /**
   * The mailbox this message was fetched from (the EXAMINE target).
   * Strongest delivery evidence: a per-signup alias mailbox exists only for
   * that signup, so the sender cannot influence which mailbox we read.
   */
  readonly mailbox: string;
  /**
   * Delivery evidence addresses, top-most first. Safe to correlate against.
   * Empty when the delivery agent stamped nothing we can trust — callers must
   * then fall back to the mailbox, never to `unverifiedToHeaderClaim`.
   */
  readonly deliveredTo: readonly string[];
  /** The same values as `deliveredTo`, with provenance attached. */
  readonly deliveryEvidence: readonly DeliveryEvidence[];
  /**
   * The To: header, verbatim, for DISPLAY ONLY.
   *
   * This is authored by whoever sent the message. Anyone can put any address
   * here, including an address we are waiting on. Correlating on this value
   * lets a stranger claim a pending verification. Never compare it to an
   * expected recipient; use `deliveredTo` or `mailbox` for that.
   */
  readonly unverifiedToHeaderClaim: string;
  /**
   * `Authentication-Results` values, top-most first.
   *
   * Written by the receiving mail server, so — like the delivery headers —
   * only the top-most is beyond the sender's reach. Feeds DISPLAY confidence
   * on the sender line and nothing else; no permission anywhere reads it.
   */
  readonly authenticationResults: readonly string[];
}

export interface ImapMessage extends ImapEnvelope {
  readonly bodyPreview: string;
}

/**
 * One whole message: everything an envelope carries, plus its readable text.
 *
 * Extends `ImapEnvelope` rather than restating it so the provenance rules that
 * govern a listing govern a full read identically — the mailbox it came from,
 * the delivery evidence, the `To:` header still named as an unverified claim,
 * and the sender-authentication results still carrying no authority. A second
 * shape here would be a second, weaker labelling of the same untrusted text.
 *
 * `bodyText` and `bodyHtml` are attacker-controlled: they are whatever the
 * sender wrote. `EmailService.readMessage` records the untrusted ingest for
 * them exactly as the inbox listing does.
 */
export interface ImapMessageDetail extends ImapEnvelope {
  /** Decoded text/plain body, '' when the message has none. */
  readonly bodyText: string;
  /** Decoded text/html body, '' when the message has none. */
  readonly bodyHtml: string;
  /** What is attached, described. Never the attached bytes — see `fetchMessage`. */
  readonly attachments: readonly ImapAttachmentInfo[];
}

/**
 * An attachment as the server described it. METADATA ONLY: this is read out of
 * the message's BODYSTRUCTURE, and no code path in this module fetches an
 * attachment's content.
 */
export interface ImapAttachmentInfo {
  /** Filename the sender chose. '' when the part carries none. */
  readonly filename: string;
  /** Lowercased `type/subtype`, e.g. `application/pdf`. */
  readonly contentType: string;
  /** Size in bytes as the server reported it; 0 when it reported none. */
  readonly sizeBytes: number;
}

/** The fields an APPENDed draft is built from. */
export interface ImapAppendDraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly from: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
  /** Overrides Drafts-folder discovery. */
  readonly mailbox?: string | undefined;
}

/** Where an appended draft landed, and under which UID if the server said. */
export interface ImapAppendDraftResult {
  /** The APPENDUID the server reported (RFC 4315), or null when it reported none. */
  readonly uid: number | null;
  /** The mailbox the draft was appended to, after discovery. */
  readonly mailbox: string;
}

export interface ImapClientOptions {
  /** Pre-connected socket (TLS for prod, plain for tests). */
  readonly socket: Socket;
  /** IMAP LOGIN username. */
  readonly username: string;
  /** IMAP LOGIN password or 'Bearer <token>' for XOAUTH2 pass-through. */
  readonly password: string;
  /** Per-operation timeout in milliseconds. Default: 15 000. */
  readonly timeoutMs?: number;
  /** Maximum body preview bytes to fetch. Default: 4096. */
  readonly maxBodyBytes?: number;
  /**
   * Mailbox to EXAMINE and fetch from. Default: 'INBOX'.
   * Reported back on every envelope as `mailbox` so callers can correlate on
   * "which alias mailbox did this land in" rather than on message content.
   */
  readonly mailbox?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-operation timeout, and the connect timeout used by the node adapter. */
export const IMAP_DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 4_096;

function buildXOAuth2Token(username: string, bearerToken: string): string {
  const sasl = `user=${username}\x01auth=${bearerToken}\x01\x01`;
  return Buffer.from(sasl).toString('base64');
}

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
// Public client
// ---------------------------------------------------------------------------

const DEFAULT_MAILBOX = 'INBOX';

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
function formatMailboxName(mailbox: string): string {
  const encoded = toModifiedUtf7(mailbox);
  return /^[A-Za-z0-9._/-]+$/.test(encoded)
    ? encoded
    : imapQuoteCredential(encoded, 'mailbox name');
}

export class ImapClient {
  private readonly options: ImapClientOptions;

  constructor(options: ImapClientOptions) {
    this.options = options;
  }

  /**
   * The mailbox this client reads from. Reported on every envelope; callers
   * correlating a verification message should prefer this over any header.
   */
  get mailbox(): string {
    const configured = this.options.mailbox;
    return configured !== undefined && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_MAILBOX;
  }

  /**
   * Connect and authenticate. Must be called before any fetch operations.
   * Uses EXAMINE (read-only) so messages are never marked \Seen.
   */
  async open(): Promise<void> {
    const session = this.session();
    await session.readGreeting();
    await this.authenticate(session);
    await session.command(`EXAMINE ${formatMailboxName(this.mailbox)}`);
  }

  /**
   * Search for unseen messages. Returns sequence numbers.
   * Pass sinceDate to restrict to messages since a date.
   */
  async searchUnseen(sinceDate?: Date): Promise<number[]> {
    const session = this.session();
    const criterion = sinceDate
      ? `UNSEEN SINCE ${formatImapDate(sinceDate)}`
      : 'UNSEEN';
    const lines = await session.command(`SEARCH ${criterion}`);
    return parseSequenceNumbers(lines);
  }

  /**
   * Search every message in the mailbox, not only the unread ones.
   * Returns sequence numbers, like `searchUnseen`.
   *
   * Exists because a caller that asked for "all mail" must not be quietly
   * served "unread mail": a listing that advertises an unread-only switch has
   * to honour both of its positions.
   */
  async searchAll(sinceDate?: Date): Promise<number[]> {
    const session = this.session();
    const criterion = sinceDate ? `SINCE ${formatImapDate(sinceDate)}` : 'ALL';
    const lines = await session.command(`SEARCH ${criterion}`);
    return parseSequenceNumbers(lines);
  }

  /**
   * Fetch envelope headers for an array of sequence numbers.
   * Uses BODY.PEEK so messages remain unread.
   * Returns at most `limit` messages (most recent first, approximate).
   */
  async fetchEnvelopes(seqNums: readonly number[], limit = 20): Promise<ImapEnvelope[]> {
    if (seqNums.length === 0) return [];
    const session = this.session();
    const bounded = seqNums.slice(-limit); // take the last N (highest seq = newest)
    const set = bounded.join(',');
    const lines = await session.command(
      `FETCH ${set} BODY.PEEK[HEADER.FIELDS ` +
      `(FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO AUTHENTICATION-RESULTS)]`,
    );
    const headersMap = parseFetchHeaders(lines);
    const mailbox = this.mailbox;
    const envelopes: ImapEnvelope[] = [];
    for (const seqNum of bounded) {
      const raw = headersMap[seqNum] ?? '';
      const deliveryEvidence = extractDeliveryEvidence(raw);
      envelopes.push({
        uid: seqNum,
        from: extractHeader(raw, 'From'),
        subject: extractHeader(raw, 'Subject'),
        date: extractHeader(raw, 'Date'),
        messageId: extractHeader(raw, 'Message-ID'),
        mailbox,
        deliveredTo: deliveryEvidence.map((entry) => entry.address),
        deliveryEvidence,
        // Display only — see the field docs on ImapEnvelope.
        unverifiedToHeaderClaim: extractHeader(raw, 'To'),
        authenticationResults: extractAuthenticationResults(raw),
      });
    }
    return envelopes;
  }

  /**
   * Fetch a bounded body preview for a single message.
   * Uses BODY.PEEK[TEXT]<0.N> so message stays unread.
   */
  async fetchBodyPreview(seqNum: number): Promise<string> {
    const session = this.session();
    const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const lines = await session.command(
      `FETCH ${seqNum} BODY.PEEK[TEXT]<0.${maxBytes}>`,
    );
    const bodyMap = parseFetchBody(lines);
    return (bodyMap[seqNum] ?? '').slice(0, maxBytes);
  }

  /**
   * Fetch one whole message by UID: its headers, its readable text, and a
   * description of what is attached to it.
   *
   * **UID, not sequence number.** A sequence number is only meaningful inside
   * the session that produced it; the caller here is holding an identifier
   * from an earlier listing, so anything else would risk reading a different
   * message than the one asked for.
   *
   * **Read-only.** Every section is fetched with `BODY.PEEK[...]`. Plain
   * `BODY[...]` sets `\Seen`, which would mean reading the owner's mail marked
   * it read behind their back — for a daemon answering mail unattended, that
   * is a visible change to their mailbox nobody asked for.
   *
   * **Attachments are described, never downloaded.** The parts list comes from
   * BODYSTRUCTURE and only the text/plain and text/html sections are fetched.
   * A message with a 30 MB archive on it costs the same to read as one without.
   *
   * Returns null when the UID is not in the mailbox. A deleted or expunged
   * message is an ordinary answer to an ordinary question — the caller asked
   * about something that is gone — and reporting it as a server failure would
   * make callers treat a normal outcome as an outage.
   */
  async fetchMessage(uid: number): Promise<ImapMessageDetail | null> {
    const session = this.session();

    const headerLines = await session.command(`UID FETCH ${uid} BODY.PEEK[HEADER]`);
    if (!hasFetchResponse(headerLines)) return null;
    const rawHeaders = extractFetchSection(headerLines) ?? '';

    const structureLines = await session.command(`UID FETCH ${uid} BODYSTRUCTURE`);
    const parts = parseBodyStructure(extractBodyStructure(structureLines));

    const textPart = selectBodyPart(parts, 'plain');
    const htmlPart = selectBodyPart(parts, 'html');
    let bodyText = textPart === null ? '' : await this.fetchTextSection(session, uid, textPart);
    let bodyHtml = htmlPart === null ? '' : await this.fetchTextSection(session, uid, htmlPart);

    if (parts.length === 0) {
      // The server's own description of the message was unreadable. Falling
      // back to BODY.PEEK[TEXT] is safe ONLY when the headers say the message
      // is a single text part — on a multipart message that section is every
      // part concatenated, including the encoded attachments this method
      // exists not to download, so it stays unfetched and the body reads empty.
      const contentType = extractHeader(rawHeaders, 'Content-Type').toLowerCase();
      if (contentType.length === 0 || contentType.startsWith('text/')) {
        const lines = await session.command(`UID FETCH ${uid} BODY.PEEK[TEXT]`);
        const raw = (extractFetchSection(lines) ?? '').replace(/\r\n/g, '\n');
        if (contentType.startsWith('text/html')) bodyHtml = raw;
        else bodyText = raw;
      }
    }

    const deliveryEvidence = extractDeliveryEvidence(rawHeaders);
    return {
      uid,
      from: extractHeader(rawHeaders, 'From'),
      subject: extractHeader(rawHeaders, 'Subject'),
      date: extractHeader(rawHeaders, 'Date'),
      messageId: extractHeader(rawHeaders, 'Message-ID'),
      mailbox: this.mailbox,
      deliveredTo: deliveryEvidence.map((entry) => entry.address),
      deliveryEvidence,
      // Display only — see the field docs on ImapEnvelope.
      unverifiedToHeaderClaim: extractHeader(rawHeaders, 'To'),
      authenticationResults: extractAuthenticationResults(rawHeaders),
      bodyText,
      bodyHtml,
      attachments: attachmentsFromParts(parts),
    };
  }

  /**
   * Append a draft to the Drafts folder with the `\Draft` flag.
   *
   * The message is uploaded as an IMAP literal whose declared length is its
   * length in BYTES. A subject or body with any non-ASCII character in it is
   * longer in bytes than in characters, and a count taken from `.length` would
   * leave the tail of the message being read by the server as commands.
   *
   * The target folder is discovered, not assumed: `LIST` first, prefer the
   * folder the server flagged `\Drafts`, then a name match, then the plain
   * `Drafts` name. Gmail's is `[Gmail]/Drafts`, and appending to a literal
   * `Drafts` there creates a stray folder the owner never sees.
   *
   * Every caller-supplied field is validated before a byte is written; a CR or
   * LF in any of them is refused, never stripped.
   *
   * `uid` is the APPENDUID the server reported (RFC 4315 UIDPLUS) and null
   * when it advertised none — no id is invented to fill the field.
   *
   * Requires `open()`. APPEND writes to the Drafts mailbox only; the mailbox
   * this client reads from stays EXAMINEd, and stays read-only.
   */
  async appendDraft(input: ImapAppendDraftInput): Promise<ImapAppendDraftResult> {
    validateDraftInput(input);

    const session = this.session();
    const mailbox = await this.resolveDraftsMailbox(session, input.mailbox);
    const message = buildDraftMessage(input, new Date());
    const lines = await session.commandWithLiteral(
      `APPEND ${formatMailboxName(mailbox)} (\\Draft)`,
      message,
    );
    return { uid: parseAppendUid(lines), mailbox };
  }

  /** Send LOGOUT and destroy the socket. */
  async logout(): Promise<void> {
    const session = this.session();
    try {
      await session.command('LOGOUT');
    } finally {
      session.destroy();
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Fetch and decode one text section, read-only.
   *
   * Best-effort in the same way the inbox listing's body preview already is: a
   * section that cannot be read — a literal over the session cap, a server
   * that refuses that part — leaves that one body empty instead of failing a
   * read whose headers and attachment list already succeeded.
   */
  private async fetchTextSection(
    session: ImapSession,
    uid: number,
    part: ImapBodyPart,
  ): Promise<string> {
    try {
      const lines = await session.command(`UID FETCH ${uid} BODY.PEEK[${part.section}]`);
      return decodeTextPart(extractFetchSection(lines) ?? '', part.encoding, part.charset);
    } catch {
      return '';
    }
  }

  /**
   * Where a draft should go: the caller's override, else what the server says,
   * else the plain `Drafts` name as a last resort — including when LIST itself
   * fails, since an unanswered question about folders is not a reason to lose
   * the draft.
   */
  private async resolveDraftsMailbox(
    session: ImapSession,
    override: string | undefined,
  ): Promise<string> {
    const explicit = (override ?? '').trim();
    if (explicit.length > 0) return explicit;
    try {
      const lines = await session.command('LIST "" "*"');
      return selectDraftsMailbox(lines) ?? DEFAULT_DRAFTS_MAILBOX;
    } catch {
      return DEFAULT_DRAFTS_MAILBOX;
    }
  }

  private session(): ImapSession {
    const maxBodyBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    // Cap literal size at the larger of 1 MB or 4× the configured body preview limit
    const literalCap = Math.max(1_048_576, 4 * maxBodyBytes);
    return new ImapSession(
      this.options.socket,
      this.options.timeoutMs ?? IMAP_DEFAULT_TIMEOUT_MS,
      literalCap,
    );
  }

  private async authenticate(session: ImapSession): Promise<void> {
    const { username, password } = this.options;
    if (password.startsWith('Bearer ')) {
      // XOAUTH2 pass-through
      const token = buildXOAuth2Token(username, password.slice(7));
      await session.command(`AUTHENTICATE XOAUTH2 ${token}`);
    } else {
      // LOGIN — credentials are quoted per RFC 3501 to prevent injection.
      // Credentials are not logged anywhere in this module.
      const quotedUser = imapQuoteCredential(username, 'username');
      const quotedPass = imapQuoteCredential(password, 'password');
      await session.command(`LOGIN ${quotedUser} ${quotedPass}`);
    }
  }
}
