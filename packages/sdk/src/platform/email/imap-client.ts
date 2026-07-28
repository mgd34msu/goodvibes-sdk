/**
 * Minimal IMAP4rev1 client over an injected socket.
 *
 * Scope and honest boundaries
 * ────────────────────────────
 * Every line below was checked against the code that sends the bytes. A header
 * that claims a capability the file does not have is worse than no header: the
 * claim gets believed, designed against, and depended on. This one previously
 * advertised "per-await timeouts via AbortSignal" when no AbortSignal existed
 * anywhere in the module, a `SocketLike` type that was never declared, and a
 * `LOGIN` wire format with an `AUTH` token that is not sent.
 *
 * Commands this client actually sends:
 *   - `LOGIN "<user>" "<pass>"` — credentials as RFC 3501 quoted strings. No
 *     `AUTH` verb: the tag is followed directly by LOGIN.
 *   - `AUTHENTICATE XOAUTH2 <base64>` instead, when `ImapClientOptions.password`
 *     starts with `Bearer `. Acquiring that token is out of scope.
 *   - `CAPABILITY`, lazily and at most once, and only when the server
 *     volunteered no capabilities in its greeting, its login completion or its
 *     EXAMINE response — see `capabilities()`.
 *   - `EXAMINE <mailbox>` (read-only SELECT; messages are never marked \Seen)
 *   - `UID SEARCH UNSEEN`, `UID SEARCH UNSEEN SINCE <date>`, `UID SEARCH ALL`
 *     and `UID SEARCH SINCE <date>`
 *   - `UID FETCH <set> (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE
 *     MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO AUTHENTICATION-RESULTS)])` —
 *     envelope plus delivery evidence, addressed and reported by UID
 *   - `UID FETCH <uid> BODY.PEEK[TEXT]<0.N>` — bounded plain-text preview
 *   - `UID FETCH <uid> BODY.PEEK[HEADER]`, `BODYSTRUCTURE`, and the
 *     text/plain and text/html sections only. Attachments are REPORTED, never
 *     downloaded — see `fetchMessage`.
 *   - `LIST "" "*"` — to find the folder the server flags `\Drafts` (RFC 6154)
 *     rather than appending to a hardcoded name
 *   - `APPEND <drafts> (\Draft) {n}` — see `appendDraft`
 *   - `LOGOUT`
 *
 * Also true of the wire session underneath (`imap-session.ts`):
 *   - `{n}` literal continuations on server responses, counted in BYTES
 *   - a per-operation read deadline on every command, and — through the
 *     connection handed to `imapConnection()` — a cancellable read with no
 *     deadline at all, for a caller that must wait in silence
 *
 * Not supported here, deliberately:
 *   - IDLE / NOTIFY push. The wire session does support holding a connection
 *     and dispatching untagged responses, which is what an IDLE loop is built
 *     on; the loop itself is not this file's job.
 *   - STARTTLS upgrade — there is no STARTTLS in this module. Use TLS-direct
 *     port 993.
 *   - Attachment CONTENT. Metadata only, from BODYSTRUCTURE.
 *   - COPY, MOVE, EXPUNGE, STORE, and every other flag or deletion command.
 *     APPEND is the only write, and it writes only to Drafts.
 *   - Logging of any kind. This file contains no logger and no console call,
 *     so credentials cannot leak through it; callers must not log them either.
 *
 * Delivered-to vs To:
 * ────────────────────
 * The address a message was actually delivered to is NOT the To: header, and
 * it is NOT IMAP's ENVELOPE To field — RFC 3501 builds ENVELOPE by parsing the
 * message headers, so both are written by the sender and both are forgeable.
 * This client reports, in descending order of trust: the mailbox it read from,
 * then the top-most Delivered-To/X-Original-To stamped by the delivery agent.
 * The To: header is surfaced only as `unverifiedToHeaderClaim`.
 *
 * Sequence numbers vs UIDs
 * ────────────────────────
 * Nothing this client reports is a sequence number. A sequence number is only
 * valid inside the session that produced it and renumbers on every expunge, so
 * one handed back to a caller who reads the message later — which is what
 * `email.inbox.list` then `email.inbox.read` is — names whatever message has
 * since taken that position. Every search is `UID SEARCH`, every envelope
 * fetch asks for the `UID` data item and reports what the server returned, and
 * every read is `UID FETCH`. The `uid` field of `ImapEnvelope` is a UID.
 *
 * One connection, one session
 * ───────────────────────────
 * `open()` builds the single `ImapSession` that owns the socket for the life
 * of the connection; every other method uses that one. Calling a fetch method
 * before `open()` fails rather than quietly building a second reader with a
 * fresh tag counter and an empty buffer. `open()` reports what the connection
 * turned out to be able to do, and fails with a named reason — see
 * `imap-open.ts`.
 *
 * Transport injection
 * ────────────────────
 * `ImapClientOptions.socket` is a `node:net` `Socket`, already connected. The
 * client never creates one, so a test supplies a plain socket pointed at an
 * in-process fake server and production supplies the result of
 * `createImapTlsSocket()`, which lives in the sibling `email/node` entry so
 * that importing this module never drags a runtime-specific implementation in
 * behind it.
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
  parseFetchUids,
  parseCapabilities,
  parseMailboxStatus,
  parseSearchNumbers,
  formatImapDate,
  type ImapMailboxStatus,
} from './imap-headers.js';
import { ImapSession } from './imap-session.js';
import type {
  ImapAppendDraftInput,
  ImapAppendDraftResult,
  ImapClientOptions,
  ImapEnvelope,
  ImapMessageDetail,
} from './imap-types.js';

// Re-exported so the client stays the one entry point callers already import.
export type {
  ImapAppendDraftInput,
  ImapAppendDraftResult,
  ImapAttachmentInfo,
  ImapClientOptions,
  ImapEnvelope,
  ImapMessage,
  ImapMessageDetail,
} from './imap-types.js';
import {
  DEFAULT_MAILBOX,
  formatMailboxName,
  imapQuoteCredential,
} from './imap-names.js';
import {
  NOT_OPEN_MESSAGE,
  NOT_PROBED,
  composeOpenFailure,
  forgetConnection,
  idleSupportFrom,
  rememberConnection,
  type ImapBodyProbeVerdict,
  type ImapConnectionReport,
} from './imap-open.js';

// Re-exported so the module's importers keep one entry point for the client
// and everything that describes opening it.
export { imapQuoteCredential } from './imap-names.js';
export {
  ImapOpenError,
  describeEmailCapabilityFailure,
  imapConnection,
  ownerMessageForFailure,
  resolveIdleSupport,
  type EmailCapabilityFailureNotice,
  type EmailCapabilityFailureReason,
  type ImapBodyProbeVerdict,
  type ImapConnectionReport,
  type ImapIdleDecision,
  type ImapIdleSupport,
  type ImapOpenFailureReason,
} from './imap-open.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Per-operation timeout, and the connect timeout used by the node adapter. */
export const IMAP_DEFAULT_TIMEOUT_MS = 15_000;
/**
 * The most UIDs one `fetchEnvelopes` call will address.
 *
 * A bound on the length of a single `UID FETCH` command line, not a page size:
 * asking for more REFUSES, and never returns a shortened list. Paging is the
 * caller's business, and it has to be visible at the call site — the previous
 * shape hid it in a default argument and lost mail through it.
 */
export const IMAP_MAX_FETCH_UIDS = 500;
const DEFAULT_MAX_BODY_BYTES = 4_096;

function buildXOAuth2Token(username: string, bearerToken: string): string {
  const sasl = `user=${username}\x01auth=${bearerToken}\x01\x01`;
  return Buffer.from(sasl).toString('base64');
}


export class ImapClient {
  private readonly options: ImapClientOptions;
  /** The one session this connection uses, from `open()` until `logout()`. */
  private active: ImapSession | null = null;
  /** True only once EXAMINE has succeeded. Gates every read. */
  private readable = false;
  /** What EXAMINE reported, from `open()` onwards. */
  private status: ImapMailboxStatus | null = null;
  /** Capability atoms the server volunteered or was asked for. */
  private advertised: readonly string[] = [];
  /** True once a `CAPABILITY` command has been issued, answered or not. */
  private probedCapabilities = false;

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
   * Connect, authenticate, and open the mailbox for reading. Must be called
   * before any fetch operation. Uses EXAMINE (read-only) so messages are never
   * marked \Seen.
   *
   * Builds the one session this connection uses. Constructing a session per
   * command — the shape this replaced — reset the read buffer between commands
   * (discarding bytes the server had already sent) and restarted the tag
   * counter, so every command in a connection's life went out as `A0001`.
   *
   * Returns what the connection turned out to be able to do rather than
   * nothing, and fails with a NAMED reason rather than a generic error. The
   * three outcomes it distinguishes — credential refused, mailbox unopenable,
   * socket trouble — are three different problems with three different
   * responses, and only one of them is worth retrying.
   *
   * Nothing can be read until EXAMINE has succeeded: `this.readable` is set
   * only there, and every fetch method checks it. An `open()` that got as far
   * as authentication and no further leaves a client that refuses to read,
   * rather than one that reads from an unopened mailbox.
   */
  async open(): Promise<ImapConnectionReport> {
    if (this.active !== null) {
      throw new Error('The IMAP connection is already open.');
    }
    const session = this.newSession();
    this.active = session;
    rememberConnection(this, session);

    let greeting: string;
    try {
      greeting = await session.readGreeting();
    } catch (err) {
      throw composeOpenFailure({
        refusedReason: 'connection-failed',
        refusedSummary: 'The mail server did not answer.',
        error: err,
        mailbox: this.mailbox,
      });
    }

    let authLines: string[];
    try {
      authLines = await this.authenticate(session);
    } catch (err) {
      throw composeOpenFailure({
        refusedReason: 'authentication-rejected',
        refusedSummary: `The mail server rejected the credentials for ${this.options.username}.`,
        error: err,
        mailbox: this.mailbox,
      });
    }

    let examineLines: string[];
    try {
      examineLines = await session.command(`EXAMINE ${formatMailboxName(this.mailbox)}`);
    } catch (err) {
      throw composeOpenFailure({
        refusedReason: 'mailbox-unavailable',
        refusedSummary:
          `Signed in, but the mailbox '${this.mailbox}' could not be opened for reading.`,
        error: err,
        mailbox: this.mailbox,
      });
    }

    this.status = parseMailboxStatus(examineLines);
    this.advertised = parseCapabilities([greeting, ...authLines, ...examineLines]);
    this.readable = true;
    return {
      advertisedCapabilities: this.advertised,
      idle: idleSupportFrom(this.advertised),
      mailbox: { ...this.status, name: this.mailbox },
      // Plain open() never probes body access — see `probeBodyAccess()` and
      // `ImapBodyProbeVerdict`. This is accurate (no round trip happened),
      // not a placeholder: only the inbound watcher's connection wiring
      // calls the probe and replaces this field with what it found.
      bodyProbe: NOT_PROBED,
    };
  }

  /**
   * Probe whether this connection will actually hand over message content,
   * without assuming it from the fact that EXAMINE succeeded.
   *
   * `CAPABILITY` never says "you may fetch bodies from this mailbox" the way
   * a Gmail OAuth token declares its granted scopes — IMAP has no equivalent
   * declaration, and permission is discoverable only by asking for data. So
   * this asks, once, for the smallest possible slice of the newest message:
   * one byte of `BODY.PEEK[TEXT]`, which never marks the message `\Seen`.
   *
   * **One round trip.** The UID asked for is `UIDNEXT - 1` — the highest UID
   * EXAMINE already told us about — rather than a UID found by a separate
   * `UID SEARCH`, because a second command would make this a two-round-trip
   * probe and the whole point is answering as cheaply as the reactive path
   * answers it anyway, before any expectation could be opened.
   *
   * **Empty mailbox: nothing is asked for.** `EXISTS` at zero, or no
   * `UIDNEXT` to compute a UID from, means there is genuinely nothing to
   * probe — not "assume it works", not "fetch a UID that cannot exist and
   * read the error as a verdict". Returns `{ probed: false }` without
   * touching the wire.
   *
   * **A UID that no longer exists is not a refusal.** If the message named by
   * `UIDNEXT - 1` was expunged after being assigned and before this
   * connection opened, the server answers the FETCH with no message data and
   * no error — RFC 3501 does not treat "no such message" as a refusal. That
   * is read as `{ probed: false }` rather than `ok: true`: no body was
   * actually handed over, so nothing was confirmed, and claiming otherwise
   * would be exactly the empty-looking-success this design refuses
   * everywhere else.
   *
   * Never throws: a refused or failed FETCH is reported as
   * `{ probed: true, ok: false, detail }`, with the raw error text preserved
   * in `detail` so a caller can classify it through the SAME classifier the
   * reactive path uses (`classifyReadFailure` in `inbound/capability.ts`)
   * rather than a second one.
   */
  async probeBodyAccess(): Promise<ImapBodyProbeVerdict> {
    const session = this.requireReadableMailbox();
    const exists = this.status?.exists ?? 0;
    const uidNext = this.status?.uidNext ?? null;
    if (exists <= 0 || uidNext === null || uidNext <= 1) return NOT_PROBED;
    const uid = uidNext - 1;
    let lines: string[];
    try {
      lines = await session.command(`UID FETCH ${uid} (UID BODY.PEEK[TEXT]<0.1>)`);
    } catch (err) {
      return {
        probed: true,
        ok: false,
        detail: err instanceof Error ? err.message : String(err ?? ''),
      };
    }
    return hasFetchResponse(lines) ? { probed: true, ok: true } : NOT_PROBED;
  }

  /**
   * What the server said about the mailbox at EXAMINE time, or null when
   * EXAMINE has not succeeded.
   *
   * `uidValidity` is here because anything that stores a UID between
   * connections has to store the generation it belongs to: when the server
   * reports a different UIDVALIDITY, every UID recorded under the old one
   * names nothing. Read once, at open, rather than asked for again later —
   * a second answer would describe a different moment.
   */
  get mailboxStatus(): ImapMailboxStatus | null {
    return this.status;
  }

  /**
   * The server's capability atoms, asked for if it did not volunteer them.
   *
   * Most servers advertise in the greeting or in the login completion, and
   * those are read at `open()` for free. When a server advertised nothing, a
   * `CAPABILITY` command is issued once — lazily, so ordinary mail operations
   * do not pay a round trip for an answer only a long-lived watcher needs.
   *
   * A server that refuses to answer leaves the set empty. Empty means UNKNOWN
   * and is reported as such rather than as "supports nothing"; the one caller
   * that must decide push-versus-poll on this should poll when it is empty,
   * and know that it is polling because the server would not say.
   */
  async capabilities(): Promise<readonly string[]> {
    if (this.advertised.length > 0 || this.probedCapabilities) return this.advertised;
    const session = this.requireSession();
    this.probedCapabilities = true;
    try {
      this.advertised = parseCapabilities(await session.command('CAPABILITY'));
    } catch {
      // A server that will not answer leaves the set unknown, not false.
    }
    return this.advertised;
  }

  /**
   * Search for unseen messages. Returns UIDs.
   * Pass sinceDate to restrict to messages since a date.
   *
   * `UID SEARCH`, not `SEARCH`: the caller pages a listing and then reads from
   * it, and a sequence number stops naming the same message the moment
   * anything below it is expunged.
   */
  async searchUnseen(sinceDate?: Date): Promise<number[]> {
    const session = this.requireReadableMailbox();
    const criterion = sinceDate
      ? `UNSEEN SINCE ${formatImapDate(sinceDate)}`
      : 'UNSEEN';
    const lines = await session.command(`UID SEARCH ${criterion}`);
    return parseSearchNumbers(lines);
  }

  /**
   * Search every message in the mailbox, not only the unread ones.
   * Returns UIDs, like `searchUnseen`.
   *
   * Exists because a caller that asked for "all mail" must not be quietly
   * served "unread mail": a listing that advertises an unread-only switch has
   * to honour both of its positions.
   */
  async searchAll(sinceDate?: Date): Promise<number[]> {
    const session = this.requireReadableMailbox();
    const criterion = sinceDate ? `SINCE ${formatImapDate(sinceDate)}` : 'ALL';
    const lines = await session.command(`UID SEARCH ${criterion}`);
    return parseSearchNumbers(lines);
  }

  /**
   * Fetch envelope headers for the UIDs given. Uses BODY.PEEK so messages
   * remain unread. Returns one envelope per UID the server answered for, in
   * the order asked.
   *
   * **Every UID asked for is asked for.** This used to take a `limit` that
   * defaulted to 20 and silently kept only the last N, which is a trap rather
   * than a bound: a caller handing it a delta of more than twenty UIDs got
   * twenty back with no error and no signal, and a caller that then advanced a
   * cursor to the highest UID it saw skipped every dropped message
   * permanently. There is no way to use a silently-truncating function
   * correctly without already knowing it truncates. Callers that want a page
   * slice the UID list themselves, where the slice is visible.
   *
   * A hard ceiling remains, because one `UID FETCH` line cannot address an
   * unbounded set — but it REFUSES rather than trims. Over the ceiling is a
   * caller that needs to page, and telling it so is the only answer that
   * cannot lose mail.
   *
   * The `UID` data item is requested explicitly and the returned envelope
   * carries what the server answered. The `* n FETCH` prefix on the response
   * is a SEQUENCE number even under `UID FETCH`, so it is used only to line a
   * response up with its own `UID` and is never reported.
   *
   * A UID the server returned no FETCH response for is omitted: the message
   * was expunged between the search and the fetch, and inventing an envelope
   * for it — or falling back to its sequence number — would hand the caller an
   * identifier that names a different message.
   */
  async fetchEnvelopes(uids: readonly number[]): Promise<ImapEnvelope[]> {
    if (uids.length === 0) return [];
    if (uids.length > IMAP_MAX_FETCH_UIDS) {
      throw new Error(
        `fetchEnvelopes was asked for ${uids.length} UIDs, and at most `
        + `${IMAP_MAX_FETCH_UIDS} can be fetched in one command. Ask for them in `
        + `batches of that size or smaller — this refuses rather than returning `
        + `a subset, because a caller advancing a cursor over a silently `
        + `shortened result skips the messages it never saw.`,
      );
    }
    const session = this.requireReadableMailbox();
    const bounded = uids;
    const set = bounded.join(',');
    const lines = await session.command(
      `UID FETCH ${set} (UID BODY.PEEK[HEADER.FIELDS ` +
      `(FROM SUBJECT DATE MESSAGE-ID TO DELIVERED-TO X-ORIGINAL-TO AUTHENTICATION-RESULTS)])`,
    );
    const headersBySeq = parseFetchHeaders(lines);
    const uidBySeq = parseFetchUids(lines);
    const headersByUid = new Map<number, string>();
    for (const [seq, raw] of Object.entries(headersBySeq)) {
      const uid = uidBySeq[Number(seq)];
      if (uid === undefined) continue;
      headersByUid.set(uid, raw);
    }
    const mailbox = this.mailbox;
    const envelopes: ImapEnvelope[] = [];
    for (const uid of bounded) {
      const raw = headersByUid.get(uid);
      if (raw === undefined) continue;
      const deliveryEvidence = extractDeliveryEvidence(raw);
      envelopes.push({
        uid,
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
   * Fetch a bounded body preview for a single message, by UID.
   * Uses BODY.PEEK[TEXT]<0.N> so the message stays unread.
   *
   * Exactly one message is asked for, so the one FETCH response that comes
   * back is the answer. It is not looked up by number: the `* n FETCH` prefix
   * is a sequence number even under `UID FETCH`, and keying on it would read
   * the preview of whichever message currently sits at position `uid`.
   */
  async fetchBodyPreview(uid: number): Promise<string> {
    const session = this.requireReadableMailbox();
    const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const lines = await session.command(
      `UID FETCH ${uid} BODY.PEEK[TEXT]<0.${maxBytes}>`,
    );
    const [body] = Object.values(parseFetchBody(lines));
    return (body ?? '').slice(0, maxBytes);
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
    const session = this.requireReadableMailbox();

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

    const session = this.requireSession();
    const mailbox = await this.resolveDraftsMailbox(session, input.mailbox);
    const message = buildDraftMessage(input, new Date());
    const lines = await session.commandWithLiteral(
      `APPEND ${formatMailboxName(mailbox)} (\\Draft)`,
      message,
    );
    return { uid: parseAppendUid(lines), mailbox };
  }

  /**
   * Send LOGOUT and destroy the socket.
   *
   * A client that never opened has no session to say LOGOUT on, and callers
   * reach here from their own failure paths — so the socket is closed and the
   * call returns, rather than raising a second failure on top of the first.
   */
  async logout(): Promise<void> {
    const session = this.active;
    this.active = null;
    this.readable = false;
    forgetConnection(this);
    if (session === null) {
      try {
        this.options.socket.destroy();
      } catch {
        // ignore
      }
      return;
    }
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

  /** The open connection's session, or a plain-language refusal. */
  private requireSession(): ImapSession {
    if (this.active === null) throw new Error(NOT_OPEN_MESSAGE);
    return this.active;
  }

  /**
   * The session of a connection whose mailbox is actually open for reading.
   *
   * Authenticated is not readable. A connection that signed in and then failed
   * to EXAMINE refuses every fetch here, by name, instead of putting a FETCH
   * on the wire against whatever the server considers selected.
   */
  private requireReadableMailbox(): ImapSession {
    const session = this.requireSession();
    if (!this.readable) {
      throw new Error(
        `The mailbox '${this.mailbox}' is not open for reading: EXAMINE did not ` +
        `succeed on this connection, so nothing can be fetched from it.`,
      );
    }
    return session;
  }

  private newSession(): ImapSession {
    const maxBodyBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    // Cap literal size at the larger of 1 MB or 4× the configured body preview limit
    const literalCap = Math.max(1_048_576, 4 * maxBodyBytes);
    return new ImapSession(
      this.options.socket,
      this.options.timeoutMs ?? IMAP_DEFAULT_TIMEOUT_MS,
      literalCap,
    );
  }

  /**
   * Sign in, and hand back the response lines.
   *
   * The lines matter: a server that advertises its capabilities in the login
   * completion — `A0001 OK [CAPABILITY ... IDLE ...] Logged in` — has already
   * answered the question a watcher would otherwise ask again.
   */
  private async authenticate(session: ImapSession): Promise<string[]> {
    const { username, password } = this.options;
    if (password.startsWith('Bearer ')) {
      // XOAUTH2 pass-through
      const token = buildXOAuth2Token(username, password.slice(7));
      return session.command(`AUTHENTICATE XOAUTH2 ${token}`);
    }
    // LOGIN — credentials are quoted per RFC 3501 to prevent injection.
    // Credentials are not logged anywhere in this module.
    const quotedUser = imapQuoteCredential(username, 'username');
    const quotedPass = imapQuoteCredential(password, 'password');
    return session.command(`LOGIN ${quotedUser} ${quotedPass}`);
  }
}
