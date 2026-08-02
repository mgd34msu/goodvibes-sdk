/**
 * money-value.ts — the codec for config keys that hold an amount of money.
 *
 * ── What a money setting is now ───────────────────────────────────────────
 *
 * An amount setting holds the number the owner would say out loud. He writes
 * `100` and the file reads `100`. He writes `19.99` and the file reads `19.99`.
 * There is no second representation to keep straight, no suffix on the key
 * telling him which one he is in, and nothing here rewrites what he typed into
 * a "canonical" form — a whole number stays whole, and a decimal keeps exactly
 * the decimal he entered.
 *
 * These keys used to be named for, and stored in, the currency's smallest
 * division, so `100` in the file meant one dollar and buying something for a
 * hundred dollars meant typing `10000`. Every entry point was one absent zero
 * away from a hundredfold error in a spending limit, in the direction that
 * spends more. The name is gone, the smallest-division storage is gone, and the
 * migration in ./migrations.ts carries existing values across.
 *
 * ── What this module is responsible for ───────────────────────────────────
 *
 * Reading what a person typed and either producing the number they meant or
 * refusing with an example. It is deliberately currency-NEUTRAL: it knows
 * nothing about dollars, does not consult `payments.currency`, and never names
 * a unit in an error. Whatever `payments.currency` is set to, an amount is an
 * amount of it.
 *
 * Exact arithmetic on these amounts is the payments layer's job (it multiplies
 * up to whole units of the currency's smallest division and does integer math
 * from there). That is an implementation detail of the arithmetic and never
 * reaches a message, a key name, or a settings screen.
 */

/**
 * The largest amount any of these settings accepts.
 *
 * A ceiling on the ceiling: it is what stops a slipped keystroke turning a
 * budget into a number that could buy a car, while sitting far above any
 * amount a real limit would name.
 */
export const MAX_MONEY_AMOUNT = 1_000_000;

/** The most decimal places an amount may carry. */
const MAX_DECIMAL_PLACES = 2;

/**
 * The example every refusal shows.
 *
 * Two forms, both ordinary: a round number and one with a decimal. It says what
 * to type instead of explaining a units system, because the units system is
 * exactly what this change removed.
 */
const AMOUNT_EXAMPLE = 'a plain number like 100 or 19.99';

/** The hint the config schema attaches to every amount setting. */
export const MONEY_VALIDATION_HINT = `${AMOUNT_EXAMPLE}, no greater than ${MAX_MONEY_AMOUNT}`;

/** A leading currency symbol, tolerated on input and dropped. */
const LEADING_CURRENCY_SYMBOL = /^\p{Sc}\s*/u;

/** Digits, optionally grouped in threes, with at most two decimal places. */
const GROUPED_AMOUNT = /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/;
const PLAIN_AMOUNT = /^\d+(?:\.\d{1,2})?$/;

export type MoneyParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: string };

/** True when `value` is a number an amount setting may hold. */
export function isValidMoneyAmount(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < 0 || value > MAX_MONEY_AMOUNT) return false;
  return decimalPlaces(value) <= MAX_DECIMAL_PLACES;
}

/**
 * Read an amount as a person may have written it.
 *
 * Accepts a number (`100`, `19.99`) or the text of one, with a leading currency
 * symbol and thousands grouping tolerated and removed (`$100`, `1,250.50`).
 * Refuses anything else — text that is not a number, more decimal places than
 * an amount can carry, a negative, or a figure past {@link MAX_MONEY_AMOUNT} —
 * and the refusal names an example rather than a units rule.
 *
 * The returned number is the one that was typed. Nothing is rounded, padded, or
 * re-formatted on the way through.
 */
export function parseMoneyAmount(raw: unknown): MoneyParseResult {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return refuse(raw);
    if (raw < 0) return refuse(raw);
    if (decimalPlaces(raw) > MAX_DECIMAL_PLACES) return refuse(raw);
    if (raw > MAX_MONEY_AMOUNT) return refuse(raw);
    return { ok: true, value: raw };
  }

  if (typeof raw !== 'string') return refuse(raw);

  const cleaned = raw.trim().replace(LEADING_CURRENCY_SYMBOL, '').trim();
  if (cleaned.length === 0) return refuse(raw);

  const digits = GROUPED_AMOUNT.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned;
  if (!PLAIN_AMOUNT.test(digits)) return refuse(raw);

  const value = Number(digits);
  if (!Number.isFinite(value) || value > MAX_MONEY_AMOUNT) return refuse(raw);
  return { ok: true, value };
}

/**
 * Coerce a value on its way into an amount setting, or throw the refusal text.
 *
 * Used by the config set path so `$100`, `100` and `19.99` all reach the same
 * stored number, and anything that is not a number is refused before it can be
 * written.
 */
export function coerceMoneyAmount(key: string, raw: unknown): number {
  const parsed = parseMoneyAmount(raw);
  if (parsed.ok) return parsed.value;
  throw new Error(`Invalid value for ${key}: ${describe(raw)} — enter ${MONEY_VALIDATION_HINT}.`);
}

/**
 * `unit` + `validate` + `validationHint` for an amount setting in the config
 * schema.
 *
 * The `unit: 'money'` mark is the part consumers key off. Anything that needs
 * to know "is this key an amount of money" asks the schema for that mark — not
 * the shape of the key's name, which is how the previous naming scheme reached
 * into every surface that touched one of these keys.
 */
export function moneyAmount(): { unit: 'money'; validate: (value: unknown) => boolean; validationHint: string } {
  return {
    unit: 'money',
    validate: (value: unknown): boolean => isValidMoneyAmount(value),
    validationHint: MONEY_VALIDATION_HINT,
  };
}

function refuse(raw: unknown): MoneyParseResult {
  return { ok: false, reason: `${describe(raw)} is not ${AMOUNT_EXAMPLE}` };
}

function describe(raw: unknown): string {
  if (typeof raw === 'string') return `"${raw}"`;
  return String(raw);
}

/** How many digits sit after the decimal point, for a finite number. */
function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  // `toFixed` past the precision a double carries would invent digits, so the
  // string form of the number itself is the honest source.
  const text = String(value);
  const dot = text.indexOf('.');
  if (dot === -1) return text.includes('e') || text.includes('E') ? MAX_DECIMAL_PLACES + 1 : 0;
  return text.length - dot - 1;
}
