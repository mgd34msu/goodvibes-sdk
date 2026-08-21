/**
 * checkout-page.ts, the narrow set of page operations a purchase needs.
 *
 * The checkout flow does not import the browser engine. It names the handful of
 * things it needs done to a page and takes an implementation, for three
 * reasons that each turned out to matter:
 *
 *  - The containment tests must be able to drive an entire purchase with a
 *    sentinel card value and then search every output for it. Against a real
 *    browser that is an integration test that cannot run without a downloaded
 *    binary; against this port it is an assertion.
 *  - The flow is merchant-agnostic and must stay that way. A port with six
 *    operations and no selectors in its signatures cannot accumulate
 *    site-specific knowledge without someone noticing.
 *  - `fillSecret` needs to be the ONLY way card material reaches a page, and a
 *    port is where that can be stated as a type rather than as a convention.
 *
 * ── Element addressing ────────────────────────────────────────────────────
 *
 * Targets are opaque strings the CALLER supplies, a snapshot ref in the daemon
 * implementation, a field name in the fixture. This module never constructs
 * one, never parses one, and never has an opinion about what a checkout's
 * fields are called. The model identifies the fields on whatever page it is on;
 * the daemon does the typing.
 */
import type { CardFieldKind } from './card-redaction.js';

/** Which page a driver is bound to, so the redactor can be keyed to it. */
export interface PageIdentity {
  readonly sessionId: string;
  readonly pageId: string;
}

export interface CheckoutPageDriver {
  identity(): PageIdentity;

  /** The page's current url, for the merchant-origin check. */
  url(): Promise<string>;

  /**
   * Type a value into a field.
   *
   * For ordinary values only, an address, a quantity, a coupon. Card material
   * has its own entry point so that no call site can pass one to the other by
   * accident.
   */
  fill(target: string, value: string): Promise<void>;

  /**
   * Type every CARD MATERIAL field in one motion.
   *
   * Batched rather than one call per field: an implementation resolves page
   * elements against a snapshot that typing can invalidate, and a driver that
   * resolved field two only after field one was typed is how a real checkout
   * lost every field after the first. Every target here is resolved before any
   * value is typed. `kind` travels with each field so a failure can name it
   * without the failure path ever holding the value.
   *
   * `filledTargets` lists the targets typed, in order, up to and including a
   * stopping point; `failedTarget` names the one target that stopped it, or is
   * null on full success. An implementation must not log a value, include one
   * in a thrown error, or return one in any form.
   *
   * An unresolvable ref, anywhere in the batch, is reported as `failedTarget`,
   * never thrown: the caller needs the target name to report which field
   * failed, and a throw cannot carry it back. A throw from this method means a
   * failure the implementation could not attribute to any one target at all,
   * a caller catching one has no more specific field to report than "the card
   * fields".
   */
  fillSecrets(fields: readonly { readonly target: string; readonly value: string; readonly kind: CardFieldKind }[]): Promise<{
    readonly filledTargets: readonly string[];
    readonly failedTarget: string | null;
  }>;

  /** Choose one of a set of options, a delivery tier, usually. */
  choose(target: string, value: string): Promise<void>;

  /**
   * Submit the order. The one outward act in the whole flow.
   *
   * Returns whatever identifies the resulting order, when the merchant shows
   * one. A null order id is not a failure, plenty of merchants show a
   * confirmation page with the number somewhere the model has to go read, it
   * just means the audit record carries no merchant reference.
   *
   * Throws `CheckoutSubmitRefused` for a failure BEFORE the click reached the
   * merchant, a typed refusal, an untrusted-effect refusal, a stale ref. Any
   * other throw means the click may have reached the merchant and the caller
   * cannot tell; only that case is genuinely ambiguous.
   */
  submitOrder(target: string): Promise<{
    readonly url: string;
    readonly orderId: string | null;
    /**
     * Set when the merchant interrupted the submit with a verification step,
     * 3-D Secure, a CAPTCHA, a one-time code.
     *
     * Reported rather than solved. The flow pauses, keeps the budget reserved,
     * leaves the journal in `submit-pending`, and hands the owner the exact
     * step. Nothing here tries to answer a challenge, and nothing retries the
     * submit afterwards.
     */
    readonly challenge?: CheckoutChallenge | null | undefined;
    /**
     * Whether a composition read the merchant's own response to this submit.
     *
     * False means: the click was issued and the reservation is being committed
     * as a conservative default against a double-spend, but nothing here
     * confirmed the merchant actually accepted the order. The record and the
     * owner report must say so; neither may claim a verified purchase off a
     * false value.
     */
    readonly verified: boolean;
  }>;
}

/**
 * Thrown by `submitOrder` for a refusal that happened BEFORE any click reached
 * the merchant: a typed refusal, an untrusted-effect refusal, a stale ref, a
 * guard error. The flow treats this as "not submitted" and releases the held
 * budget; every other throw from `submitOrder` is genuine post-click ambiguity
 * and keeps the reservation held.
 */
export class CheckoutSubmitRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutSubmitRefused';
  }
}

/** A verification step the merchant put in the way, described for the owner. */
export interface CheckoutChallenge {
  readonly kind: '3d-secure' | 'captcha' | 'otp' | 'unknown';
  /** Plain words this code wrote. Never merchant text. */
  readonly step: string;
  readonly url: string;
}
