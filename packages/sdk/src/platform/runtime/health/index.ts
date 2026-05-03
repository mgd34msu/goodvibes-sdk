/**
 * Runtime health monitoring system — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createHealthSystem } from './health/index.js';
 * const { aggregator, cascadeEngine } = createHealthSystem();
 * ```
 */

export type {
  HealthStatus,
  HealthDomain,
  DomainHealth,
  CompositeHealth,
  CascadeEffect,
  CascadeRule,
  CascadeResult,
  EvaluateResult,
  CascadeAppliedEvent,
} from './types.js';
export { createCascadeAppliedEvent } from './types.js';

export { RuntimeHealthAggregator } from './aggregator.js';
export { CascadeEngine } from './cascade-engine.js';
export { CASCADE_RULES } from './cascade-rules.js';
export { HealthStoreWiring } from './wiring.js';
export { handleCascadeEffect } from './effect-handlers.js';
export type { EffectHandlerContext } from './effect-handlers.js';
export { CascadeTimer, deriveCascadeSeverity } from './cascade-timing.js';
export type { CascadeSeverity, TimedCascadeResult, TimedEvaluateResult } from './cascade-timing.js';
export { CASCADE_PLAYBOOK_MAP, ALL_CASCADE_RULE_IDS } from './cascade-playbook-map.js';

import { RuntimeHealthAggregator } from './aggregator.js';
import { CascadeEngine } from './cascade-engine.js';
import { CASCADE_RULES } from './cascade-rules.js';
import { HealthStoreWiring } from './wiring.js';

/**
 * Factory function that creates a fully wired health monitoring system.
 * The CascadeEngine is pre-loaded with all cascade rules from the rules table.
 *
 * @returns aggregator for tracking domain health, and cascadeEngine for evaluating cascades.
 */
export function createHealthSystem(): {
  aggregator: RuntimeHealthAggregator;
  cascadeEngine: CascadeEngine;
} {
  const aggregator = new RuntimeHealthAggregator();
  const cascadeEngine = new CascadeEngine(CASCADE_RULES, aggregator);
  return { aggregator, cascadeEngine };
}

/**
 * Factory function that creates a fully wired health monitoring system
 * with error propagation connected to the event bus.
 *
 * @param eventBus - The RuntimeEventBus to receive CASCADE_APPLIED events.
 * @returns aggregator, cascadeEngine, and the wiring controller.
 */
export function createWiredHealthSystem(eventBus: import('../events/index.js').RuntimeEventBus): {
  aggregator: RuntimeHealthAggregator;
  cascadeEngine: CascadeEngine;
  wiring: HealthStoreWiring;
} {
  const aggregator = new RuntimeHealthAggregator();
  const cascadeEngine = new CascadeEngine(CASCADE_RULES, aggregator);
  const wiring = new HealthStoreWiring(aggregator, cascadeEngine, eventBus);
  return { aggregator, cascadeEngine, wiring };
}
