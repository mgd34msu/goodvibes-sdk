/**
 * money-parsing.ts, turning what a checkout page SAYS into an integer we own.
 *
 * Every amount on a checkout page is a string chosen by whoever runs that page.
 * It reaches us as text and it must never leave this module as text: the rule
 * for the whole capability is that our own code parses merchant strings into
 * integer minor units, and every number the owner is later shown is re-rendered
 * from those integers by `formatMinorUnits`. A merchant's own "$1,234.56" never
 * passes through to a notice, a decision, or a ledger row.
 *
 * ── Refusing beats guessing ───────────────────────────────────────────────
 *
 * `parseMinorUnits` returns null for anything it cannot read one way. That is
 * the entire safety property here, and it is why the grammar below is a short
 * list of exact shapes rather than a lenient scrubber:
 *
 *   - A scrubber that strips every non-digit turns "1.234,56" into 123456 and
 *     "1,234.56" into 123456 as well. Those are the same number by luck, and
 *     "1.234" versus "1,234" is where the luck runs out, a factor of a
 *     thousand, silently, on the number a budget is checked against.
 *   - A parser that falls back to `Number(...)` accepts "1e6", "0x10",
 *     "Infinity" and " 12 " and produces a value for each. A page that wants to
 *     be charged more than the budget allows would only have to find whichever
 *     of those the budget check rounds in its favour.
 *
 * So: three unambiguous shapes, anything else is a refusal, and a refusal stops
 * the purchase rather than defaulting to zero. A zero default is worse than a
 * crash, because a tax line that fails to parse as 0 makes an over-budget order
 * look affordable.
 *
 * ── Ambiguity is decided by the grammar, not by locale guessing ──────────
 *
 * A thousands group is always exactly three digits, and a fractional part is
 * never more than the currency's exponent. Those two facts separate every real
 * case without knowing the page's locale:
 *
 *   "1,234"    → 3 digits after the separator, too many to be a 2-exponent
 *                fraction, so it is a thousands group: 1234 major units.
 *   "1.234"    → same reasoning with the separators swapped: 1234 major units.
 *   "1,23"     → 2 digits, too few to be a thousands group: 1.23.
 *   "1,23,456" → matches nothing. Refused rather than salvaged.
 */
import type { CurrencyCode, MinorUnits } from './types.js';

/** Currencies whose minor unit is a thousandth rather than a hundredth. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
/** Currencies with no minor unit at all. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'XPF']);

/**
 * How many minor units make one major unit, as a power of ten.
 *
 * Exported because the extractor, the parser and the renderer must agree; a
 * second copy of this table is a bug waiting for the first three-decimal
 * currency to arrive.
 */
export function minorUnitExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * The largest amount that may come off a page, in minor units.
 *
 * A hard ceiling well inside `Number.MAX_SAFE_INTEGER`, so arithmetic on parsed
 * amounts stays exact no matter what a page claims. A page asking for more than
 * this is refused at parse time rather than reaching a budget comparison that
 * would have handled it correctly anyway, the budget is the second line, and a
 * value that cannot be added without losing precision should never reach it.
 */
export const MAX_PARSEABLE_MINOR_UNITS = 1_000_000_000_000;

/** Characters a page may put around a number that carry no numeric meaning. */
const CURRENCY_ORNAMENT = /[\p{Sc}\s   ]/gu;

/**
 * Read one amount off a page, or refuse.
 *
 * Returns null, never a fallback, when the text is empty, holds no number,
 * holds more than one number, is negative, uses a separator layout that could
 * mean two different values, or exceeds the parse ceiling.
 *
 * A leading minus is refused rather than negated: a negative line item on a
 * checkout is a discount or a credit, and treating one as a normal amount that
 * happens to reduce the total is how a page talks a budget check into passing.
 * Discounts reach us as a lower item price, which is the only form we act on.
 */
export function parseMinorUnits(raw: string, currency: CurrencyCode | string): MinorUnits | null {
  if (typeof raw !== 'string') return null;
  const exponent = minorUnitExponent(currency);

  // Strip currency symbols, the ISO code itself, and every flavour of space.
  // Nothing here removes a digit or a separator, so the grammar below still
  // sees the full layout the page chose.
  let text = raw.replace(CURRENCY_ORNAMENT, '');
  text = text.replace(new RegExp(currency, 'gi'), '');
  text = text.trim();
  if (text.length === 0) return null;

  // A negative amount, however it is spelled, is not something we act on.
  if (/^[-−(]/.test(text) || text.endsWith(')') || text.includes('-')) return null;

  // Exactly one numeric run. Two numbers in one string means the selector
  // picked up a range, a strikethrough price beside a sale price, or a whole
  // summary block, none of which we may choose between.
  const runs = text.match(/\d[\d.,]*/g);
  if (runs === null || runs.length !== 1) return null;
  const [number] = runs;
  if (number === undefined) return null;

  // Anything outside the number must be ornamental. A letter left over means
  // the string said something we did not understand ("12.00/mo", "from 12.00").
  const remainder = text.replace(number, '');
  if (/[\p{L}\p{N}]/u.test(remainder)) return null;

  const fraction = exponent === 0 ? '' : `{1,${String(exponent)}}`;

  // Shape 1: comma thousands, dot fraction.  1,234.56
  const usStyle = new RegExp(`^\\d{1,3}(?:,\\d{3})+(?:\\.\\d${fraction})?$`);
  // Shape 2: dot thousands, comma fraction.  1.234,56
  const euStyle = new RegExp(`^\\d{1,3}(?:\\.\\d{3})+(?:,\\d${fraction})?$`);
  // Shape 3: no thousands separator at all.  1234.56  or  1234,56  or  1234
  const plain = exponent === 0
    ? /^\d+$/
    : new RegExp(`^\\d+(?:[.,]\\d${fraction})?$`);

  let majorText: string;
  let minorText: string;

  if (usStyle.test(number)) {
    const dot = number.indexOf('.');
    majorText = (dot === -1 ? number : number.slice(0, dot)).replace(/,/g, '');
    minorText = dot === -1 ? '' : number.slice(dot + 1);
  } else if (euStyle.test(number)) {
    const comma = number.indexOf(',');
    majorText = (comma === -1 ? number : number.slice(0, comma)).replace(/\./g, '');
    minorText = comma === -1 ? '' : number.slice(comma + 1);
  } else if (plain.test(number)) {
    const separator = number.search(/[.,]/);
    majorText = separator === -1 ? number : number.slice(0, separator);
    minorText = separator === -1 ? '' : number.slice(separator + 1);
  } else {
    return null;
  }

  if (!/^\d+$/.test(majorText)) return null;
  if (minorText !== '' && !/^\d+$/.test(minorText)) return null;
  if (minorText.length > exponent) return null;

  const major = Number(majorText);
  if (!Number.isSafeInteger(major)) return null;
  const minor = minorText === '' ? 0 : Number(minorText.padEnd(exponent, '0'));
  if (!Number.isSafeInteger(minor)) return null;

  const total = major * 10 ** exponent + minor;
  if (!Number.isSafeInteger(total)) return null;
  if (total > MAX_PARSEABLE_MINOR_UNITS) return null;
  return total;
}

/**
 * Read a whole-number quantity off a page, or refuse.
 *
 * Separate from `parseMinorUnits` because a quantity has no currency and no
 * fraction, and reusing the money parser for it would accept "2.00" as two,
 * which is probably right and is exactly the kind of probably we do not want
 * deciding how many of something to buy.
 */
export function parseQuantity(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 ? value : null;
}
