/**
 * checkout-extraction.ts — the boundary between what a page says and what we
 * are willing to act on.
 *
 * ══ Everything on the left of this module is attacker-chosen ══════════════
 *
 * A checkout page's line labels, quantities, prices, tax line, fee names,
 * delivery labels and grand total are all strings written by whoever runs that
 * site. That is true of a hostile merchant and it is equally true of an honest
 * merchant whose page was tampered with, so there is no merchant for whom this
 * module is unnecessary.
 *
 * Two rules, applied here so no caller has to remember them:
 *
 *  1. **Every amount becomes an integer we parsed, or the purchase stops.**
 *     `parseMinorUnits` refuses anything ambiguous and this module turns a
 *     refusal into a failed extraction rather than a zero. Nothing downstream
 *     ever sees the merchant's own numeral — `decidePurchase` gets integers,
 *     `message.ts` re-renders from integers, and the ledger stores integers.
 *
 *  2. **Every string that survives is neutralised before it can be rendered.**
 *     Labels are kept, because the cart check compares them and the audit record
 *     needs them, and each one goes through `sanitizeNoticeField` on the way in.
 *     A label is data to compare, never text to display raw.
 *
 * ══ The total is checked, not trusted ═════════════════════════════════════
 *
 * The page's own grand total is read and then used only to CONTRADICT us. Our
 * total is the sum of the parts we parsed; if the page's stated total disagrees,
 * the extraction fails. It is not corrected toward the page, because a page that
 * can move the total can move it past the budget, and it is not silently
 * ignored, because a disagreement means one of the two readings is wrong and we
 * do not know which.
 *
 * The tolerance is exactly zero. Rounding differences are not a real phenomenon
 * here: both numbers are integers in the same currency's minor units, and a
 * merchant whose lines do not add up to their own total is a merchant we should
 * stop at rather than reconcile with.
 */
import { sanitizeNoticeField } from '../security/notice-text.js';
import { parseMinorUnits, parseQuantity } from './money-parsing.js';
import { parseCurrencyCode } from './types.js';
import type { CartLine } from './cart.js';
import type { CurrencyCode, MinorUnits, ShippingOption } from './types.js';

/**
 * What a merchant adapter read off the page, before any of it is believed.
 *
 * Every field is a raw string, deliberately. An adapter that returned numbers
 * would be doing the parsing, which would put a copy of the parse rules in every
 * adapter and make each new merchant a new chance to get them wrong.
 */
export interface RawCheckoutReading {
  readonly lines: readonly {
    readonly label: string;
    readonly quantity: string;
    readonly unitPrice: string;
  }[];
  readonly tax: string | null;
  readonly fees: readonly { readonly label: string; readonly amount: string }[];
  readonly shippingOptions: readonly { readonly label: string; readonly cost: string }[];
  /** The page's own stated grand total. Used to contradict us, never to inform us. */
  readonly statedTotal: string | null;
  /** ISO-4217 as the page presented it, when it presented one at all. */
  readonly currency: string | null;
  /**
   * The order summary as text, for `detectRecurringCharge`.
   *
   * The one place raw page text is read to look for a reason to STOP. Untrusted
   * content may always talk us out of an action; what it may never do is talk us
   * into one.
   */
  readonly orderSummaryText: string;
}

/** The same checkout, in integers this code produced. */
export interface ExtractedCheckout {
  readonly currency: CurrencyCode;
  readonly lines: readonly CartLine[];
  readonly itemMinorUnits: MinorUnits;
  readonly taxMinorUnits: MinorUnits;
  readonly feesMinorUnits: MinorUnits;
  readonly feeLabels: readonly string[];
  readonly shippingOptions: readonly ShippingOption[];
  /** Item + tax + fees. Delivery is added once a tier is chosen. */
  readonly subtotalMinorUnits: MinorUnits;
  readonly orderSummaryText: string;
}

export type ExtractionResult =
  | { readonly ok: true; readonly checkout: ExtractedCheckout }
  | { readonly ok: false; readonly reason: string; readonly field: string };

function fail(field: string, reason: string): ExtractionResult {
  return { ok: false, field, reason };
}

/**
 * Turn a reading into integers, or refuse and say which field defeated it.
 *
 * `fallbackCurrency` is the budget's currency, used only when the page states
 * none. It is not used to override a currency the page DID state: a page priced
 * in one currency and a budget in another is a mismatch `decidePurchase` refuses
 * on, and quietly relabelling the page's number with our currency code is how
 * that refusal would be bypassed.
 */
export function extractCheckout(
  raw: RawCheckoutReading,
  fallbackCurrency: CurrencyCode,
): ExtractionResult {
  const currency = raw.currency === null || raw.currency.trim().length === 0
    ? fallbackCurrency
    : parseCurrencyCode(raw.currency);
  if (currency === null) {
    return fail('currency', 'Refused: the checkout states a currency I cannot read as an ISO-4217 code.');
  }

  if (raw.lines.length === 0) {
    return fail('lines', 'Refused: I could not read a single line item off this checkout.');
  }

  const lines: CartLine[] = [];
  let itemMinorUnits = 0;
  for (const [index, line] of raw.lines.entries()) {
    const quantity = parseQuantity(line.quantity);
    if (quantity === null) {
      return fail(
        `lines[${String(index)}].quantity`,
        'Refused: a line on this checkout has a quantity I cannot read as a whole number.',
      );
    }
    const unit = parseMinorUnits(line.unitPrice, currency);
    if (unit === null) {
      return fail(
        `lines[${String(index)}].unitPrice`,
        'Refused: a line on this checkout has a price I cannot read as an exact amount. '
        + 'I do not guess at prices.',
      );
    }
    const label = sanitizeNoticeField(line.label, 120);
    if (label.length === 0) {
      return fail(`lines[${String(index)}].label`, 'Refused: a line on this checkout has no readable name.');
    }
    lines.push({ label, quantity, unitMinorUnits: unit });
    itemMinorUnits += unit * quantity;
    if (!Number.isSafeInteger(itemMinorUnits)) {
      return fail('lines', 'Refused: the line items on this checkout add up to an implausible amount.');
    }
  }

  let taxMinorUnits = 0;
  if (raw.tax !== null && raw.tax.trim().length > 0) {
    const tax = parseMinorUnits(raw.tax, currency);
    if (tax === null) {
      return fail('tax', 'Refused: I cannot read the tax line on this checkout as an exact amount.');
    }
    taxMinorUnits = tax;
  }

  let feesMinorUnits = 0;
  const feeLabels: string[] = [];
  for (const [index, fee] of raw.fees.entries()) {
    const amount = parseMinorUnits(fee.amount, currency);
    if (amount === null) {
      return fail(`fees[${String(index)}]`, 'Refused: I cannot read a fee line on this checkout as an exact amount.');
    }
    feesMinorUnits += amount;
    feeLabels.push(sanitizeNoticeField(fee.label, 60));
  }

  const shippingOptions: ShippingOption[] = [];
  for (const [index, option] of raw.shippingOptions.entries()) {
    const cost = parseMinorUnits(option.cost, currency);
    if (cost === null) {
      return fail(
        `shippingOptions[${String(index)}]`,
        'Refused: I cannot read a delivery option\'s price on this checkout as an exact amount.',
      );
    }
    // The label is retained for the audit record only. `shipping.ts` ranks by
    // cost and never reads the words, because merchants describe delivery in
    // incomparable ways and a rule written against those words breaks on the
    // next merchant.
    shippingOptions.push({ rawLabel: sanitizeNoticeField(option.label, 60), costMinorUnits: cost });
  }
  if (shippingOptions.length === 0) {
    return fail(
      'shippingOptions',
      'Refused: this checkout offers no delivery option I can read, so I cannot work out what the '
      + 'unavoidable charges would be.',
    );
  }

  const subtotalMinorUnits = itemMinorUnits + taxMinorUnits + feesMinorUnits;

  // The stated total is checked against ours only when the page states one AND
  // the comparison is meaningful — which it is only for a single delivery
  // option, because with several we cannot know which one the page's total
  // assumed. With several, the ladder picks one and the flow re-verifies the
  // total on the page after the choice is applied.
  if (raw.statedTotal !== null && raw.statedTotal.trim().length > 0 && shippingOptions.length === 1) {
    const stated = parseMinorUnits(raw.statedTotal, currency);
    if (stated === null) {
      return fail('statedTotal', 'Refused: I cannot read this checkout\'s stated total as an exact amount.');
    }
    const only = shippingOptions[0];
    if (only === undefined) return fail('shippingOptions', 'Refused: the delivery option vanished mid-read.');
    const ours = subtotalMinorUnits + only.costMinorUnits;
    if (stated !== ours) {
      return fail(
        'statedTotal',
        'Refused: this checkout\'s own total does not equal its line items plus tax, fees and '
        + 'delivery. One of the two readings is wrong and I cannot tell which, so nothing is bought.',
      );
    }
  }

  return {
    ok: true,
    checkout: {
      currency,
      lines,
      itemMinorUnits,
      taxMinorUnits,
      feesMinorUnits,
      feeLabels,
      shippingOptions,
      subtotalMinorUnits,
      // Kept raw: `detectRecurringCharge` matches patterns against it and the
      // matched fragments are sanitised there, at the point they become a
      // message. Sanitising here would rewrite the text the detector reads.
      orderSummaryText: raw.orderSummaryText,
    },
  };
}
