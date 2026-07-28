/**
 * taint-gate.ts — who may INITIATE a purchase, and who may choose the merchant.
 *
 * These are two different questions and the owner ruled them differently. This
 * module used to conflate them, refusing any purchase whose merchant came from
 * page content and documenting that as a feature. He overrode that:
 *
 *   "the taint gate is wrong. if i tell you to buy the cheapest X you find
 *    online, you will 1) find it, 2) show it to me, and then 3) alert me prior
 *    to purchasing if it is not a major retailer - use your best judgement on
 *    what you consider a major retailer"
 *
 * ══ What relaxed, and what did not ════════════════════════════════════════
 *
 * RELAXED — **who chooses the merchant** on a purchase he initiated. "Buy the
 * cheapest X you can find" is his instruction; the item and the intent are his,
 * and only the storefront was found on a page. That now proceeds, with the
 * merchant graded by `major-retailers.ts` into a veto (silence proceeds) or an
 * approval (silence denies).
 *
 * NOT RELAXED — **who initiates.** Content-initiated purchases are refused
 * absolutely. An email or a web page saying "buy X from Y" cannot start a
 * purchase, cannot name a merchant, and cannot set an amount. There is no
 * owner-approval escape hatch, for the same reason this module has always argued
 * for money: the approval is exactly the step an injection is trying to reach.
 *
 * The distinction is carried in the TYPE rather than checked at runtime.
 * `merchantDiscovered` exists only on `OwnerOriginIntent`, so "a discovered
 * merchant is permissible only on an owner-origin intent" is a fact the compiler
 * enforces rather than a rule a later edit can forget.
 *
 * ══ Why this does not call evaluateOutwardEffect ══════════════════════════
 *
 * `security/untrusted-content.ts` exposes `evaluateOutwardEffect`, which
 * `email.send` uses. It accepts an `OwnerApproval` and, when one matches the
 * action, returns `allowed: true` FOR TAINTED CONTENT. That escape hatch is
 * right for email — the owner can decide to forward something a stranger wrote —
 * and wrong for money. The reliable way to guarantee it cannot fire is to not be
 * on that code path, so this module calls `findContentTaint` directly. A test
 * passes a valid `OwnerApproval` for the same action and asserts a
 * content-initiated purchase is still refused.
 *
 * ══ Which fields are checked ══════════════════════════════════════════════
 *
 * ALWAYS — `item` and `requestedMax`. These come from him or the purchase does
 * not exist. A page that supplies the thing to buy, or the ceiling to buy it
 * under, is initiating a purchase whatever else is true.
 *
 * CONDITIONALLY — `merchant` and `checkoutUrl`. Checked when he NAMED the
 * merchant, because then it has to be his. Not checked when
 * `merchantDiscovered` is set, because there the storefront came off a page by
 * design, and grading it — not refusing it — is the safeguard.
 *
 * NEVER — the merchant's quoted price, tax, fees and shipping. They are read
 * from the merchant by definition; checking them would refuse every purchase and
 * the check would be removed within a release. The BUDGET is their defence: an
 * inflated price hits the daily budget or the per-purchase ceiling and needs an
 * approval, showing our own re-rendered number.
 *
 * See docs/decisions/2026-07-27-a-discovered-merchant-is-graded-not-refused.md
 * for the full record of the override, and docs/payments.md §9.1.
 */
import { findContentTaint, type TaintFinding } from '../security/content-taint.js';
import type { UntrustedContentLedger } from '../security/untrusted-content.js';

/**
 * A purchase the OWNER asked for.
 *
 * `merchantDiscovered` says whether the storefront was found while browsing
 * rather than named by him. It lives only on this variant — a content-origin
 * intent never reaches the point of choosing a merchant.
 */
export interface OwnerOriginIntent {
  readonly origin: 'owner';
  readonly merchantDiscovered: boolean;
  readonly merchant: string | undefined;
  readonly checkoutUrl: string | undefined;
  readonly item: string | undefined;
  readonly requestedMax: string | undefined;
}

/**
 * A purchase something else asked for — a page, an email, a channel message.
 *
 * Deliberately has no `merchantDiscovered` field. Every intent of this shape is
 * refused, so it never gets to choose anything.
 */
export interface ContentOriginIntent {
  readonly origin: 'content';
  readonly merchant: string | undefined;
  readonly checkoutUrl: string | undefined;
  readonly item: string | undefined;
  readonly requestedMax: string | undefined;
}

export type PaymentIntent = OwnerOriginIntent | ContentOriginIntent;

export interface PaymentTaintDecision {
  readonly allowed: boolean;
  readonly findings: readonly TaintFinding[];
  readonly reason: string | null;
  /** Which fields were examined, so a decision can be reconstructed later. */
  readonly checkedFields: readonly string[];
}

/**
 * The refusal for a purchase nothing of his initiated.
 *
 * Terminal. No approval, no downgrade, no notification-based rescue.
 */
export function describeContentInitiatedRefusal(): string {
  return (
    'Refused: nothing you said started this purchase. It came from content that arrived '
    + 'from outside — a page, a message, or a mailbox — and content from outside cannot decide '
    + 'that money moves, however reasonable it looks. If you want this, ask me for it yourself '
    + 'and I will find it and price it against your budget.'
  );
}

/**
 * Evaluate a payment intent against the untrusted content read this turn.
 *
 * `ledger` is the process-wide untrusted-content ledger — the same one the
 * browser's page reads and the mail surface's body reads both record into, so
 * "read a stranger's page, then buy something" is visible here as one act.
 */
export function evaluatePaymentTaint(input: {
  readonly intent: PaymentIntent;
  readonly ledger: UntrustedContentLedger;
}): PaymentTaintDecision {
  // ── The line that does not move ─────────────────────────────────────────
  if (input.intent.origin === 'content') {
    return {
      allowed: false,
      findings: [],
      reason: describeContentInitiatedRefusal(),
      checkedFields: [],
    };
  }

  const intent = input.intent;
  const sources = input.ledger.taintSourcesThisTurn();

  // What must be his, always. A page supplying the thing to buy — or the
  // ceiling to buy it under — is initiating a purchase whatever else is true.
  const fields: Record<string, string | undefined> = {
    item: intent.item,
    requestedMax: intent.requestedMax,
  };
  const exactMatchFields: string[] = [];

  // Where the money goes only has to be his when HE chose it. When the merchant
  // was discovered it came off a page by design, and major-retailers.ts grades
  // it into a veto or an approval rather than refusing it.
  if (!intent.merchantDiscovered) {
    fields['merchant'] = intent.merchant;
    fields['checkoutUrl'] = intent.checkoutUrl;
    // Short, high-signal fields whose entire value is the payload — length
    // thresholds are the wrong instrument, so both are tested by containment.
    exactMatchFields.push('merchant', 'checkoutUrl');
  }

  const checkedFields = Object.keys(fields).filter((key) => fields[key] !== undefined);

  if (sources.length === 0) {
    return { allowed: true, findings: [], reason: null, checkedFields };
  }

  const findings = findContentTaint(fields, sources, { exactMatchFields });
  if (findings.length === 0) {
    return { allowed: true, findings: [], reason: null, checkedFields };
  }
  return { allowed: false, findings, reason: describePaymentTaint(findings), checkedFields };
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
    + 'Tell me the item yourself and I will find it and price it against your budget.'
  );
}
