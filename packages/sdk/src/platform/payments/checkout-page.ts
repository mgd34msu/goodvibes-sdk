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
   * Type CARD MATERIAL into a field.
   *
   * Separate from `fill` on purpose. An implementation is expected to treat
   * this as the moment page content becomes unreportable, and the flow arms the
   * redactor before the first call. `kind` is carried so a failure can name the
   * field without the failure path ever holding the value.
   *
   * Implementations must not log the value, include it in a thrown error, or
   * return it in any form.
   */
  fillSecret(target: string, value: string, kind: CardFieldKind): Promise<void>;

  /** Choose one of a set of options, a delivery tier, usually. */
  choose(target: string, value: string): Promise<void>;

  /**
   * Submit the order. The one outward act in the whole flow.
   *
   * Returns whatever identifies the resulting order, when the merchant shows
   * one. A null order id is not a failure, plenty of merchants show a
   * confirmation page with the number somewhere the model has to go read, it
   * just means the audit record carries no merchant reference.
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
  }>;
}

/** A verification step the merchant put in the way, described for the owner. */
export interface CheckoutChallenge {
  readonly kind: '3d-secure' | 'captcha' | 'otp' | 'unknown';
  /** Plain words this code wrote. Never merchant text. */
  readonly step: string;
  readonly url: string;
}
