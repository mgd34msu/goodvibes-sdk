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
} from './types.js';

export { DEFAULT_BUDGETS } from './budgets.js';
export { PerfMonitor } from './monitor.js';
export type { PerfSnapshot } from './monitor.js';
export { formatReport, exitCode } from './reporter.js';
export { SloCollector, SLO_METRICS } from './slo-collector.js';
// Generic Component* names (canonical — prefer these in new code)
export type {
  ComponentResourceContract,
  ComponentHealthState,
  ComponentThrottleStatus,
  ComponentHealthStatus,
} from './component-contracts.js';
export {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
} from './component-contracts.js';
export { ComponentHealthMonitor } from './component-health-monitor.js';

// Panel* names (deprecated backward-compat aliases — kept for existing consumers)
export type {
  PanelResourceContract,
  PanelHealthState,
  PanelThrottleStatus,
  PanelHealthStatus,
} from './component-contracts.js';
export {
  createInitialPanelHealthState,
} from './component-contracts.js';
export {
  PanelHealthMonitor,
} from './component-health-monitor.js';

import { PerfMonitor } from './monitor.js';
import type { PerfBudget } from './types.js';
import { DEFAULT_BUDGETS } from './budgets.js';

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
