/**
 * Planner emitters — typed emission wrappers for adaptive planner events.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';
import type { PlannerDecision, ExecutionStrategy } from '../../core/adaptive-planner.js';

export function emitPlanStrategySelected(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  decision: PlannerDecision
): void {
  bus.emit('planner', createEventEnvelope('PLAN_STRATEGY_SELECTED', { type: 'PLAN_STRATEGY_SELECTED', ...decision }, ctx));
}

export function emitPlanStrategyOverridden(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { strategy: ExecutionStrategy | null; clearedBy?: string }
): void {
  bus.emit('planner', createEventEnvelope('PLAN_STRATEGY_OVERRIDDEN', { type: 'PLAN_STRATEGY_OVERRIDDEN', ...data }, ctx));
}
