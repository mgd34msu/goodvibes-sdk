/**
 * checkout-reading-input.ts — accepting a checkout reading from the model.
 *
 * ══ Why the model reads the page ══════════════════════════════════════════
 *
 * Browser control is general. The model reads a page, decides, clicks and
 * types; a checkout is the same primitive as a signup form. A table of
 * per-merchant selectors would be scaffolding that thinks for the model, and it
 * is brittle in the way that matters most — merchants rewrite their markup
 * constantly, so a selector table is a permanent maintenance tax that buys
 * nothing the model cannot already do.
 *
 * So the model reports what it read as STRUCTURED VALUES — per-line label,
 * quantity and unit price, the tax line, each fee, each delivery option, the
 * currency — and the daemon does everything the model cannot be trusted to do
 * with them.
 *
 * ══ What "cannot be trusted" means here, precisely ════════════════════════
 *
 * Not that the model is adversarial. That the numbers came off a page, and a
 * page is written by whoever runs it. By the time a value reaches this module
 * it has been through a process that read attacker-chosen text, so it carries
 * that text's authority — which is none.
 *
 * The split that follows from it:
 *
 *   THE MODEL         finds the values on the page and reports them.
 *   THE DAEMON        parses them to integers with its own parser, checks the
 *                     cart against what the owner asked for, looks for a
 *                     recurring charge, applies the budget, renders the owner's
 *                     message from its own integers, runs the window, fills the
 *                     card and records the purchase.
 *
 * Every number the owner reads is one the daemon computed. A string the model
 * reported never reaches his phone, and a number it reported never reaches a
 * budget comparison without being re-parsed here first.
 *
 * ══ Why these numbers are not taint-checked ═══════════════════════════════
 *
 * Deliberately, and taint-gate.ts already documents the reasoning: the price,
 * tax, fees and delivery costs are READ FROM THE MERCHANT by definition, so
 * taint-checking them would refuse every purchase, and a check that is
 * permanently tripped gets removed.
 *
 * Their defence is the BUDGET. A page that inflates a price hits the daily item
 * budget or the per-purchase ceiling and needs an approval, and that approval
 * shows our own re-rendered number beside the budget it would consume.
 *
 * What IS taint-checked stays taint-checked: the merchant, the checkout url,
 * the item and any stated limit come from the owner or the purchase is refused.
 * He names what he wants and where from; the page only gets to say what it
 * costs, and only within a limit he set.
 */
import type { RawCheckoutReading } from './checkout-extraction.js';

/** Bounds on a reading, so a malformed or hostile report cannot exhaust memory. */
const MAX_LINES = 50;
const MAX_FEES = 20;
const MAX_SHIPPING_OPTIONS = 20;
const MAX_FIELD_LENGTH = 400;
const MAX_SUMMARY_LENGTH = 40_000;

export type ReadingInputResult =
  | { readonly ok: true; readonly reading: RawCheckoutReading }
  | { readonly ok: false; readonly reason: string; readonly field: string };

function reject(field: string, reason: string): ReadingInputResult {
  return { ok: false, field, reason };
}

/**
 * A string field from an untyped payload.
 *
 * Length-capped rather than truncated-and-accepted: a 10,000-character "price"
 * is not a price that needs shortening, it is a payload, and accepting a prefix
 * of it would mean parsing whatever the first 400 characters happened to be.
 */
function readString(value: unknown, max = MAX_FIELD_LENGTH): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > max) return null;
  return value;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Validate a checkout reading supplied over the control plane.
 *
 * Shape and bounds only — this does not interpret a single value. Meaning is
 * `extractCheckout`'s job, and keeping the two apart is what lets the parser be
 * strict without this layer having to guess what a caller meant.
 */
export function readCheckoutReadingInput(params: Record<string, unknown>): ReadingInputResult {
  const rawLines = params['lines'];
  if (!Array.isArray(rawLines)) {
    return reject('lines', 'lines must be an array of the checkout\'s line items.');
  }
  if (rawLines.length === 0) {
    return reject('lines', 'Refused: a checkout with no line items is not something I can buy.');
  }
  if (rawLines.length > MAX_LINES) {
    return reject('lines', `Refused: this checkout reports more than ${String(MAX_LINES)} line items.`);
  }

  const lines: { label: string; quantity: string; unitPrice: string }[] = [];
  for (const [index, entry] of rawLines.entries()) {
    const record = readRecord(entry);
    if (record === null) return reject(`lines[${String(index)}]`, 'Each line must be an object.');
    const label = readString(record['label']);
    const quantity = readString(record['quantity']);
    const unitPrice = readString(record['unitPrice']);
    if (label === null) return reject(`lines[${String(index)}].label`, 'Each line needs a label string.');
    if (quantity === null) return reject(`lines[${String(index)}].quantity`, 'Each line needs a quantity string.');
    if (unitPrice === null) return reject(`lines[${String(index)}].unitPrice`, 'Each line needs a unitPrice string.');
    lines.push({ label, quantity, unitPrice });
  }

  const rawFees = params['fees'] ?? [];
  if (!Array.isArray(rawFees)) return reject('fees', 'fees must be an array.');
  if (rawFees.length > MAX_FEES) {
    return reject('fees', `Refused: this checkout reports more than ${String(MAX_FEES)} fee lines.`);
  }
  const fees: { label: string; amount: string }[] = [];
  for (const [index, entry] of rawFees.entries()) {
    const record = readRecord(entry);
    if (record === null) return reject(`fees[${String(index)}]`, 'Each fee must be an object.');
    const label = readString(record['label']);
    const amount = readString(record['amount']);
    if (label === null) return reject(`fees[${String(index)}].label`, 'Each fee needs a label string.');
    if (amount === null) return reject(`fees[${String(index)}].amount`, 'Each fee needs an amount string.');
    fees.push({ label, amount });
  }

  const rawShipping = params['shippingOptions'];
  if (!Array.isArray(rawShipping)) {
    return reject('shippingOptions', 'shippingOptions must be an array of the delivery choices offered.');
  }
  if (rawShipping.length === 0) {
    return reject(
      'shippingOptions',
      'Refused: no delivery option was reported, so I cannot work out what the unavoidable charges would be.',
    );
  }
  if (rawShipping.length > MAX_SHIPPING_OPTIONS) {
    return reject('shippingOptions', `Refused: more than ${String(MAX_SHIPPING_OPTIONS)} delivery options were reported.`);
  }
  const shippingOptions: { label: string; cost: string }[] = [];
  for (const [index, entry] of rawShipping.entries()) {
    const record = readRecord(entry);
    if (record === null) return reject(`shippingOptions[${String(index)}]`, 'Each delivery option must be an object.');
    const label = readString(record['label']);
    const cost = readString(record['cost']);
    if (label === null) return reject(`shippingOptions[${String(index)}].label`, 'Each delivery option needs a label.');
    if (cost === null) return reject(`shippingOptions[${String(index)}].cost`, 'Each delivery option needs a cost.');
    shippingOptions.push({ label, cost });
  }

  const tax = params['tax'] === undefined || params['tax'] === null ? null : readString(params['tax']);
  if (params['tax'] !== undefined && params['tax'] !== null && tax === null) {
    return reject('tax', 'tax must be the tax amount as it appears on the checkout.');
  }

  const statedTotal = params['statedTotal'] === undefined || params['statedTotal'] === null
    ? null
    : readString(params['statedTotal']);
  if (params['statedTotal'] !== undefined && params['statedTotal'] !== null && statedTotal === null) {
    return reject('statedTotal', 'statedTotal must be the grand total as it appears on the checkout.');
  }

  const currency = params['currency'] === undefined || params['currency'] === null
    ? null
    : readString(params['currency'], 16);
  if (params['currency'] !== undefined && params['currency'] !== null && currency === null) {
    return reject('currency', 'currency must be a short ISO-4217 code such as USD.');
  }

  const orderSummaryText = readString(params['orderSummaryText'] ?? '', MAX_SUMMARY_LENGTH);
  if (orderSummaryText === null) {
    return reject(
      'orderSummaryText',
      `orderSummaryText must be the order summary as text, under ${String(MAX_SUMMARY_LENGTH)} characters.`,
    );
  }

  return {
    ok: true,
    reading: { lines, tax, fees, shippingOptions, statedTotal, currency, orderSummaryText },
  };
}
