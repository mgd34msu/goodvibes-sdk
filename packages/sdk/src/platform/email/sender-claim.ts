/**
 * The sender-claim port: how the mail service asks a product to describe a
 * `From:` header, without owning the description itself.
 *
 * ── Why this is a port and not an implementation ──────────────────────────
 *
 * Turning a `From:` header plus a routing verdict into a sentence a human
 * reads is a TRUST-BOUNDARY concern, and each surface owns its own boundary
 * module. The SDK deliberately does not ship a second copy of that logic —
 * a duplicate would drift, and two answers to "who is this claiming to be"
 * is exactly one answer too many. What the SDK owns is the plumbing: read the
 * top-most `Authentication-Results` (see `platform/google/sender-authentication`),
 * hand the resulting checks to the product's describer, and carry whatever it
 * returns onto the message summary unchanged.
 *
 * ── The one thing this file does pin ──────────────────────────────────────
 *
 * `commandAuthority` is typed as the literal `'none'` and as nothing else.
 * That is not decoration. A wider union would let a caller write
 * `if (claim.commandAuthority === 'command')` and get a branch that compiles
 * into a path a sender could reach. Sender identity confers no authority in
 * this system, and the type says so rather than a comment asking nicely. Any
 * describer a product supplies has to satisfy that literal to be accepted here.
 */

import type { SenderAuthenticationChecks } from '../google/sender-authentication.js';

/**
 * How much the displayed sender line should be trusted BY A HUMAN READING
 * IT. Display only. No branch anywhere may turn one of these into an
 * authority decision.
 */
export type EmailSenderConfidence =
  | 'unverified'
  | 'partially-verified'
  | 'protocol-verified'
  | 'failed-verification';

/**
 * A `From:` header described as a claim.
 *
 * The contract a product's boundary module must satisfy to be usable as an
 * `EmailSenderClaimDescriber`. Products keep their own richer type; this is
 * the subset the mail service reads and republishes.
 */
export interface EmailSenderClaim {
  /** The address as written in the header — a claim, not a fact. */
  readonly claimedAddress: string;
  /** The display name as written in the header — also a claim. */
  readonly claimedDisplayName: string;
  /** Human-readable line that says out loud that this is a claim. */
  readonly display: string;
  /** Display confidence only. Never an input to any permission check. */
  readonly displayedConfidence: EmailSenderConfidence;
  /**
   * Always the literal 'none'. See the module header for why this is typed as
   * a literal rather than as a wider union.
   */
  readonly commandAuthority: 'none';
}

/**
 * Describe a `From:` header for display, in wording that keeps it a claim.
 *
 * @param fromHeader the header value verbatim, exactly as the sender wrote it.
 * @param checks the receiving server's DKIM/SPF/DMARC verdict, read from the
 *   TOP-MOST `Authentication-Results` header and nowhere else. Absent when the
 *   receiving server stamped nothing, which must surface as "we could not
 *   tell" rather than as "it passed".
 */
export type EmailSenderClaimDescriber = (
  fromHeader: string,
  checks?: SenderAuthenticationChecks,
) => EmailSenderClaim;
