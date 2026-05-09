/**
 * Planner emitters — typed emission wrappers for adaptive planner events.
 */
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';
import type { PlannerDecision, ExecutionStrategy } from '../../core/adaptive-planner.js';
import type {
  WorkPlanEventBase,
  WorkPlanSnapshotEventRecord,
  WorkPlanTaskEventRecord,
  WorkPlanTaskStatus,
} from '../../../events/planner.js';

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

export function emitWorkPlanTaskCreated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: WorkPlanEventBase & { readonly task: WorkPlanTaskEventRecord },
): void {
  bus.emit('planner', createEventEnvelope('WORK_PLAN_TASK_CREATED', { type: 'WORK_PLAN_TASK_CREATED', ...data }, ctx));
}

export function emitWorkPlanTaskUpdated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: WorkPlanEventBase & {
    readonly task: WorkPlanTaskEventRecord;
    readonly previousTask: WorkPlanTaskEventRecord;
  },
): void {
  bus.emit('planner', createEventEnvelope('WORK_PLAN_TASK_UPDATED', { type: 'WORK_PLAN_TASK_UPDATED', ...data }, ctx));
}

export function emitWorkPlanTaskStatusChanged(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: WorkPlanEventBase & {
    readonly taskId: string;
    readonly status: WorkPlanTaskStatus;
    readonly previousStatus: WorkPlanTaskStatus;
    readonly task: WorkPlanTaskEventRecord;
  },
): void {
  bus.emit('planner', createEventEnvelope('WORK_PLAN_TASK_STATUS_CHANGED', { type: 'WORK_PLAN_TASK_STATUS_CHANGED', ...data }, ctx));
}

export function emitWorkPlanTaskDeleted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: WorkPlanEventBase & {
    readonly taskId: string;
    readonly task: WorkPlanTaskEventRecord;
  },
): void {
  bus.emit('planner', createEventEnvelope('WORK_PLAN_TASK_DELETED', { type: 'WORK_PLAN_TASK_DELETED', ...data }, ctx));
}

export function emitWorkPlanSnapshotInvalidated(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: WorkPlanEventBase & {
    readonly reason: string;
    readonly snapshot: WorkPlanSnapshotEventRecord;
  },
): void {
  bus.emit('planner', createEventEnvelope('WORK_PLAN_SNAPSHOT_INVALIDATED', { type: 'WORK_PLAN_SNAPSHOT_INVALIDATED', ...data }, ctx));
}
