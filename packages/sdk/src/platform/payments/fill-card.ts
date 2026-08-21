/**
 * fill-card.ts, the daemon does the typing.
 *
 * ══ The correction this module IS ═════════════════════════════════════════
 *
 * Card material was specified as write-only: it went in through
 * `payments.cards.create` and nothing returned it. That containment was aimed
 * at the right target and overshot. The thing that must never happen is the
 * MODEL holding the number. The thing that must happen, or the capability is
 * decorative, is the DAEMON putting the number into a checkout field.
 *
 * A card that can never reach a checkout field cannot buy anything, and a
 * capability whose entire purpose is buying things is not served by a
 * containment that forbids its one action.
 *
 * So the property is restated where it is true, and it is a narrow change:
 *
 *   BEFORE   nothing may read card material.
 *   AFTER    nothing OUTSIDE THIS PROCESS may read card material, and the only
 *            thing inside it that reads any is this module, which types it into
 *            a page and returns a boolean.
 *
 * `payments.checkout.fillCard` takes a session, a page, a card id and field
 * TARGETS. It returns which fields were filled and whether it worked. It does
 * not take a value, does not return a value, and there is no argument or
 * response field anywhere on its path that could carry one.
 *
 * ══ Four refusals, each closing a different way this goes wrong ═══════════
 *
 *  1. **No decision in flight ⇒ refuse.** The card is typed as part of an
 *     approved checkout or it is not typed. Without this the verb types the
 *     owner's card into whatever page happens to be open, which is worse than
 *     the write-only design it replaces.
 *
 *  2. **Wrong merchant ⇒ refuse.** The purchase was decided against one
 *     registrable domain. The page must still be on it. This uses
 *     `validateLinkTarget`, the same check the rest of the platform uses,
 *     rather than a fresh host comparison, a second implementation of "is this
 *     the right site" is a second chance to get punycode, userinfo, ports or
 *     the public-suffix boundary wrong.
 *
 *  3. **No redactor ⇒ refuse.** Filling a card into a page whose content can
 *     still be reported to the model is the leak this whole design exists to
 *     prevent. Rather than trusting every call site to install one, the fill
 *     itself will not run without it. The leak cannot happen because the fill
 *     cannot happen.
 *
 *  4. **Material incomplete ⇒ refuse.** A partially-filled payment form is not
 *     a state worth being in: it either fails at the merchant, or it does not
 *     and something was submitted that nobody assembled deliberately.
 *
 * ══ What a failure is allowed to say ══════════════════════════════════════
 *
 * The field name and nothing else. Not the value, not a length, not a prefix,
 * not a masked form, not the underlying driver error, a driver error from a
 * fill can contain the string it was asked to type, and an error message is a
 * read path exactly like a response field is. Every throw from the driver is
 * caught here and replaced with a sentence this module wrote.
 */
import { validateLinkTarget } from '../security/link-validation.js';
import { cardFieldValue, type CardFieldName, type CardMaterialStore } from './card-material.js';
import type { CardFieldKind, CardMaterialRedactor } from './card-redaction.js';
import type { CheckoutPageDriver } from './checkout-page.js';
import type { CheckoutRegistry } from './checkout-registry.js';

/** One field the caller wants filled, and where it is on the page. */
export interface CardFieldTarget {
  readonly field: CardFieldName;
  /** Opaque to this module: a snapshot ref, resolved by the driver. */
  readonly target: string;
}

export interface FillCardRequest {
  readonly sessionId: string;
  readonly pageId: string;
  readonly targets: readonly CardFieldTarget[];
  /** Some checkouts want `07/2029`, some want `07 / 29`. The caller saw the field. */
  readonly expirySeparator?: string | undefined;
  readonly twoDigitYear?: boolean | undefined;
}

/**
 * The only thing that leaves this module.
 *
 * `filled` is a list of FIELD NAMES. There is deliberately no field on this
 * type that could hold a value, so a later change that wanted to echo one back
 * would have to add it and be seen doing so.
 */
export interface FillCardResult {
  readonly ok: boolean;
  readonly filled: readonly CardFieldName[];
  readonly failedField: CardFieldName | null;
  readonly reason: string | null;
}

export class FillCardRefusal extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'FillCardRefusal';
  }
}

/** Which redaction bucket a card field belongs to. */
function kindOf(field: CardFieldName): CardFieldKind {
  if (field === 'number') return 'number';
  if (field === 'cvv') return 'cvv';
  if (field === 'cardholderName') return 'cardholder';
  return 'expiry';
}

export interface FillCardDeps {
  readonly registry: CheckoutRegistry;
  readonly cards: CardMaterialStore;
  readonly redactor: CardMaterialRedactor;
  readonly driver: CheckoutPageDriver;
}

/**
 * Read the stored card and type it into the page, or refuse.
 *
 * The order of operations is load-bearing and is not an implementation detail:
 *
 *   check the decision  ─┐ both before any material is read, so a refused fill
 *   check the origin    ─┘ never brings a card number into memory at all
 *   read the material
 *   ARM THE REDACTOR      before the first keystroke, never after
 *   type
 *
 * Arming before typing rather than after is the difference between a crash
 * mid-fill leaving redacted material and leaving readable material. A fill that
 * throws halfway has still put characters in the field.
 */
export async function fillCard(
  request: FillCardRequest,
  deps: FillCardDeps,
): Promise<FillCardResult> {
  const { registry, cards, redactor, driver } = deps;

  if (request.targets.length === 0) {
    throw new FillCardRefusal(
      'No card fields were named, so there is nothing to fill.',
      'Pass the fields you found on the checkout, each with the ref to type it into.',
    );
  }

  // ── 1. A purchase must be in flight on this exact page ──────────────────
  const checkout = registry.current(request.sessionId, request.pageId);
  if (checkout === null) {
    throw new FillCardRefusal(
      'Refused: no purchase decision is in flight on this page, so there is nothing to pay for. '
      + 'The card is typed as part of an approved checkout or not at all.',
      'Start the purchase first, so the budget, the cart check and the window have all run.',
    );
  }
  if (checkout.phase !== 'arming-payment') {
    throw new FillCardRefusal(
      `Refused: this purchase is at the "${checkout.phase}" stage, and the card is only typed once `
      + 'the decision and the window have both settled.',
      'Let the purchase reach the payment stage before filling the card.',
    );
  }

  // ── 2. The page must still be the merchant the purchase was decided for ──
  const pageUrl = await driver.url();
  const validation = validateLinkTarget(pageUrl, checkout.merchantDomain);
  if (!validation.ok) {
    throw new FillCardRefusal(
      `Refused: this purchase was decided for "${checkout.merchantDomain}" and this page is not on it. `
      + validation.message,
      'Navigate back to the merchant the purchase was decided against, or start a new purchase.',
    );
  }

  // ── 3. No redactor, no fill ─────────────────────────────────────────────
  // Structural rather than advisory: page content reported after a fill would
  // hand the model the number the daemon just typed, which is the exact leak
  // this design exists to close.
  if (typeof redactor.arm !== 'function' || typeof redactor.redact !== 'function') {
    throw new FillCardRefusal(
      'Refused: this browser session has no card-material redaction installed, so anything typed '
      + 'could be read straight back out of a page snapshot.',
      'Construct the browser engine with a card field guard before running a purchase through it.',
    );
  }

  // ── 4. Complete material or nothing ─────────────────────────────────────
  const material = await cards.read(checkout.cardId);
  if (material === null) {
    throw new FillCardRefusal(
      'Refused: that card\'s stored details are incomplete, so I would be filling part of a payment form.',
      'Re-enter the card at a local terminal or in the webui so every field is stored.',
    );
  }

  const options = {
    ...(request.expirySeparator === undefined ? {} : { expirySeparator: request.expirySeparator }),
    ...(request.twoDigitYear === undefined ? {} : { twoDigitYear: request.twoDigitYear }),
  };

  // Arm with every component, not only the ones being typed. A page that can
  // read one field can read the rest of the form, and the redactor's job is to
  // keep the material out of reported content rather than to track which parts
  // of it we happened to use.
  redactor.arm(request.sessionId, request.pageId, [
    { kind: 'number', value: material.number },
    { kind: 'cvv', value: material.cvv },
    { kind: 'cardholder', value: material.cardholderName },
    { kind: 'expiry', value: cardFieldValue(material, 'expiry', options) },
  ]);

  // Every field's value is computed FIRST, so an incomplete stored card
  // refuses before anything is typed rather than after some fields already
  // are. `request.targets` and `values` stay in the same order throughout,
  // which is what lets the driver's per-batch result be zipped back onto
  // field names below without either side needing to name the other's
  // vocabulary.
  const values: string[] = [];
  for (const target of request.targets) {
    const value = cardFieldValue(material, target.field, options);
    if (value.trim().length === 0) {
      return {
        ok: false,
        filled: [],
        failedField: target.field,
        reason: `The stored card has nothing for the ${target.field} field.`,
      };
    }
    values.push(value);
  }

  // Field names are looked up by TARGET rather than by position. The driver
  // resolves every ref before typing any of them, so a ref that fails to
  // resolve partway through the batch is not necessarily the first one; a
  // `filled`/`failedTarget` read back by array index would then name field one
  // regardless of which field actually stopped it.
  const fieldByTarget = new Map(request.targets.map((target) => [target.target, target.field]));

  let outcome: { readonly filledTargets: readonly string[]; readonly failedTarget: string | null };
  try {
    outcome = await driver.fillSecrets(
      request.targets.map((target, index) => ({ target: target.target, value: values[index]!, kind: kindOf(target.field) })),
    );
  } catch (error) {
    // The driver's own message is discarded rather than wrapped. A fill error
    // from a browser can quote the string it was asked to type, and an error
    // is a read path like any other. `fillSecrets` is documented to report an
    // unresolvable ref as `failedTarget` rather than throw (checkout-page.ts),
    // so a throw reaching here is the genuinely unexpected case: something
    // failed before the driver could even name which target it concerned, and
    // this module has no more specific field to report than that.
    void error;
    return {
      ok: false,
      filled: [],
      failedField: null,
      reason: 'The card fields could not be filled on this checkout.',
    };
  }

  const filled = outcome.filledTargets
    .map((target) => fieldByTarget.get(target))
    .filter((field): field is CardFieldName => field !== undefined);
  if (outcome.failedTarget !== null) {
    const failedField = fieldByTarget.get(outcome.failedTarget) ?? null;
    return {
      ok: false,
      filled,
      failedField,
      reason: `The ${failedField ?? 'card'} field could not be filled on this checkout.`,
    };
  }
  return { ok: true, filled, failedField: null, reason: null };
}
