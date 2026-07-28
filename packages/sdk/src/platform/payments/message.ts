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
