/**
 * src/runtime/tools/index.ts — barrel and factory for the phased tool executor.
 *
 * Usage:
 * ```ts
 * import { createPhasedExecutor } from './runtime/tools/index.js';
 *
 * const executor = createPhasedExecutor({
 *   enableHooks: true,
 *   enablePermissions: true,
 *   enableEvents: true,
 * });
 * const result = await executor.execute(call, tool, context);
 * ```
 */
export type { ToolExecutionPhase, PhaseResult, ToolExecutionRecord, ExecutorConfig } from './types.js';
export type {
  ToolRuntimeContext,
  RuntimeStoreAccess,
  TaskHooks,
} from './context.js';
export { PhasedToolExecutor } from './phased-executor.js';
export * from './phases/index.js';

import { PhasedToolExecutor } from './phased-executor.js';
import type { ExecutorConfig } from './types.js';
import type { ConfigManager } from '../../config/manager.js';

/** Default executor configuration. */
const DEFAULTS: ExecutorConfig = {
  enableHooks: true,
  enablePermissions: true,
  enableEvents: true,
};

/**
 * Resolve the default per-phase tool budget from config (runtime.toolBudget.*).
 * Each dimension is included only when its config value is > 0 (0 = unlimited),
 * so an all-zero config yields no default budget (unchanged behaviour).
 */
function resolveDefaultBudget(
  configManager?: Pick<ConfigManager, 'get'>,
): ExecutorConfig['defaultBudget'] {
  if (!configManager) return undefined;
  const maxMs = configManager.get('runtime.toolBudget.maxMs');
  const maxTokens = configManager.get('runtime.toolBudget.maxTokens');
  const maxCostUsd = configManager.get('runtime.toolBudget.maxCostUsd');
  const budget: { maxMs?: number; maxTokens?: number; maxCostUsd?: number } = {};
  if (maxMs > 0) budget.maxMs = maxMs;
  if (maxTokens > 0) budget.maxTokens = maxTokens;
  if (maxCostUsd > 0) budget.maxCostUsd = maxCostUsd;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

/**
 * createPhasedExecutor — factory with sane defaults.
 *
 * Merges the provided partial config over the defaults so callers only
 * need to specify what they want to change. When a ConfigManager is supplied,
 * the default per-phase budget limits are sourced from runtime.toolBudget.*
 * (a per-call ToolRuntimeContext.budget still overrides). An explicit
 * config.defaultBudget wins over the config-derived one.
 *
 * @param config - Optional overrides for ExecutorConfig.
 * @param configManager - Optional config source for runtime-backed defaults.
 * @returns A fully configured PhasedToolExecutor instance.
 */
export function createPhasedExecutor(
  config?: Partial<ExecutorConfig>,
  configManager?: Pick<ConfigManager, 'get'>,
): PhasedToolExecutor {
  const enableBudgetEnforcement =
    config?.enableBudgetEnforcement
    ?? config?.featureFlags?.isEnabled('runtime-tools-budget-enforcement')
    ?? false;
  const defaultBudget = config?.defaultBudget ?? resolveDefaultBudget(configManager);
  return new PhasedToolExecutor({ ...DEFAULTS, ...config, enableBudgetEnforcement, defaultBudget });
}
