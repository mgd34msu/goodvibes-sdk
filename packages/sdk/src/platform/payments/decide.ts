/**
 * decide.ts, the decision order, as one pure function over a snapshot.
 *
 * Pure and injectable on purpose: this is the part that must be exercised
 * exhaustively, and a version that needed a browser, a card and a wall clock
 * would be tested thinly and then trusted anyway.
 *
 * ── The order (docs/payments.md §6) ───────────────────────────────────────
 *
 *   0.  GATES, terminal, no approval path, no downgrade path
 *       enabled / card / address / owner request
 *       TAINT: intent derived from untrusted content        → REFUSE
 *       LINK:  checkout url from untrusted content          → validate or REFUSE
 *       currency mismatch, recurring charge                 → REFUSE
 *
 *   1.  ITEM PRICE vs DAILY ITEM BUDGET (+ per-purchase ceiling)
 *       over    → ABOVE BUDGET: explicit approval required
 *                 undeliverable → REFUSE ; silence → DENIED
 *       within  → continue
 *
 *   2.  UNAVOIDABLE + PREFERRED SHIPPING vs OVERAGE POOL
 *       exceeds → LADDER: step down one tier at a time
 *                 fits at a lower rung → record the step-down, continue
 *                 nothing fits         → tolerance pool, else REFUSE
 *
 *   3.  RESERVE
 *   4.  WITHIN BUDGET → VETO WINDOW (silence PROCEEDS)
 *   5.  PAY, with challenge pauses
 *   6.  COMMIT, write the audit record
 *
 * The ladder is ALWAYS attempted before an overage refusal. Owner's words:
 *
 *   "if the notification can't be delivered, under/at budget items get through
 *    while over budget items do not. however, if it is over budget due to
 *    busting the overage budget, attempt to downgrade things like shipping. if
 *    no downgrade is possible, the overbudget item does not go though."
 */
import type { BudgetLimits, PoolSnapshot } from './budget.js';
import { walkShippingLadder, type ShippingLadderResult } from './shipping.js';
import type {
  CurrencyCode,
  MinorUnits,
  RefusalCode,
  ShippingOption,
  ShippingTier,
} from './types.js';

/** What the checkout quoted, once parsed into integers we trust. */
export interface QuotedTotals {
  readonly itemMinorUnits: MinorUnits;
  readonly taxMinorUnits: MinorUnits;
  /** Mandatory handling or booking fees only. Never a discretionary add-on. */
  readonly mandatoryFeesMinorUnits: MinorUnits;
  readonly currency: CurrencyCode;
  readonly shippingOptions: readonly ShippingOption[];
}

export interface DecisionInput {
  readonly quoted: QuotedTotals;
  readonly limits: BudgetLimits;
  readonly pools: PoolSnapshot;
  readonly budgetCurrency: CurrencyCode;
  readonly preferredTier: ShippingTier;
}

export type DecisionOutcome =
  | {
      readonly kind: 'refuse';
      readonly code: RefusalCode;
      readonly reason: string;
    }
  | {
      readonly kind: 'needs-approval';
      readonly draw: BudgetDraw;
      readonly shipping: ShippingLadderResult;
      readonly reason: string;
    }
  | {
      readonly kind: 'within-budget';
      readonly draw: BudgetDraw;
      readonly shipping: ShippingLadderResult;
    };

export interface BudgetDraw {
  readonly itemMinorUnits: MinorUnits;
  readonly overageMinorUnits: MinorUnits;
  readonly toleranceMinorUnits: MinorUnits;
  readonly totalMinorUnits: MinorUnits;
}

/**
 * Steps 1 and 2 of the order, over an already-gated purchase.
 *
 * Gate 0 lives in its own modules (taint-gate.ts, link validation, cart.ts)
 * because each is a hard refusal with its own evidence and its own message; by
 * the time control reaches here those have all passed.
 */
export function decidePurchase(input: DecisionInput): DecisionOutcome {
  const { quoted, limits, pools } = input;

  if (quoted.currency !== input.budgetCurrency) {
    return {
      kind: 'refuse',
      code: 'currency-mismatch',
      reason:
        `Refused: this checkout is priced in ${quoted.currency} and your budget is in `
        + `${input.budgetCurrency}. I will not convert, the issuer converts at its own rate on its `
        + 'own date, so any number I showed you would not be the number you are charged.',
    };
  }

  if (limits.dailyItemMinorUnits <= 0) {
    return {
      kind: 'refuse',
      code: 'zero-budget',
      reason:
        'Refused: the daily item budget is 0, so nothing can be bought yet. '
        + 'Set payments.budget.dailyItem to the most you want spent on items in a day.',
    };
  }

  // ── Step 1: item price against the daily item budget and the ceiling ────
  const overCeiling =
    limits.perPurchaseCeiling.enabled
    && quoted.itemMinorUnits > limits.perPurchaseCeiling.minorUnits;
  const overDaily = quoted.itemMinorUnits > pools.item.remaining;
  const aboveBudget = overCeiling || overDaily;

  // ── Step 2: the unavoidable charges, with the ladder ───────────────────
  const fixedUnavoidable = quoted.taxMinorUnits + quoted.mandatoryFeesMinorUnits;
  const overageAvailable = pools.overage.remaining;

  let shipping = walkShippingLadder({
    preferred: input.preferredTier,
    options: quoted.shippingOptions,
    fixedUnavoidableMinorUnits: fixedUnavoidable,
    budgetForOverageMinorUnits: overageAvailable,
  });

  let toleranceDraw = 0;

  if (shipping === null) {
    // Nothing fits even at the cheapest rung. The tolerance pool is the only
    // remaining path, and it is OFF by default with a zero allowance.
    const ladderAtAnyPrice = walkShippingLadder({
      preferred: input.preferredTier,
      options: quoted.shippingOptions,
      fixedUnavoidableMinorUnits: fixedUnavoidable,
      budgetForOverageMinorUnits: Number.MAX_SAFE_INTEGER,
    });
    if (ladderAtAnyPrice === null) {
      return {
        kind: 'refuse',
        code: 'overage-pool-exhausted',
        reason:
          'Refused: this checkout offers no delivery option, so I cannot work out what the '
          + 'unavoidable charges would be.',
      };
    }
    const cheapestDraw = fixedUnavoidable + ladderAtAnyPrice.costMinorUnits;
    const shortfall = cheapestDraw - overageAvailable;
    if (!limits.overageTolerance.enabled || shortfall > pools.tolerance.remaining) {
      return {
        kind: 'refuse',
        code: 'overage-pool-exhausted',
        reason:
          `Refused: tax, fees and even the cheapest delivery come to ${cheapestDraw} and only `
          + `${overageAvailable} is left in today's overage budget. I stepped delivery all the way `
          + 'down and it still does not fit, so this does not go through.',
      };
    }
    toleranceDraw = shortfall;
    shipping = ladderAtAnyPrice;
  }

  const overageDraw = Math.min(fixedUnavoidable + shipping.costMinorUnits, overageAvailable);
  const draw: BudgetDraw = {
    itemMinorUnits: quoted.itemMinorUnits,
    overageMinorUnits: overageDraw,
    toleranceMinorUnits: toleranceDraw,
    totalMinorUnits: quoted.itemMinorUnits + fixedUnavoidable + shipping.costMinorUnits,
  };

  if (aboveBudget) {
    const why = overCeiling
      ? `it is over the per-purchase ceiling of ${limits.perPurchaseCeiling.minorUnits}`
      : `only ${pools.item.remaining} is left in today's item budget`;
    return {
      kind: 'needs-approval',
      draw,
      shipping,
      reason: `This item costs ${quoted.itemMinorUnits} and ${why}.`,
    };
  }

  return { kind: 'within-budget', draw, shipping };
}
