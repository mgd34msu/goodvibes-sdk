/**
 * card-material.ts, the one interface that can produce a card number, and the
 * reason it is not reachable from the control plane.
 *
 * ══ What changed, and what deliberately did not ═══════════════════════════
 *
 * The original containment made card material WRITE-ONLY: it went in through
 * `payments.cards.create` and no method returned it. That property was aimed at
 * the right thing and stated one step too far. What must never happen is the
 * MODEL, or any surface, or any control-plane response, holding the number.
 * What must happen, or the capability does nothing, is the DAEMON putting the
 * number into a checkout field.
 *
 * So the property is now stated where it is actually true:
 *
 *   - Nothing in `control-plane/routes/payments.ts` reads card material. That
 *     module still performs no I/O, holds no credential, and never touches a
 *     card number; `payments.checkout.fillCard` takes a card id and field
 *     targets and returns a boolean.
 *   - No control-plane schema carries card material outbound. Still true, and
 *     still enforced by the output schemas rather than by review.
 *   - This interface is in-process only. It is implemented by the daemon
 *     against its own secret store, handed to the checkout flow at construction,
 *     and never crosses a wire in either direction.
 *
 * The model orchestrates the purchase and never holds the instrument. That was
 * always the point; write-only was one expression of it that happened to also
 * forbid the daemon from doing its job.
 *
 * ══ Why a port rather than a direct SecretsManager call ═══════════════════
 *
 * Tests must be able to exercise the entire checkout flow, including the fill,
 * without a real secret store, and much more importantly, the containment
 * assertions must be able to use a sentinel value they can then search every
 * output for. A flow that reached into a concrete secrets module could only be
 * tested with real material or not at all.
 */
import type { CardMetadata } from './types.js';

/**
 * Card material as the daemon reads it out of its own secret store.
 *
 * Every field is a string, including the expiry parts, because they are typed
 * into text fields exactly as given and re-deriving "07" from the number 7 at
 * three different call sites is how a checkout ends up with a one-character
 * expiry month.
 */
export interface CardMaterial {
  readonly number: string;
  readonly expiryMonth: string;
  readonly expiryYear: string;
  readonly cvv: string;
  readonly cardholderName: string;
}

/**
 * The daemon's read path to its own secret store.
 *
 * `read` returning null means the card is configured but its material is
 * incomplete, the `materialComplete: false` case `payments.cards.list` already
 * reports. The checkout refuses; it never fills a form partially and hopes.
 */
export interface CardMaterialStore {
  /** Metadata for a card, or null when no such card is configured. */
  metadata(cardId: string): Promise<CardMetadata | null>;
  /**
   * The material itself. In-process callers only.
   *
   * Implementations must not log the return value, cache it beyond the call, or
   * include it in any error they throw.
   */
  read(cardId: string): Promise<CardMaterial | null>;
}

/**
 * Which of a card's fields a checkout page is asking for.
 *
 * Named rather than positional so a failure can say "the CVV field could not be
 * filled" without the failure path ever holding the CVV.
 */
export type CardFieldName = 'number' | 'expiry' | 'expiryMonth' | 'expiryYear' | 'cvv' | 'cardholderName';

export const CARD_FIELD_NAMES: readonly CardFieldName[] = [
  'number',
  'expiry',
  'expiryMonth',
  'expiryYear',
  'cvv',
  'cardholderName',
];

export function isCardFieldName(value: string): value is CardFieldName {
  return (CARD_FIELD_NAMES as readonly string[]).includes(value);
}

/**
 * The value for one field, derived from the material.
 *
 * `expiry` is the combined form some checkouts use in a single input. Its
 * separator is not guessable from the card, so the caller states it; the
 * adapter for a merchant knows what that merchant's field wants.
 */
export function cardFieldValue(
  material: CardMaterial,
  field: CardFieldName,
  options: { readonly expirySeparator?: string; readonly twoDigitYear?: boolean } = {},
): string {
  const separator = options.expirySeparator ?? '/';
  const year = options.twoDigitYear === true
    ? material.expiryYear.slice(-2)
    : material.expiryYear;
  switch (field) {
    case 'number':
      return material.number;
    case 'cvv':
      return material.cvv;
    case 'cardholderName':
      return material.cardholderName;
    case 'expiryMonth':
      return material.expiryMonth;
    case 'expiryYear':
      return year;
    case 'expiry':
      return `${material.expiryMonth}${separator}${year}`;
    default:
      return '';
  }
}
