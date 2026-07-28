/**
 * order-correlation.ts — recognising the store's confirmation when it arrives.
 *
 * ══ This CORRELATES. It does not gate ═════════════════════════════════════
 *
 * An earlier design registered an expectation for the confirmation, the way a
 * signup registers one for a verification link. That was the wrong instrument
 * and it is worth saying why, because the two look alike.
 *
 * An expectation exists to AUTHORIZE. A verification link lets an agent do
 * something — click through and complete a signup — so it must have been asked
 * for in advance, correlated to an address minted for that one service, and
 * expired aggressively. `google/verification-expectations.ts` is built entirely
 * around that, and its own header names the excluded cases: a password reset
 * nobody asked for, a security alert, AN INVOICE. An order confirmation is
 * invoice-shaped, it arrives at the owner's real address rather than a minted
 * alias, and nothing is authorized by it. Adding it there would have widened
 * exactly the hole that module keeps small.
 *
 * Telling the owner that a piece of mail arrived requires no authorization at
 * all. The general inbound path already records unexpected mail and reports it.
 * All this module adds is recognition: when mail arrives from a domain we
 * bought something at moments ago, he should read "this is the order you
 * approved" rather than an unrelated receipt he has to place himself.
 *
 * So: no registration, no interception, no expiry, nothing held. A lookup
 * against the purchase records that are being written anyway.
 *
 * ══ Matching is on OUR record, never on the mail's claims ═════════════════
 *
 * The mail proposes a sender domain and an arrival time. Everything else in the
 * match comes from the purchase ledger. A message claiming to be from a
 * merchant we never bought from correlates to nothing, and a message from a
 * merchant we DID buy from still cannot alter what we recorded — it can only be
 * recognised as relating to it.
 *
 * The sender domain is compared as a REGISTRABLE DOMAIN computed by us from the
 * envelope, against the registrable domain we computed from the validated
 * checkout url. Stores routinely send from a different subdomain than they sell
 * from — `order-update.example.com` for a purchase at `www.example.com` — so
 * subdomains of the same registrable domain match, and a different registrable
 * domain does not, however similar it looks.
 */
import { registrableDomain } from '../security/public-suffix.js';
import { sanitizeNoticeField } from '../security/notice-text.js';
import type { PurchaseRecord } from './checkout-flow.js';

/**
 * How long after a purchase a confirmation is still recognisably ITS
 * confirmation.
 *
 * Generous on purpose. Stores are not instant: some send within seconds, some
 * batch overnight, and a warehouse cut-off can put hours between the charge and
 * the mail. Six hours covers the realistic span without being so wide that two
 * separate purchases at the same merchant on the same day become ambiguous —
 * and when they ARE ambiguous this refuses to guess rather than picking one.
 */
export const CONFIRMATION_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface InboundMailFacts {
  /** The envelope sender, as the mail surface parsed it. */
  readonly senderAddress: string;
  readonly receivedAtMs: number;
}

export type CorrelationResult =
  | { readonly kind: 'matched'; readonly record: PurchaseRecord; readonly senderDomain: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly PurchaseRecord[]; readonly senderDomain: string }
  | { readonly kind: 'unrelated'; readonly reason: string };

/** The registrable domain of an email address, or null when it has none. */
export function senderRegistrableDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return registrableDomain(address.slice(at + 1).trim().toLowerCase());
}

/**
 * Find the purchase this mail is about, or say it is about none of them.
 *
 * Returns `ambiguous` rather than choosing when two purchases at the same
 * merchant both fit the window. Naming the wrong order in a message about money
 * is worse than not naming one, and the general inbound path still reports the
 * mail either way.
 */
export function correlatePurchaseMail(
  mail: InboundMailFacts,
  records: readonly PurchaseRecord[],
  windowMs: number = CONFIRMATION_WINDOW_MS,
): CorrelationResult {
  const senderDomain = senderRegistrableDomain(mail.senderAddress);
  if (senderDomain === null) {
    return { kind: 'unrelated', reason: 'The sender address has no registrable domain to compare.' };
  }

  const candidates = records.filter((record) => {
    if (record.merchantDomain !== senderDomain) return false;
    if (record.outcome !== 'purchased') return false;
    const purchasedAtMs = Date.parse(record.atUtc);
    if (Number.isNaN(purchasedAtMs)) return false;
    const age = mail.receivedAtMs - purchasedAtMs;
    // Strictly after the purchase: mail that predates the charge cannot be its
    // confirmation, however close it lands.
    return age >= 0 && age <= windowMs;
  });

  if (candidates.length === 0) {
    return {
      kind: 'unrelated',
      reason: `Nothing was bought at ${senderDomain} recently enough for this to be its confirmation.`,
    };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', candidates, senderDomain };
  }
  const [record] = candidates;
  if (record === undefined) {
    return { kind: 'unrelated', reason: 'The matching purchase disappeared mid-lookup.' };
  }
  return { kind: 'matched', record, senderDomain };
}

/**
 * The three facts worth lifting out of a confirmation, and nothing else.
 *
 * ── Why extraction rather than quoting ────────────────────────────────────
 *
 * The body arrives from outside at the exact moment he is expecting it, which
 * makes it the most attractive thing on this whole path for an attacker to
 * forge. Rendering any span of it into a message he reads on his phone hands
 * whoever wrote it a channel to him.
 *
 * So three narrow patterns run over the text, each yielding a short token, and
 * each token is neutralised before it can be rendered. Nothing else survives.
 * A body this cannot find a pattern in produces nulls, and the report simply
 * carries no order number — which is a strictly better outcome than quoting a
 * line to be helpful.
 *
 * Note what is deliberately NOT extracted: the total. We have our own, computed
 * from integers we parsed, and a total taken from the email would be a number
 * an attacker chose sitting next to the words "charged to your card".
 */
export interface ConfirmationFacts {
  readonly orderNumber: string | null;
  readonly shipDate: string | null;
  readonly trackingReference: string | null;
}

const ORDER_NUMBER = /\b(?:order|order\s*(?:number|no\.?|#)|confirmation\s*(?:number|no\.?|#))\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i;
const SHIP_DATE = /\b(?:ships?|arriving|delivery|estimated\s+delivery|expected)\s*(?:on|by)?\s*[:]?\s*([A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})\b/i;
const TRACKING = /\b(?:tracking|track(?:ing)?\s*(?:number|no\.?|#))\s*[:#]?\s*([A-Z0-9]{8,35})\b/i;

/**
 * Pull the structured facts out of a confirmation body.
 *
 * Takes the raw text and returns only neutralised short tokens. The caller must
 * never pass the body itself onward; there is deliberately no field on the
 * result that could carry it.
 */
export function extractConfirmationFacts(body: string): ConfirmationFacts {
  const capture = (pattern: RegExp, max: number): string | null => {
    const match = pattern.exec(body);
    const value = match?.[1];
    if (value === undefined) return null;
    const clean = sanitizeNoticeField(value, max);
    return clean.length === 0 ? null : clean;
  };
  return {
    orderNumber: capture(ORDER_NUMBER, 40),
    shipDate: capture(SHIP_DATE, 40),
    trackingReference: capture(TRACKING, 60),
  };
}
