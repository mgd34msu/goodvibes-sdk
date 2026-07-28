/**
 * message.ts — what the approval and veto prompts say, and why no page can
 * influence a single character of it.
 *
 * The attack this exists to stop: if merchant page text can reach the message,
 * whoever controls that page writes what the owner reads on his phone.
 * "Approve $12 for coffee?" attached to a $1,200 order is a complete compromise
 * of the human check, and it looks perfectly normal.
 *
 * So the message is rendered from a CLOSED STRUCT OF TYPED SCALARS, and there is
 * no field in it that can carry free text from a page:
 *
 *   merchantDomain  registrableDomain() of the VALIDATED url — computed by us,
 *                   never the page's own claimed name
 *   item            OwnerSuppliedText — a branded type only constructible from
 *                   an owner-direct turn, so assigning page text is a compile
 *                   error. (And if the item only exists on the page, the taint
 *                   gate already refused the purchase.)
 *   amounts         integer minor units, re-rendered by OUR formatter. A page
 *                   string never passes through. A value that will not parse to
 *                   a plain non-negative integer refuses rather than rendering.
 *   currency        validated ISO-4217
 *
 * The pools are shown next to the total on purpose: an inflated number is much
 * easier to catch beside the budget it is about to eat than on its own.
 */
import { isPlainHostname, sanitizeNoticeField, sanitizeOwnerNoticeField } from '../security/notice-text.js';
import type { PoolSnapshot } from './budget.js';
import type {
  CurrencyCode,
  MinorUnits,
  OwnerSuppliedText,
  ShippingStepDown,
  ShippingTier,
} from './types.js';

/**
 * The merchant identity the owner is shown.
 *
 * It is the registrable domain computed by `registrableDomain()` from the
 * VALIDATED checkout url — never the page's own claimed name, because a page can
 * call itself anything. A computed hostname always passes `isPlainHostname`; if
 * one ever does not, the identity did not come from where the caller believed,
 * and the honest response is a placeholder rather than rendering it.
 */
function renderMerchant(domain: string): string {
  return isPlainHostname(domain) ? domain : '(merchant identity unavailable)';
}

/**
 * The item line.
 *
 * `OwnerSuppliedText` is only constructible from an owner-direct turn, so this
 * should already be his words rather than a product title off a page. It is
 * still neutralised: the branded type is a compile-time guarantee, and a
 * compile-time guarantee does not survive a call site that threads provenance
 * wrongly. Underscore is kept for legibility since it cannot build a link.
 */
function renderItem(item: OwnerSuppliedText): string {
  return sanitizeOwnerNoticeField(item, 100);
}

export interface PurchaseFacts {
  readonly merchantDomain: string;
  readonly item: OwnerSuppliedText;
  readonly itemMinorUnits: MinorUnits;
  readonly taxMinorUnits: MinorUnits;
  readonly feesMinorUnits: MinorUnits;
  readonly shippingMinorUnits: MinorUnits;
  readonly totalMinorUnits: MinorUnits;
  readonly currency: CurrencyCode;
  readonly cardLast4: string;
  readonly shippingTier: ShippingTier;
  readonly stepDown: ShippingStepDown | null;
  readonly poolsAfter: PoolSnapshot;
  /**
   * Where it is going, rendered from the STORED address.
   *
   * A correct total to the wrong address is still a wrong order, and the veto
   * notice is the last point at which he can catch it. Null only when the
   * checkout asked for no address at all.
   */
  readonly destination?: string | null | undefined;
}

/** Minor units per major unit. Three-decimal currencies are handled explicitly. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'XPF']);

function exponentFor(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * Render money from integer minor units.
 *
 * Throws on a non-integer or negative input rather than rendering something
 * plausible. A total that did not parse cleanly is not a display problem, it is
 * a reason to refuse, and the caller must not be able to paper over it by
 * getting a "0.00" back.
 */
export function formatMinorUnits(amount: MinorUnits, currency: CurrencyCode): string {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`Refusing to render a non-integer or negative amount: ${String(amount)}`);
  }
  const exponent = exponentFor(currency);
  if (exponent === 0) return `${currency} ${amount.toLocaleString('en-US')}`;
  const divisor = 10 ** exponent;
  const major = Math.floor(amount / divisor);
  const minor = String(amount % divisor).padStart(exponent, '0');
  return `${currency} ${major.toLocaleString('en-US')}.${minor}`;
}

/**
 * The approval prompt — ABOVE budget, silence DENIES.
 *
 * States the silence rule in the message. He should never have to remember which
 * kind of window he is looking at, and the two say opposite things.
 */
export function renderApprovalMessage(facts: PurchaseFacts, expiresInMinutes: number): string {
  const lines = [
    `Approval needed — this is over your daily item budget.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    `  Card ending ${facts.cardLast4}`,
    `  Daily item budget left: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`,
    ``,
    `Reply "approve" to buy it or "deny" to drop it.`,
    `If I hear nothing in ${expiresInMinutes} minutes I will NOT buy it.`,
  ];
  return lines.join('\n');
}

/**
 * The veto prompt — WITHIN budget, silence PROCEEDS.
 *
 * Also states its silence rule, and states it as the opposite of the approval's,
 * because the whole design rests on him knowing which one he is holding.
 */
export function renderVetoMessage(facts: PurchaseFacts, expiresInMinutes: number): string {
  const lines = [
    `About to buy this — it is within your budget.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    `  Card ending ${facts.cardLast4}`,
    `  Daily item budget left after this: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`,
    ``,
    `Reply "stop" to cancel, or "go" to buy it now.`,
    `If I hear nothing in ${expiresInMinutes} minutes I WILL buy it.`,
  ];
  return lines.join('\n');
}

function amountLines(facts: PurchaseFacts): string[] {
  const lines = [
    `  Item:     ${formatMinorUnits(facts.itemMinorUnits, facts.currency)}`,
    `  Tax:      ${formatMinorUnits(facts.taxMinorUnits, facts.currency)}`,
  ];
  if (facts.feesMinorUnits > 0) {
    lines.push(`  Fees:     ${formatMinorUnits(facts.feesMinorUnits, facts.currency)}`);
  }
  lines.push(
    `  Shipping: ${formatMinorUnits(facts.shippingMinorUnits, facts.currency)} `
    + `(${sanitizeNoticeField(facts.shippingTier, 20)})`,
  );
  if (facts.stepDown !== null) {
    // Surfaced rather than buried: a step-down needs no approval because it is
    // within budget, but he must not learn about it from a late package.
    lines.push(
      `            stepped down from ${facts.stepDown.from} to fit the overage budget, `
      + `saving ${formatMinorUnits(facts.stepDown.savedMinorUnits, facts.currency)}`,
    );
  }
  lines.push(`  TOTAL:    ${formatMinorUnits(facts.totalMinorUnits, facts.currency)}`);
  if (facts.destination !== undefined && facts.destination !== null) {
    lines.push(``, `  Ships to: ${facts.destination}`);
  }
  return lines;
}

/**
 * The report after an objection.
 *
 * One word cancels, and then he is told what was stopped and the state it was
 * left in — never a silent abandonment that leaves him wondering whether a cart
 * is sitting somewhere half-driven.
 */
export function renderCancellationReport(facts: PurchaseFacts): string {
  return [
    `Stopped. Nothing was charged.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    `  would have been ${formatMinorUnits(facts.totalMinorUnits, facts.currency)}`,
    ``,
    `The checkout was abandoned and the budget I was holding is back.`,
  ].join('\n');
}

/**
 * The ONE purchase notice, and the only send site.
 *
 * The owner collapsed "show it to him" and "alert him if it is not a major
 * retailer" into a single step — "2 and 3 are basically the same step". So there
 * is one message, sent once, when the item is chosen and the final total is
 * known, before payment. The retailer only changes what SILENCE means.
 *
 * Both branches carry identical content: what was found, the validated
 * registrable domain, the item, and the total re-rendered from our own parsed
 * integers. Never merchant text.
 *
 * This exists so the selection is a branch at one call site rather than an
 * invitation to add a third message type. `renderApprovalMessage` and
 * `renderVetoMessage` stay separate because their SILENCE RULES are opposite and
 * must never be unified — see
 * docs/decisions/2026-07-27-payment-windows-are-deliberately-opposite.md — but
 * callers should reach for this, not for either of them directly.
 */
export function renderPurchaseNotice(input: {
  readonly facts: PurchaseFacts;
  readonly mode: 'approval' | 'veto';
  readonly expiresInMinutes: number;
  /**
   * Why this merchant qualified, or why it did not — from `classifyMerchant`.
   *
   * Always rendered when present, because the verdict alone is not useful to
   * him. "Etsy, buyer protection applies" is something he can weigh at a
   * glance; "on your approved list" sends him off to go check a list. On the
   * other side it reads as a checkpoint — not on the list, so I am asking —
   * and never implies anything is wrong with the seller.
   *
   * Sanitised like every other merchant-adjacent string, and prefixed by us so
   * the framing cannot be supplied by anything a page controls.
   */
  readonly merchantReason?: string | undefined;
}): string {
  const body = input.mode === 'approval'
    ? renderApprovalMessage(input.facts, input.expiresInMinutes)
    : renderVetoMessage(input.facts, input.expiresInMinutes);
  if (input.merchantReason === undefined || input.merchantReason.trim().length === 0) return body;
  const label = input.mode === 'veto' ? 'Why I can go ahead' : 'Why I am asking';
  return `${body}\n\n  ${label}: ${sanitizeNoticeField(input.merchantReason, 240)}`;
}

/**
 * The report after the charge goes through.
 *
 * ══ Why this is not email-driven ══════════════════════════════════════════
 *
 * The daemon knows it charged the card. It does not need a store to tell it,
 * and it must not wait for one: a confirmation can take minutes or hours, some
 * stores send nothing at all, and mail can be broken independently of payments.
 * A report that depended on any of that would leave him with a veto notice, ten
 * minutes of silence, a charge, and then nothing.
 *
 * So this fires at the moment the submit is confirmed, from facts this process
 * already holds, and every number in it is re-rendered from our own integers.
 *
 * The shipping tier is reported as the one ACTUALLY used, with the step-down
 * spelled out when there was one. He approved a purchase; a delivery option was
 * then chosen inside the budget he set, and he should not learn which from the
 * parcel arriving later than he expected.
 */
export function renderPurchaseReport(input: {
  readonly facts: PurchaseFacts;
  /** The merchant's own order reference, when the page showed one. */
  readonly merchantOrderId: string | null;
}): string {
  const { facts } = input;
  const lines = [
    `Bought it.`,
    ``,
    `  ${renderItem(facts.item)}`,
    `  from ${renderMerchant(facts.merchantDomain)}`,
    ``,
    ...amountLines(facts),
    ``,
    `  Paid with the card ending ${sanitizeNoticeField(facts.cardLast4, 8)}`,
  ];
  if (input.merchantOrderId !== null && input.merchantOrderId.trim().length > 0) {
    // The merchant chose this string, so it is neutralised like any other
    // field that came off their page.
    lines.push(`  Their order number: ${sanitizeNoticeField(input.merchantOrderId, 40)}`);
  }
  lines.push(`  Daily item budget left: ${formatMinorUnits(facts.poolsAfter.item.remaining, facts.currency)}`);
  return lines.join('\n');
}

/**
 * The follow-up once the store's own confirmation turns up.
 *
 * ══ The body is never in here ═════════════════════════════════════════════
 *
 * A confirmation email arrives from outside, at the exact moment he is
 * expecting one, which makes it the single most attractive thing for an
 * attacker to forge. Its body is not rendered, not quoted, and not summarised.
 * What reaches him is a small set of STRUCTURED fields — an order number, a
 * ship date, a tracking reference — each neutralised, plus our own record of
 * what was bought, which the email cannot influence at all.
 *
 * The email also carries no authority. It cannot confirm that a purchase
 * happened; our ledger already knows that. All it can do is add a reference
 * number to a message he was going to get anyway.
 */
export function renderConfirmationReport(input: {
  readonly facts: PurchaseFacts;
  readonly confirmation: {
    readonly orderNumber: string | null;
    readonly shipDate: string | null;
    readonly trackingReference: string | null;
  };
  /** The registrable domain the mail actually came from, computed by us. */
  readonly senderDomain: string;
}): string {
  const lines = [
    `${renderMerchant(input.senderDomain)} confirmed the order.`,
    ``,
    `  ${renderItem(input.facts.item)}`,
    `  ${formatMinorUnits(input.facts.totalMinorUnits, input.facts.currency)} charged to the card ending `
      + `${sanitizeNoticeField(input.facts.cardLast4, 8)}`,
  ];
  const { orderNumber, shipDate, trackingReference } = input.confirmation;
  if (orderNumber !== null) lines.push(`  Order number: ${sanitizeNoticeField(orderNumber, 40)}`);
  if (shipDate !== null) lines.push(`  Ships: ${sanitizeNoticeField(shipDate, 40)}`);
  if (trackingReference !== null) lines.push(`  Tracking: ${sanitizeNoticeField(trackingReference, 60)}`);
  lines.push(``, `This is the order you approved. The amount above is the one I calculated, not the one the email states.`);
  return lines.join('\n');
}
