/**
 * card-redaction.ts, closing the hole that `payments.checkout.fillCard` opens.
 *
 * ══ The design this belongs to ════════════════════════════════════════════
 *
 * The daemon holds the card; the model orchestrates the purchase. `fillCard`
 * keeps both halves true by having the DAEMON read the stored material and type
 * it into an open page, returning nothing but success or failure. The model
 * never receives the number and never passes it anywhere.
 *
 * That holds right up until the model takes a snapshot of the page it just had
 * the daemon fill. `browser-snapshot.ts` reports every form control's `value`,
 * `extract` reads values, html and attributes on request, `readText` returns
 * the page's rendered words, and a screenshot is a picture of a filled form.
 * Every one of those is a read path back to the number, and the containment
 * would be theatre without them closed. This module is what closes them.
 *
 * ══ Two independent layers, because either alone has a gap ════════════════
 *
 * **Structural.** A control the page itself declares to be a card field,
 * `autocomplete="cc-number"`, `cc-csc`, a name of `cardNumber`, and the rest of
 * the list below, never has its value reported, whether or not anything has
 * been filled and whether or not this process is the one that filled it. This
 * needs no wiring, survives an engine constructed without a redactor, and
 * covers the ordinary case completely.
 *
 * Its gap: a hostile page can name its card input `q` and its search box
 * `cc-number`, and the classification is then worthless.
 *
 * **Value-based.** While material is live on a page, the exact strings that were
 * typed are known, and any page-derived text leaving the engine has them
 * removed, from a value, a name, an attribute, body text, an error message,
 * anywhere. This catches the page that echoes the number into a heading, copies
 * it into a data attribute, or renames its fields to defeat the classifier.
 *
 * Its gap: it only works when a redactor is installed. So the fill refuses to
 * run at all against a browser engine that has none, see
 * `assertRedactionInstalled` in fill-card.ts. The leak cannot happen because
 * the fill cannot happen.
 *
 * ══ Matching is on digits, not on the string ══════════════════════════════
 *
 * A page is free to reformat what was typed. A field with an input mask takes a
 * bare run of digits and reads back the same digits in groups of four separated
 * by spaces; a page script can just as easily join them with dashes, or split
 * them across elements it later concatenates. An exact string search misses all of those while reporting
 * that it found nothing, which is the worst possible answer.
 *
 * So a digit run in the text, digits with spaces or dashes between them, is
 * normalised to digits alone before it is compared. The comparison is
 * containment rather than equality, because a page that renders
 * `Card <digits> on file` puts the number inside a longer run.
 *
 * ══ What this deliberately does NOT do ════════════════════════════════════
 *
 * It does not redact `last4`. Four digits is what the owner is shown in every
 * notice and every ledger row by design, and a redactor that removed them would
 * either blank half the audit trail or, worse, teach a reader that seeing
 * digits means the redaction failed.
 *
 * It does not attempt to redact a screenshot. A PNG of a filled form cannot be
 * string-searched, and painting boxes over the fields we know about leaves the
 * fields a hostile page invented. Screenshots of a page holding live material
 * are refused instead; see `BrowserEngine.screenshot`.
 */

/** What replaces a card value wherever one is found. */
export const REDACTED_MARKER = '[redacted card material]';

// The classification of "is this a payment field" lives in security/ because
// the browser's snapshot needs it whether or not payments are configured, and
// the two must never disagree about what was protected.
export { isCardFieldDescriptor } from '../security/card-fields.js';
export type { FormControlDescriptor } from '../security/card-fields.js';

/**
 * A single piece of card material to keep out of page-derived text.
 *
 * `kind` exists for the failure message. When a fill fails, the owner is told
 * WHICH field failed, and that name comes from here rather than from anything
 * derived from the value.
 */
export type CardFieldKind = 'number' | 'cvv' | 'expiry' | 'cardholder';

/**
 * The lowest number of characters a secret must have before it is worth
 * matching on.
 *
 * A two-digit expiry month is `07`, and redacting every `07` on a checkout page
 * would blank prices, quantities and order numbers while proving nothing. Short
 * components are protected by the structural layer (an `autocomplete="cc-exp"`
 * field never reports a value) and by not being secret in any useful sense on
 * their own. The number, the CVV, and a full expiry string are what this
 * matches.
 */
const MIN_MATCHABLE_LENGTH = 3;

interface LiveSecret {
  readonly kind: CardFieldKind;
  readonly literal: string;
  /** Digits only, when the value is digit-shaped. Empty when it is not. */
  readonly digits: string;
}

/**
 * The separator characters a page's input mask might place between digit
 * groups: the plain hyphen and every Unicode dash in the same block (en
 * dash, em dash, minus sign and the rest), the underscore, and the dot used
 * by masks like `4539.5787.6362.1486`. Whitespace is handled by `\s` plus a
 * literal non-breaking space, which together cover the regular space, the
 * tab, the newline and every Unicode space separator a mask is likely to
 * use.
 *
 * Deliberately not "any non-digit character": a mask that inserts a letter
 * or a currency symbol between digit groups is not a spelling of the number
 * we typed, and treating it as one would start bridging unrelated digits
 * across a page for no reason.
 */
const MASK_SEPARATOR = String.raw`[\s\xa0.\-\u2010-\u2015\u2212_]`;

/**
 * Normalise a run of digits that a page may have spaced, dashed (plain or
 * Unicode), dotted, or underscored apart.
 *
 * Only separators that appear INSIDE a number are removed. Removing every
 * non-digit from the whole text would join unrelated numbers across a page,
 * a price and an order id becoming one long run that then matches a card by
 * coincidence, which produces redaction where there is nothing to redact and
 * hides the page from the model for no reason. Restricting the separator set
 * to what an input mask plausibly inserts (`MASK_SEPARATOR`) keeps that
 * property while catching every reformatting an ordinary checkout mask
 * actually uses, not only the handful this module happened to test first.
 */
function digitRuns(text: string): { readonly run: string; readonly digits: string }[] {
  const runs: { run: string; digits: string }[] = [];
  const pattern = new RegExp(`\\d(?:${MASK_SEPARATOR}*\\d)*`, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    const run = match[0];
    runs.push({ run, digits: run.replace(/[^\d]/g, '') });
    match = pattern.exec(text);
  }
  return runs;
}

/**
 * The live card material for one browser page, and the redaction it enforces.
 *
 * Held per page rather than per session because a checkout runs on one page
 * while the model may legitimately be reading another tab, and blanking that
 * other tab would be redaction the owner cannot explain.
 *
 * The values live in this process's memory for as long as they are on the page
 * in front of them, which is exactly as long as the browser itself holds them.
 * `disarm` is called when the form is submitted, when the purchase is abandoned,
 * and when the page or session closes.
 */
export class CardMaterialRedactor {
  private readonly live = new Map<string, LiveSecret[]>();

  private static key(sessionId: string, pageId: string): string {
    return `${sessionId}:${pageId}`;
  }

  /**
   * Register material as live on a page.
   *
   * Called BEFORE the typing starts, never after. A fill that throws halfway
   * has still put characters in the field, and material registered only on
   * success would be material that leaks precisely when something went wrong.
   */
  arm(sessionId: string, pageId: string, secrets: readonly { kind: CardFieldKind; value: string }[]): void {
    const key = CardMaterialRedactor.key(sessionId, pageId);
    const existing = this.live.get(key) ?? [];
    for (const secret of secrets) {
      const literal = secret.value.trim();
      if (literal.length < MIN_MATCHABLE_LENGTH) continue;
      existing.push({
        kind: secret.kind,
        literal,
        digits: new RegExp(`^(?:\\d|${MASK_SEPARATOR})+$`).test(literal) ? literal.replace(/[^\d]/g, '') : '',
      });
    }
    // Longest first, so a full number is removed before a substring of it is.
    existing.sort((left, right) => right.literal.length - left.literal.length);
    this.live.set(key, existing);
  }

  /** Forget a page's material: submitted, abandoned, or the page closed. */
  disarm(sessionId: string, pageId: string): void {
    this.live.delete(CardMaterialRedactor.key(sessionId, pageId));
  }

  /** Forget every page in a session. Called when a session ends. */
  disarmSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of [...this.live.keys()]) {
      if (key.startsWith(prefix)) this.live.delete(key);
    }
  }

  /** Whether this page is currently holding material that has not been cleared. */
  hasLiveMaterial(sessionId: string, pageId: string): boolean {
    const secrets = this.live.get(CardMaterialRedactor.key(sessionId, pageId));
    return secrets !== undefined && secrets.length > 0;
  }

  /**
   * Remove every live secret from page-derived text.
   *
   * Applied to anything crossing out of the browser engine: element values and
   * names, extracted html and attributes, body text, and the content handed to
   * the untrusted-content ledger. Cheap to call on text with nothing in it,
   * when a page holds no material this returns the input unchanged.
   */
  redact(sessionId: string, pageId: string, text: string): string {
    const secrets = this.live.get(CardMaterialRedactor.key(sessionId, pageId));
    if (secrets === undefined || secrets.length === 0) return text;
    return redactWithSecrets(text, secrets);
  }

  /**
   * Whether any live secret appears in this text.
   *
   * For assertions and for the engine's own checks. Deliberately not used to
   * decide whether to redact, `redact` is unconditional, because a check
   * followed by an action is one refactor away from the check being dropped.
   */
  containsLiveMaterial(sessionId: string, pageId: string, text: string): boolean {
    const secrets = this.live.get(CardMaterialRedactor.key(sessionId, pageId));
    if (secrets === undefined || secrets.length === 0) return false;
    return redactWithSecrets(text, secrets) !== text;
  }
}

function redactWithSecrets(text: string, secrets: readonly LiveSecret[]): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let output = text;

  // Literal spellings first, the cheapest and most common case.
  for (const secret of secrets) {
    if (secret.literal.length === 0) continue;
    output = output.split(secret.literal).join(REDACTED_MARKER);
  }

  // Then the reformatted spellings: any digit run whose digits contain a
  // secret's digits is replaced whole. Replacing the run rather than the
  // matched digits inside it avoids leaving `4242 [redacted] 4242` behind,
  // which would disclose the shape and part of the value.
  const digitSecrets = secrets.filter((secret) => secret.digits.length >= MIN_MATCHABLE_LENGTH);
  if (digitSecrets.length === 0) return output;

  for (const { run, digits } of digitRuns(output)) {
    if (run.length === 0) continue;
    if (!digitSecrets.some((secret) => digits.includes(secret.digits))) continue;
    output = output.split(run).join(REDACTED_MARKER);
  }
  return output;
}
