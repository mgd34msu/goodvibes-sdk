/**
 * Evidence that a message was actually delivered to a particular address.
 *
 * Verification-email correlation keys on "which address did this arrive at".
 * If that value comes from the `To:` header, the whole mechanism is
 * decorative: `To:` is set by the sender, so anyone who guesses an open
 * expectation's address can forge a header, match it, and have the agent
 * follow their link. The correlation must rest on something the sender
 * cannot set.
 *
 * This module makes the unsafe wiring **unrepresentable**. `DeliveredRecipient`
 * carries a private brand, so a plain `string` cannot be passed where one is
 * required, and the only constructors take genuine delivery evidence. There is
 * deliberately no constructor that accepts a `To:`, `Cc:` or `Bcc:` value —
 * not a discouraged one, not a documented-unsafe one. None.
 *
 * A note on IMAP, because it is an easy and expensive mistake: IMAP's
 * `ENVELOPE` structure is parsed out of the message headers (RFC 3501 §7.4.2),
 * so `ENVELOPE`'s recipient fields are exactly as forgeable as the raw headers.
 * IMAP `ENVELOPE` is not delivery evidence and is not accepted here.
 */

/**
 * Brand. Not exported, so no code outside this module can produce a value
 * satisfying `DeliveredRecipient` without going through a constructor below.
 */
declare const DELIVERY_EVIDENCE_BRAND: unique symbol;

/**
 * Where the evidence came from, ordered by how hard it is for a sender to
 * influence.
 *
 * - `alias-mailbox` — the message was fetched from a mailbox or alias minted
 *   for one specific signup. The strongest evidence available: the sender
 *   cannot cause a message to land in a mailbox that exists only for this
 *   expectation. This is the reason per-signup aliasing exists.
 * - `delivered-to-header` / `x-original-to-header` — prepended by the final
 *   delivery agent. Trustworthy only in the top-most position; see
 *   `deliveredRecipientFromDeliveryHeaders`.
 */
export type DeliveryEvidenceSource = 'alias-mailbox' | 'delivered-to-header' | 'x-original-to-header';

/** An address a message was demonstrably delivered to. Sender-controlled values cannot be one. */
export interface DeliveredRecipient {
  readonly address: string;
  readonly source: DeliveryEvidenceSource;
  /** Phantom brand; never present at runtime. */
  readonly [DELIVERY_EVIDENCE_BRAND]: true;
}

/** Lower-case and strip surrounding whitespace and angle brackets. */
export function normalizeDeliveryAddress(value: string): string {
  return value
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .trim()
    .toLowerCase();
}

function brand(address: string, source: DeliveryEvidenceSource): DeliveredRecipient {
  // The brand is a compile-time construct only; the runtime object carries
  // just the two real fields.
  return { address, source } as DeliveredRecipient;
}

/**
 * Strongest evidence: the message was fetched from a mailbox or alias that
 * exists only for one signup.
 *
 * The caller must pass the mailbox it actually issued the fetch against — not
 * a value read out of the message.
 */
export function deliveredRecipientFromAliasMailbox(mailboxAddress: string): DeliveredRecipient | null {
  const address = normalizeDeliveryAddress(mailboxAddress);
  if (address.length === 0 || !address.includes('@')) return null;
  return brand(address, 'alias-mailbox');
}

/**
 * Evidence from delivery headers.
 *
 * `Delivered-To` and `X-Original-To` are prepended by the receiving mail
 * system, so the top-most occurrence is the one *our* delivery agent added.
 * A sender can embed extra `Delivered-To` lines inside the message they
 * submit; those end up **below** the genuine one. So only index 0 is
 * evidence, and everything after it is ignored outright rather than searched
 * for a match — searching the list would hand the attacker back the forgery
 * they were denied.
 *
 * @param orderedValues delivery-header values, top-most first, exactly as they
 *   appeared in the message.
 */
export function deliveredRecipientFromDeliveryHeaders(
  orderedValues: readonly string[],
  source: 'delivered-to-header' | 'x-original-to-header' = 'delivered-to-header',
): DeliveredRecipient | null {
  const topMost = orderedValues[0];
  if (topMost === undefined) return null;
  const address = normalizeDeliveryAddress(topMost);
  if (address.length === 0 || !address.includes('@')) return null;
  return brand(address, source);
}

/**
 * Pick the best available evidence.
 *
 * An alias mailbox always wins over a delivery header, because a header is
 * only as trustworthy as the mail path that wrote it, whereas a per-signup
 * mailbox is a fact about where the message physically landed.
 */
export function bestDeliveryEvidence(
  candidates: readonly (DeliveredRecipient | null)[],
): DeliveredRecipient | null {
  const present = candidates.filter((entry): entry is DeliveredRecipient => entry !== null);
  return (
    present.find((entry) => entry.source === 'alias-mailbox') ??
    present.find((entry) => entry.source === 'delivered-to-header') ??
    present[0] ??
    null
  );
}

/**
 * "This transport has no per-signup mailboxes."
 *
 * Gmail is the shipped case: it files mail under labels, and a plus-addressed
 * alias still lands in the one INBOX, so there is no mailbox whose identity
 * proves which signup a message belongs to. Gmail's evidence is the
 * receiver-written `Delivered-To` header instead. Passing this constant records
 * that the caller considered the mailbox path and has nothing to offer it.
 */
export const NO_ALIAS_MAILBOXES: ReadonlySet<string> = new Set<string>();

/**
 * Build evidence from a fetched message.
 *
 * Takes a structural shape rather than importing the mail client, so the
 * signup layer stays independent of which transport delivered the message —
 * IMAP today, something else later, same rule either way.
 *
 * `aliasMailboxes` is the set of mailboxes that were minted per-signup. A
 * mailbox only counts as evidence if it is one of them: `INBOX` is where
 * everything lands, so treating it as proof of a specific signup would make
 * every message look like it satisfied every expectation.
 *
 * The argument is required rather than defaulted. A default of "no alias
 * mailboxes" silently downgrades a caller that does supply `message.mailbox`
 * but forgets the set — the mailbox evidence is discarded and the call still
 * returns a plausible answer from the headers alone. Forcing every caller to
 * state its answer makes that omission a compile error instead. A transport
 * with no per-signup mailboxes passes `NO_ALIAS_MAILBOXES`, which reads as the
 * deliberate statement it is.
 */
export function deliveryEvidenceFromMessage(
  message: {
    readonly mailbox?: string | undefined;
    readonly deliveredTo?: readonly string[] | undefined;
  },
  aliasMailboxes: ReadonlySet<string>,
): DeliveredRecipient | null {
  const mailbox = message.mailbox === undefined ? '' : normalizeDeliveryAddress(message.mailbox);
  const mailboxEvidence =
    mailbox.length > 0 && aliasMailboxes.has(mailbox)
      ? deliveredRecipientFromAliasMailbox(mailbox)
      : null;

  return bestDeliveryEvidence([
    mailboxEvidence,
    deliveredRecipientFromDeliveryHeaders(message.deliveredTo ?? []),
  ]);
}

/** Plain-language description for logs and refusal messages. Safe to display. */
export function describeDeliveryEvidence(evidence: DeliveredRecipient | null): string {
  if (evidence === null) {
    return 'no delivery evidence (the message carries nothing that proves which address it arrived at)';
  }
  if (evidence.source === 'alias-mailbox') {
    return `delivered into the mailbox "${evidence.address}", which exists only for this signup`;
  }
  const header = evidence.source === 'delivered-to-header' ? 'Delivered-To' : 'X-Original-To';
  return `delivered to "${evidence.address}" according to the top-most ${header} header added by the receiving mail server`;
}
