/**
 * Performance budget system — barrel export.
 *
 * Provides budget definitions, the PerfMonitor class for metric collection
 * and budget evaluation, and the reporter for CI/console output.
 *
 * @example
 * ```ts
 * import { createPerfMonitor, DEFAULT_BUDGETS } from './perf/index.js';
 *
 * const monitor = createPerfMonitor();
 * const report = monitor.evaluate(snapshot);
 * ```
 */

export type {
  PerfBudget,
  PerfMetric,
  BudgetViolation,
  PerfReport,
  PerfUnit,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/types';

export { DEFAULT_BUDGETS } from '@pellux/goodvibes-sdk/platform/runtime/perf/budgets';
export { PerfMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/monitor';
export type { PerfSnapshot } from '@pellux/goodvibes-sdk/platform/runtime/perf/monitor';
export { formatReport, exitCode } from '@pellux/goodvibes-sdk/platform/runtime/perf/reporter';
export { SloCollector, SLO_METRICS } from './slo-collector.js';
// Generic Component* names (canonical — prefer these in new code)
export type {
  ComponentResourceContract,
  ComponentHealthState,
  ComponentThrottleStatus,
  ComponentHealthStatus,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/component-contracts';
export {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/component-contracts';
export { ComponentHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor';

// Panel* names (deprecated backward-compat aliases — kept for existing consumers)
export type {
  PanelResourceContract,
  PanelHealthState,
  PanelThrottleStatus,
  PanelHealthStatus,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/component-contracts';
export {
  createInitialPanelHealthState,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/component-contracts';
export {
  PanelHealthMonitor,
} from '@pellux/goodvibes-sdk/platform/runtime/perf/component-health-monitor';

import { PerfMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/monitor';
import type { PerfBudget } from '@pellux/goodvibes-sdk/platform/runtime/perf/types';
import { DEFAULT_BUDGETS } from '@pellux/goodvibes-sdk/platform/runtime/perf/budgets';

/**
 * Factory function that creates a PerfMonitor with the default budgets.
 * Pass a custom budgets array to override defaults.
 *
 * @param budgets - Optional custom budget definitions.
 * @returns A new PerfMonitor instance ready for evaluation.
 */
export function createPerfMonitor(budgets: PerfBudget[] = DEFAULT_BUDGETS): PerfMonitor {
  return new PerfMonitor(budgets);
}
