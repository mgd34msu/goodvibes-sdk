/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Budget enforcement (see CHANGELOG 0.38.0). Enforcement point is BEFORE the
 * scheduler claims an item into a new phase (i.e. before a new agent spawn)
 * — never mid-item. An in-flight item's phase always runs to completion even
 * if a later check here would refuse a NEW claim: honest semantics, never a
 * mid-run kill on budget.
 *
 * Usage is summed directly from WorkItem.usage, which phase-runner.ts
 * populates from the SAME `priceUsage` function threaded through
 * OrchestrationEngineDeps — the single cost source shared with the fleet
 * registry (registry.ts ProcessRegistryDeps.priceUsage), so budget checks and
 * fleet cost totals can never double-count against each other.
 */
import type { Workstream } from './types.js';

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

function totalTokens(workstream: Workstream): number {
  return workstream.items.reduce((sum, item) => sum + item.usage.inputTokens + item.usage.outputTokens, 0);
}

/** Sum of every item's costUsd that IS priced. Returns null when nothing is priced yet (never a fabricated zero). */
function totalCostUsd(workstream: Workstream): number | null {
  let total = 0;
  let sawPriced = false;
  for (const item of workstream.items) {
    if (item.usage.costUsd !== null) {
      total += item.usage.costUsd;
      sawPriced = true;
    }
  }
  return sawPriced ? total : null;
}

/** Refuses a NEW claim once the workstream's running total has reached its ceiling. Never mid-item. */
export function checkBudget(workstream: Workstream): BudgetCheck {
  const budget = workstream.budget;
  if (!budget) return { allowed: true };

  if (budget.maxTokens !== undefined) {
    const tokens = totalTokens(workstream);
    if (tokens >= budget.maxTokens) {
      return { allowed: false, reason: `workstream token usage (${tokens}) has reached the ${budget.maxTokens}-token ceiling` };
    }
  }

  if (budget.maxCostUsd !== undefined) {
    const cost = totalCostUsd(workstream);
    if (cost !== null && cost >= budget.maxCostUsd) {
      return { allowed: false, reason: `workstream cost ($${cost.toFixed(4)}) has reached the $${budget.maxCostUsd} ceiling` };
    }
  }

  return { allowed: true };
}
