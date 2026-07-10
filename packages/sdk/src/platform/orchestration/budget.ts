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
import type { WorkItem, Workstream } from './types.js';

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

/**
 * Refuses a NEW claim once the workstream's running total has reached its
 * ceiling. Never mid-item. When `item` is supplied and carries its own
 * `itemBudget`, that per-item ceiling is checked too (against the item's own
 * usage) — a best-of-N attempt, or any opted-in item, can be bounded
 * independently of the workstream (see WorkItem.itemBudget). The stricter of the
 * two refuses.
 */
export function checkBudget(workstream: Workstream, item?: WorkItem): BudgetCheck {
  const itemCheck = item?.itemBudget ? checkItemBudget(item) : { allowed: true as const };
  if (!itemCheck.allowed) return itemCheck;

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

/** Per-item ceiling check against the item's own accumulated usage (never mid-item). */
function checkItemBudget(item: WorkItem): BudgetCheck {
  const budget = item.itemBudget;
  if (!budget) return { allowed: true };
  if (budget.maxTokens !== undefined) {
    const tokens = item.usage.inputTokens + item.usage.outputTokens;
    if (tokens >= budget.maxTokens) {
      return { allowed: false, reason: `item token usage (${tokens}) has reached its ${budget.maxTokens}-token ceiling` };
    }
  }
  if (budget.maxCostUsd !== undefined && item.usage.costUsd !== null && item.usage.costUsd >= budget.maxCostUsd) {
    return { allowed: false, reason: `item cost ($${item.usage.costUsd.toFixed(4)}) has reached its $${budget.maxCostUsd} ceiling` };
  }
  return { allowed: true };
}
