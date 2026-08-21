import { describe, expect, test } from 'bun:test';

import { admitApprovedItemOverdraw } from '../packages/sdk/src/platform/payments/budget.js';
import type { BudgetLimits } from '../packages/sdk/src/platform/payments/budget.js';

/**
 * budget-overdraw.test.ts, direct unit coverage for `admitApprovedItemOverdraw`.
 *
 * checkout-flow.ts already exercises this indirectly through the full
 * approval-window flow (payments-purchase-execution.test.ts's "an over-budget
 * total that he approves goes through"), which proves the raised limit lets a
 * reservation succeed but does not pin the function's own arithmetic: how
 * much it raises the limit by, that it raises ONLY the item limit, and that it
 * is a no-op when nothing needs raising. Those are asserted directly here.
 */

const LIMITS: BudgetLimits = {
  dailyItemMinorUnits: 50_000,
  dailyOverageMinorUnits: 10_000,
  perPurchaseCeiling: { enabled: false, minorUnits: 0 },
  overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 },
};

describe('admitApprovedItemOverdraw', () => {
  test('raises the daily item limit by exactly the shortfall', () => {
    // Item costs 60,000, only 20,000 remains in the pool: a 40,000 shortfall.
    const raised = admitApprovedItemOverdraw(LIMITS, 60_000, 20_000);
    expect(raised.dailyItemMinorUnits).toBe(LIMITS.dailyItemMinorUnits + 40_000);
  });

  test('touches only the item limit, never overage or tolerance', () => {
    const raised = admitApprovedItemOverdraw(LIMITS, 60_000, 20_000);
    expect(raised.dailyOverageMinorUnits).toBe(LIMITS.dailyOverageMinorUnits);
    expect(raised.perPurchaseCeiling).toEqual(LIMITS.perPurchaseCeiling);
    expect(raised.overageTolerance).toEqual(LIMITS.overageTolerance);
  });

  test('is a no-op, returning the same limits, when the item fits what remains', () => {
    const raised = admitApprovedItemOverdraw(LIMITS, 15_000, 20_000);
    expect(raised).toEqual(LIMITS);
  });

  test('is a no-op at the exact boundary, item cost equal to what remains', () => {
    const raised = admitApprovedItemOverdraw(LIMITS, 20_000, 20_000);
    expect(raised.dailyItemMinorUnits).toBe(LIMITS.dailyItemMinorUnits);
  });

  test('never lowers the limit when remaining pool exceeds the item cost', () => {
    const raised = admitApprovedItemOverdraw(LIMITS, 5_000, 20_000);
    expect(raised.dailyItemMinorUnits).toBe(LIMITS.dailyItemMinorUnits);
  });
});
