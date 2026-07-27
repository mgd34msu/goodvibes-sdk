/**
 * taint-gate.ts — a payment whose target, amount or item derives from untrusted
 * content is refused outright.
 *
 * No owner-address exemption. No disclose-instead-of-refuse fallback. No
 * approval path around it. This is the one gate in the capability with no
 * downstream branch at all.
 *
 * ── Why this does not call evaluateOutwardEffect ──────────────────────────
 *
 * `security/untrusted-content.ts` exposes `evaluateOutwardEffect`, which is what
 * `email.send` uses. It accepts an `OwnerApproval` and, when one matches the
 * action, returns `allowed: true` FOR TAINTED CONTENT:
 *
 *     if (input.approval && input.approval.action === input.request.action) {
 *       return { allowed: true, ... };
 *     }
 *
 * That escape hatch is right for email — the owner can decide to forward
 * something a stranger wrote — and wrong for money, where the same escape hatch
 * is exactly the step an injection is trying to reach. The reliable way to
 * guarantee it cannot fire is to not be on that code path, so this module calls
 * `findContentTaint` directly. There is a test that passes a valid OwnerApproval
 * for the same action and asserts the payment is still refused.
 *
 * ── Which fields are checked, and which deliberately are not ──────────────
 *
 * CHECKED — the fields that decide WHETHER and WHERE money moves. These come
 * from the owner or they do not exist:
 *
 *   merchant      exact containment (short, high-signal — the whole value is
 *                 the payload, exactly like a recipient address)
 *   checkoutUrl   exact containment
 *   item          the length thresholds
 *   requestedMax  the length thresholds, when the request states a limit
 *
 * NOT CHECKED — the merchant's own quoted numbers. The price, tax, fees and
 * shipping costs are READ FROM THE MERCHANT by definition. Taint-checking them
 * would refuse every purchase, and a check that is permanently tripped gets
 * removed — the precise failure mode content-taint.ts was written to avoid. The
 * defence for those numbers is not taint, it is the BUDGET: a page that inflates
 * a price hits the daily item budget or the per-purchase ceiling and needs an
 * approval, and that approval shows our own re-rendered number (message.ts).
 *
 * A deliberate consequence: "buy me the cheapest X you can find online" is
 * refused, because the merchant was chosen from page content rather than named
 * by the owner. He names the merchant, or there is no purchase. That is a
 * feature of the design and is tested as one.
 */
import { findContentTaint, type TaintFinding } from '../security/content-taint.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';

export interface PaymentIntentFields {
  /** The merchant the OWNER named. Not one discovered on a page. */
  readonly merchant: string | undefined;
  /** The checkout url, when one was supplied rather than reached by navigation. */
  readonly checkoutUrl: string | undefined;
  /** What he asked to buy, in his words. */
  readonly item: string | undefined;
  /** A spend limit stated in the request, if any. */
  readonly requestedMax: string | undefined;
}

export interface PaymentTaintDecision {
  readonly allowed: boolean;
  readonly findings: readonly TaintFinding[];
  readonly reason: string | null;
}

/**
 * Refuse a payment whose intent derives from untrusted content.
 *
 * `ledger` is the process-wide untrusted-content ledger — the same one the
 * browser's page reads and the mail surface's body reads both record into, so a
 * "read a stranger's page, then buy something" composition is visible here as
 * ONE act rather than two unrelated ones.
 */
export function evaluatePaymentTaint(input: {
  readonly intent: PaymentIntentFields;
  readonly ledger: UntrustedContentLedger;
}): PaymentTaintDecision {
  const sources = input.ledger.taintSourcesThisTurn();
  if (sources.length === 0) {
    return { allowed: true, findings: [], reason: null };
  }

  const fields: Record<string, string | undefined> = {
    merchant: input.intent.merchant,
    checkoutUrl: input.intent.checkoutUrl,
    item: input.intent.item,
    requestedMax: input.intent.requestedMax,
  };

  const findings = findContentTaint(fields, sources, {
    // The merchant and the checkout url are WHERE the money goes. Length
    // thresholds are the wrong instrument for a field whose entire value is the
    // payload, so both are tested by containment.
    exactMatchFields: ['merchant', 'checkoutUrl'],
    // No reply exemption and no quote stripping: there is no legitimate payment
    // shape that quotes a stranger's text.
  });

  if (findings.length === 0) {
    return { allowed: true, findings: [], reason: null };
  }
  return { allowed: false, findings, reason: describePaymentTaint(findings) };
}

/**
 * The refusal he reads.
 *
 * Names the field, the surface and the origin and shows the overlapping text,
 * because "refused: untrusted content" with no evidence is indistinguishable
 * from a bug and gets worked around.
 */
export function describePaymentTaint(findings: readonly TaintFinding[]): string {
  const first = findings[0];
  if (first === undefined) return 'Refused this purchase.';
  const fields = [...new Set(findings.map((finding) => finding.field))].join(', ');
  return (
    `Refused this purchase: its ${fields} derives from content read from ${first.surface} `
    + `(${first.origin}), which anyone can write. The overlapping text is "${first.excerpt}". `
    + 'Content that arrived from outside cannot decide what gets bought or who gets paid. '
    + 'Tell me the merchant and the item yourself, and I will price it against your budget.'
  );
}
