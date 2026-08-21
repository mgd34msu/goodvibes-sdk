/**
 * The shapes an IMAP read hands back, and the options a client is built with.
 *
 * Split out of `imap-client.ts` to keep that file under the repository's
 * per-file line cap. These are declarations only: the rules they encode, that
 * `uid` is a UID and never a sequence number, that `unverifiedToHeaderClaim`
 * is display-only, that an attachment is described and never downloaded, are
 * enforced by the client and documented on the fields here, where a caller
 * reading the type sees them.
 */

import type { Socket } from 'node:net';
import type { DeliveryEvidence } from './imap-headers.js';

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
   * Empty when the delivery agent stamped nothing we can trust, callers must
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
   * Written by the receiving mail server, so, like the delivery headers,
   * only the top-most is beyond the sender's reach. Feeds DISPLAY confidence
   * on the sender line and nothing else; no permission anywhere reads it.
   */
  readonly authenticationResults: readonly string[];
}

/**
 * A FETCH response the server sent and this client could not read.
 *
 * Never carries message content, a reason and, where they were legible, the
 * identifiers the response named.
 */
export interface ImapFetchProblem {
  /** The response's sequence number, or null when even that was unreadable. */
  readonly seq: number | null;
  /** The UID the response named, when it named one legibly. */
  readonly uid: number | null;
  /** Plain language, safe to log and safe to show an owner. */
  readonly detail: string;
}

/**
 * The whole answer to one envelope fetch: what was read, and what was not.
 *
 * `unreadable` being non-empty is a load-bearing fact and not a diagnostic
 * nicety. While it is non-empty, a UID missing from `envelopes` is NOT evidence
 * that the message is gone, one of the responses we could not read may have
 * been that message's. A caller advancing a cursor has to treat the whole batch
 * as unresolved and ask again, because the alternative is stepping over mail
 * that is still in the mailbox and never looking at it again.
 */
export interface ImapEnvelopeBatch {
  readonly envelopes: readonly ImapEnvelope[];
  readonly unreadable: readonly ImapFetchProblem[];
}

export interface ImapMessage extends ImapEnvelope {
  readonly bodyPreview: string;
}

/**
 * One whole message: everything an envelope carries, plus its readable text.
 *
 * Extends `ImapEnvelope` rather than restating it so the provenance rules that
 * govern a listing govern a full read identically, the mailbox it came from,
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
  /** What is attached, described. Never the attached bytes, see `fetchMessage`. */
  readonly attachments: readonly ImapAttachmentInfo[];
}

/**
 * The whole answer to "read UID n": what came back, or why nothing did.
 *
 * Three outcomes, because there are three things that can happen and the old
 * `ImapMessageDetail | null` could say only two. `null` meant "the UID is not
 * in the mailbox", a perfectly ordinary answer, the message was deleted, and
 * a server that ANSWERED for the UID in terms this client could not read
 * arrived as the same `null` and was reported to the caller as "it is no
 * longer there". That is a false statement about the owner's mailbox: the
 * message is sitting in it.
 *
 * `gone` is the message being absent. `unreadable` is the client being unable
 * to read what the server sent, and it carries the responses that could not be
 * read so the answer is diagnosable rather than merely negative. The same
 * distinction `ImapEnvelopeBatch` draws for a batch fetch, drawn for a single
 * one.
 */
export type ImapMessageRead =
  | { readonly outcome: 'read'; readonly detail: ImapMessageDetail }
  | { readonly outcome: 'gone' }
  | { readonly outcome: 'unreadable'; readonly problems: readonly ImapFetchProblem[] };

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
  /**
   * Treat an empty body for a message the server SAID has content in it as a
   * capability failure rather than as an empty message. Default: false.
   *
   * Off by default because `fetchMessage` currently leaves a section it could
   * not read empty and returns the rest, and a mail reader that starts
   * throwing where it used to show headers is a behaviour change its callers
   * did not ask for. On for the inbound watcher's connections, where an empty
   * body is not a cosmetic gap: a verification link that reads as blank is
   * indistinguishable from mail that never came, which is the exact failure
   * the inbound design exists to eliminate.
   */
  readonly enforceBodyReadable?: boolean;
}

