/**
 * cart.ts — the cart must contain what he asked for and nothing else.
 *
 * ── Never add filler items ────────────────────────────────────────────────
 *
 * Owner ruling, and an invariant rather than a preference: never add items to
 * cross a free-shipping threshold. Buying something he did not ask for in order
 * to make the delivery line look better is still buying something he did not ask
 * for, and "it was cheaper overall" is the argument every version of this
 * mistake makes.
 *
 * There is deliberately no free-shipping-threshold logic anywhere in this
 * capability. Its ABSENCE is the design, and absence is hard to test, so the
 * enforcement is positive: the cart is compared against the request immediately
 * before payment and any line he did not ask for aborts the purchase.
 *
 * ── Subscriptions and recurring charges ───────────────────────────────────
 *
 * Refused. A daily budget cannot describe a charge that renews unattended next
 * month; nothing here would notice a renewal, let alone stop one. Enrolling him
 * in a recurring charge on a capability whose entire safety story is a daily
 * limit is the most expensive kind of silent hole.
 *
 * Detection errs toward refusing, on purpose: a false refusal costs him a manual
 * purchase, a false accept costs him a charge nobody is watching.
 */
import type { MinorUnits } from './types.js';

export interface CartLine {
  /** The merchant's own label. Used for comparison and audit, never rendered in a prompt. */
  readonly label: string;
  readonly quantity: number;
  readonly unitMinorUnits: MinorUnits;
}

export interface RequestedLine {
  readonly label: string;
  readonly quantity: number;
}

export interface CartCheck {
  readonly ok: boolean;
  /** Lines present in the cart that the owner did not ask for. */
  readonly unexpected: readonly CartLine[];
  /** Lines he asked for that are missing. */
  readonly missing: readonly RequestedLine[];
  readonly reason: string | null;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Compare the cart against the request, immediately before payment.
 *
 * Quantity is checked too: turning a request for one into a cart of three is the
 * same defect as adding a second product, and only one of those would be caught
 * by comparing labels alone.
 */
export function assertCartMatchesRequest(
  cart: readonly CartLine[],
  requested: readonly RequestedLine[],
): CartCheck {
  const requestedByLabel = new Map<string, RequestedLine>();
  for (const line of requested) requestedByLabel.set(normalizeLabel(line.label), line);

  const unexpected: CartLine[] = [];
  const seen = new Set<string>();
  for (const line of cart) {
    const key = normalizeLabel(line.label);
    const match = requestedByLabel.get(key);
    if (match === undefined || line.quantity > match.quantity) {
      unexpected.push(line);
      continue;
    }
    seen.add(key);
  }

  const missing = requested.filter((line) => !seen.has(normalizeLabel(line.label)));

  if (unexpected.length === 0 && missing.length === 0) {
    return { ok: true, unexpected: [], missing: [], reason: null };
  }

  const parts: string[] = [];
  if (unexpected.length > 0) {
    parts.push(
      `the cart contains ${unexpected.length} line(s) you did not ask for `
      + `(${unexpected.map((line) => line.label).join(', ')})`,
    );
  }
  if (missing.length > 0) {
    parts.push(`it is missing ${missing.map((line) => line.label).join(', ')}`);
  }
  return {
    ok: false,
    unexpected,
    missing,
    reason:
      `Refused before paying: ${parts.join(', and ')}. `
      + 'I never add items you did not ask for, including to reach free shipping.',
  };
}

/**
 * Signals that a checkout would enrol a recurring charge.
 *
 * Conservative by design. A checkout this cannot classify with confidence is
 * refused rather than attempted.
 */
const RECURRING_PATTERNS: readonly RegExp[] = [
  /\bsubscri\w*/i,
  /\brecurring\b/i,
  /\bauto[-\s]?renew\w*/i,
  /\brenews?\s+(?:on|every|automatically)\b/i,
  /\bper\s+(?:month|year|week)\b/i,
  /\b(?:monthly|yearly|annually|weekly)\s+(?:billing|charge|payment|plan)\b/i,
  /\bfree\s+trial\b/i,
  /\bthen\s+[^\n]{0,20}(?:per|\/)\s*(?:mo|month|yr|year)\b/i,
  /\bsave\s+(?:my\s+)?(?:card|payment\s+method)\s+for\s+future\b/i,
];

export interface RecurringCheck {
  readonly recurring: boolean;
  readonly matched: readonly string[];
  readonly reason: string | null;
}

/**
 * Look for recurring-charge language in the order summary.
 *
 * Takes the checkout's own text — which IS untrusted page content, and is used
 * here only to decide whether to REFUSE. Untrusted content can always talk us
 * out of an action; the rule it may never do is talk us into one. Reading it to
 * find a reason to stop is the safe direction of that asymmetry.
 */
export function detectRecurringCharge(orderSummaryText: string): RecurringCheck {
  const matched: string[] = [];
  for (const pattern of RECURRING_PATTERNS) {
    const hit = pattern.exec(orderSummaryText);
    if (hit !== null) matched.push(hit[0]);
  }
  if (matched.length === 0) return { recurring: false, matched: [], reason: null };
  return {
    recurring: true,
    matched,
    reason:
      `Refused: this checkout looks like it sets up a recurring charge (${matched.join(', ')}). `
      + 'A daily budget cannot describe something that renews on its own, and I have no way to '
      + 'stop the next one. Buy this one yourself if you want it.',
  };
}
