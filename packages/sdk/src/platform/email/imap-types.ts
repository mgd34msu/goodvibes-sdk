/**
 * The shapes an IMAP read hands back, and the options a client is built with.
 *
 * Split out of `imap-client.ts` to keep that file under the repository's
 * per-file line cap. These are declarations only: the rules they encode — that
 * `uid` is a UID and never a sequence number, that `unverifiedToHeaderClaim`
 * is display-only, that an attachment is described and never downloaded — are
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

