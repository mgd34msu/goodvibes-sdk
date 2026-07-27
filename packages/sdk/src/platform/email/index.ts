/**
 * @pellux/goodvibes-sdk/platform/email
 *
 * IMAP and SMTP as platform capability: reading a mailbox and sending a plain
 * text message over the protocols themselves, with no provider API in between.
 *
 * This lives in the SDK rather than in any one product because every surface is
 * equally entitled to it — and because the daemon is one of those surfaces.
 * While this code sat inside a single product, the daemon had no implementation
 * to call: scheduled work, triggers and channel replies could not send mail at
 * all, because the only IMAP and SMTP clients in the platform were in a binary
 * the daemon does not run. Hoisting it is the fix for that, not a tidy-up.
 *
 * The sibling `platform/google` connector covers Gmail specifically, including
 * the app-password path that produces the credential this module then uses.
 * This module is the protocol layer under it and works against any host.
 *
 * ── Everything is injected ────────────────────────────────────────────────
 *
 * Not a single line here opens a socket, reads a file, reads config or reaches
 * for a global. The transports arrive as `EmailTransportPort`, config as a
 * getter, secrets as a `get`, the sender-claim wording as
 * `EmailSenderClaimDescriber`, the untrusted-ingest ledger as a recorder
 * callback, and the credential-shaped-text check as a `SecretLikeTextPredicate`
 * — so the entire service, including a full IMAP conversation, runs against an
 * in-process fake server with no TLS and no real host. The concrete bun/node
 * transports live in the sibling `email/node` entry and are deliberately NOT
 * re-exported from here.
 *
 * ── Security properties this module is responsible for ────────────────────
 *
 * These are structural, not advisory, and each is load-bearing:
 *
 *  - **Top-most only.** Both `Delivered-To`/`X-Original-To` and
 *    `Authentication-Results` are read from index 0 and nowhere else. A sender
 *    can embed their own copies in the message they submit; those land BELOW
 *    the receiver's, and searching the list would hand the forgery back the
 *    moment a real check said `fail`. Header parsing also stops at the first
 *    blank line, so a `Delivered-To:` pasted into a message BODY is body text.
 *  - **The `To:` header is never evidence.** It is carried as
 *    `unverifiedToHeaderClaim` and named so that correlating on it reads as
 *    obviously wrong. The mailbox that was EXAMINEd is the primary anchor.
 *  - **Sender authentication informs display, never authority.** DKIM/SPF/DMARC
 *    raise what a human reads. `EmailSenderClaim.commandAuthority` is typed as
 *    the literal `'none'`, so no branch anywhere can turn one into a permission.
 *  - **Mail content is untrusted at the boundary.** Reading a mailbox records an
 *    untrusted ingest for every message, before anything can be sent, and the
 *    recorded origin is the CLAIMED sender domain labelled as claimed.
 *  - **No credential reaches a message.** Passwords arrive from a secret
 *    reference, are held only for the length of one connection, and appear in no
 *    `error`, `detail` or status string. `getStatus()` redacts the reference
 *    itself. Nothing in this module logs.
 *  - **Nothing goes on the wire unquoted.** IMAP credentials are RFC 3501
 *    quoted-strings with CR/LF and non-ASCII rejected outright; SMTP addresses
 *    and subjects are rejected for control characters, angle brackets and
 *    comma-lists — at the service boundary as well as in the client, so
 *    injection is blocked regardless of which client a caller reaches for.
 *  - **STARTTLS is not negotiated blind.** The upgrade aborts if the server
 *    sends any byte after its `220` before TLS begins.
 *  - **Sending is never implicit.** `EmailService.sendMail` throws without
 *    `confirm: true`, and the style-reply composer has no send path at all.
 */

// ---------------------------------------------------------------------------
// Contracts and ports
// ---------------------------------------------------------------------------

export type {
  EmailSenderConfidence,
  EmailSenderClaim,
  EmailSenderClaimDescriber,
} from './sender-claim.js';

export type {
  EmailConfig,
  EmailConnectionTestResult,
  EmailServiceDeps,
  EmailSocketFactory,
  EmailSummary,
  EmailTransportPort,
  SendMailOptions,
  SmtpSecurityMode,
} from './email-service.js';

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

export {
  ImapClient,
  imapQuoteCredential,
  IMAP_DEFAULT_TIMEOUT_MS,
} from './imap-client.js';

export type {
  ImapClientOptions,
  ImapEnvelope,
  ImapMessage,
} from './imap-client.js';

export {
  extractAuthenticationResults,
  extractDeliveryEvidence,
  extractHeader,
  formatImapDate,
} from './imap-headers.js';

export type {
  DeliveryEvidence,
  DeliveryEvidenceSource,
} from './imap-headers.js';

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------

export {
  SmtpClient,
  validateSmtpAddress,
  validateSmtpSubject,
  SMTP_DEFAULT_TIMEOUT_MS,
} from './smtp-client.js';

export type {
  SmtpClientOptions,
  SmtpSendOptions,
} from './smtp-client.js';

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export {
  EmailService,
  ensureEmailConfigDefaults,
  readEmailConfig,
  resolveEmailPassword,
  validateEmailConfig,
} from './email-service.js';

// ---------------------------------------------------------------------------
// Writing-style-matched draft replies (composer + lane descriptors)
// ---------------------------------------------------------------------------

export {
  classifyTone,
  composeDraftReply,
  countSentences,
  extractSenderName,
  extractStyleProfile,
  median,
  mostFrequent,
  replySubject,
} from './style-reply.js';

export type {
  DraftReplyResult,
  StyleProfile,
} from './style-reply.js';

export {
  buildStyleReplyLaneAdditions,
  styleReplyLiveRecord,
  styleReplyWorkflow,
  styleReplyWorkflowStatus,
} from './style-reply-lane.js';

export type { StyleReplyLaneAdditions } from './style-reply-lane.js';
