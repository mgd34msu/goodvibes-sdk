/**
 * UnifiedTaskManager — central task lifecycle management for all subsystem
 * task kinds (exec, agent, acp, scheduler, daemon, mcp, plugin, integration).
 *
 * Responsibilities:
 * - Create tasks with type-safe params
 * - Enforce lifecycle state machine transitions
 * - Track parent/child relationships
 * - Emit TaskEvents via RuntimeEventBus at each transition
 * - Update RuntimeState.tasks domain via Zustand store
 * - Track per-kind concurrency
 * - Support retry policies
 */

import { GoodVibesSdkError } from '../../../errors/index.js';
import { createDomainDispatch } from '../store/index.js';
import type { RuntimeStore, DomainDispatch } from '../store/index.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { RuntimeTask, TaskKind, TaskLifecycleState } from '../store/domains/tasks.js';
import type { EmitterContext } from '../emitters/index.js';
import type {
  TaskManager,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCancelParams,
  TaskFailParams,
} from './types.js';
import { TaskRegistry } from './registry.js';
import { canTransition } from './lifecycle.js';
import {
  emitTaskCreated,
  emitTaskStarted,
  emitTaskBlocked,
  emitTaskCompleted,
  emitTaskFailed,
  emitTaskCancelled,
} from '../emitters/tasks.js';
import type { FeatureFlagReader } from '../feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../feature-flags/index.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a requested task lifecycle transition is not permitted. */
export class TaskTransitionError extends GoodVibesSdkError {
  declare readonly code: 'TASK_TRANSITION_ERROR';
  public readonly taskId: string;
  public readonly from: TaskLifecycleState;
  public readonly to: TaskLifecycleState;

  public constructor(
    taskId: string,
    from: TaskLifecycleState,
    to: TaskLifecycleState
  ) {
    super(
      `[TaskManager] Invalid transition ${from} → ${to} for task ${taskId}`,
      { code: 'TASK_TRANSITION_ERROR', category: 'internal', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskTransitionError';
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when a task ID cannot be found in the registry. */
export class TaskNotFoundError extends GoodVibesSdkError {
  declare readonly code: 'TASK_NOT_FOUND';
  public readonly taskId: string;

  public constructor(taskId: string) {
    super(
      `[TaskManager] Task not found: ${taskId}`,
      { code: 'TASK_NOT_FOUND', category: 'not_found', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/** Thrown when cancellation is attempted on a non-cancellable task. */
export class TaskNotCancellableError extends GoodVibesSdkError {
  declare readonly code: 'TASK_NOT_CANCELLABLE';
  public readonly taskId: string;

  public constructor(taskId: string) {
    super(
      `[TaskManager] Task ${taskId} is not cancellable`,
      { code: 'TASK_NOT_CANCELLABLE', category: 'internal', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskNotCancellableError';
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// UnifiedTaskManager
// ---------------------------------------------------------------------------

/**
 * UnifiedTaskManager — implements TaskManager using a TaskRegistry for
 * in-memory lookup and a Zustand store + RuntimeEventBus for persistence
 * and event emission.
 */
export class UnifiedTaskManager implements TaskManager {
  private readonly _registry = new TaskRegistry();
  private readonly _store: RuntimeStore;
  private readonly _dispatch: DomainDispatch;
  private readonly _bus: RuntimeEventBus;
  /** Session ID for emitter context. */
  private readonly _sessionId: string;
  private readonly _featureFlags: FeatureFlagReader;

  /**
   * @param store - The Zustand runtime store to dispatch state updates to.
   * @param bus - The RuntimeEventBus to emit task lifecycle events on.
   * @param sessionId - The current session identifier for emitter context.
   */
  public constructor(
    store: RuntimeStore,
    bus: RuntimeEventBus,
    sessionId: string,
    featureFlags?: FeatureFlagReader,
  ) {
    this._store = store;
    this._dispatch = createDomainDispatch(store);
    this._bus = bus;
    this._sessionId = sessionId;
    this._featureFlags = featureFlags ?? null;
  }

  private _isEnabled(): boolean {
    return isFeatureGateEnabled(this._featureFlags, 'unified-runtime-task');
  }

  private _requireEnabled(operation: string): void {
    requireFeatureGate(this._featureFlags, 'unified-runtime-task', operation);
  }

  // ── TaskManager interface ────────────────────────────────────────────────

  public createTask(params: TaskCreateParams): RuntimeTask {
    this._requireEnabled('create runtime task');
    const now = Date.now();
    const id = crypto.randomUUID();

    const task: RuntimeTask = {
      id,
      kind: params.kind,
      title: params.title,
      description: params.description,
      status: 'queued',
      owner: params.owner,
      cancellable: params.cancellable ?? true,
      parentTaskId: params.parentTaskId,
      childTaskIds: [],
      queuedAt: now,
      retryPolicy: params.retryPolicy,
      correlationId: params.correlationId,
      turnId: params.turnId,
    };

    // Register in local registry
    this._registry.register(task);

    // If this task has a parent, add to parent's childTaskIds
    if (params.parentTaskId) {
      this._patchChildIds(params.parentTaskId, id);
    }

    // Persist to store
    this._dispatchCreated(task);

    // Emit event
    emitTaskCreated(this._bus, this._makeCtx(id), {
      taskId: id,
      description: params.title,
      priority: 0,
    });

    return task;
  }

  public startTask(taskId: string): RuntimeTask {
    this._requireEnabled('start runtime task');
    const task = this._requireTask(taskId);
    this._requireTransition(task, 'running');

    const updated = this._applyTransition(task, 'running', {
      startedAt: Date.now(),
    });

    emitTaskStarted(this._bus, this._makeCtx(taskId), { taskId });
    return updated;
  }

  public blockTask(taskId: string, reason: string): RuntimeTask {
    this._requireEnabled('block runtime task');
    const task = this._requireTask(taskId);
    this._requireTransition(task, 'blocked');

    const updated = this._applyTransition(task, 'blocked', {});

    emitTaskBlocked(this._bus, this._makeCtx(taskId), { taskId, reason });
    return updated;
  }

  public completeTask(taskId: string, result?: unknown): RuntimeTask {
    this._requireEnabled('complete runtime task');
    const task = this._requireTask(taskId);
    this._requireTransition(task, 'completed');

    const now = Date.now();
    const durationMs = task.startedAt !== undefined ? now - task.startedAt : 0;

    const updated = this._applyTransition(task, 'completed', {
      endedAt: now,
      result,
    });

    emitTaskCompleted(this._bus, this._makeCtx(taskId), { taskId, durationMs });
    return updated;
  }

  public failTask(taskId: string, params: TaskFailParams): RuntimeTask {
    this._requireEnabled('fail runtime task');
    const task = this._requireTask(taskId);
    this._requireTransition(task, 'failed');

    const now = Date.now();
    const durationMs = task.startedAt !== undefined ? now - task.startedAt : 0;

    // Check retry policy
    if (task.retryPolicy) {
      const { maxAttempts, currentAttempt, delayMs, backoff } = task.retryPolicy;
      if (currentAttempt < maxAttempts) {
        // Increment attempt and re-queue
        const updatedPolicy = {
          ...task.retryPolicy,
          currentAttempt: currentAttempt + 1,
        };
        const resolvedDelay =
          backoff === 'exponential'
            ? delayMs * Math.pow(2, currentAttempt - 1)
            : delayMs;

        const requeued = this._applyTransition(task, 'queued', {
          retryPolicy: updatedPolicy,
          error: params.error,
          exitCode: params.exitCode,
          startedAt: undefined,
          endedAt: undefined,
          retryDelayMs: resolvedDelay,
          retryAt: now + resolvedDelay,
        });

        // Emit failed event then re-queue semantically
        emitTaskFailed(this._bus, this._makeCtx(taskId), {
          taskId,
          error: `${params.error} (retry ${currentAttempt}/${maxAttempts} in ${resolvedDelay}ms)`,
          durationMs,
        });

        return requeued;
      }
    }

    // No retry — mark as permanently failed
    const updated = this._applyTransition(task, 'failed', {
      endedAt: now,
      error: params.error,
      exitCode: params.exitCode,
    });

    emitTaskFailed(this._bus, this._makeCtx(taskId), {
      taskId,
      error: params.error,
      durationMs,
    });

    return updated;
  }

  public cancelTask(taskId: string, params?: TaskCancelParams): RuntimeTask {
    this._requireEnabled('cancel runtime task');
    const task = this._requireTask(taskId);

    if (!task.cancellable) {
      throw new TaskNotCancellableError(taskId);
    }

    this._requireTransition(task, 'cancelled');

    const now = Date.now();
    const updated = this._applyTransition(task, 'cancelled', {
      endedAt: now,
    });

    emitTaskCancelled(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: params?.reason,
    });

    return updated;
  }

  public updateTask(taskId: string, params: TaskUpdateParams): RuntimeTask {
    this._requireEnabled('update runtime task');
    const task = this._requireTask(taskId);

    const updated: RuntimeTask = {
      ...task,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
      ...(params.result !== undefined ? { result: params.result } : {}),
    };

    this._registry.register(updated);
    this._syncTaskToStore(updated);
    return updated;
  }

  public getTask(taskId: string): RuntimeTask | undefined {
    if (!this._isEnabled()) return undefined;
    return this._registry.get(taskId);
  }

  public getTasksByKind(kind: TaskKind): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._registry.getByKind(kind);
  }

  public getRunningTasks(): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._registry.getRunning();
  }

  public getRunningCount(kind: TaskKind): number {
    if (!this._isEnabled()) return 0;
    return this._registry.getByKind(kind).filter((t) => t.status === 'running').length;
  }

  public getChildTasks(parentTaskId: string): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._registry.getChildren(parentTaskId);
  }

  public getTaskStatus(taskId: string): TaskLifecycleState | undefined {
    if (!this._isEnabled()) return undefined;
    return this._registry.get(taskId)?.status;
  }

  public retryTask(taskId: string): RuntimeTask {
    this._requireEnabled('retry runtime task');
    const task = this._requireTask(taskId);

    if (task.status !== 'failed' && task.status !== 'cancelled') {
      throw new TaskTransitionError(task.id, task.status, 'queued');
    }

    return this._applyTransition(task, 'queued', {
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      exitCode: undefined,
      retryAt: undefined,
      retryDelayMs: undefined,
      queuedAt: Date.now(),
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Returns a task or throws TaskNotFoundError.
   */
  private _requireTask(taskId: string): RuntimeTask {
    const task = this._registry.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  /**
   * Validates a transition is permitted; throws TaskTransitionError otherwise.
   */
  private _requireTransition(
    task: RuntimeTask,
    to: TaskLifecycleState
  ): void {
    if (!canTransition(task.status, to)) {
      throw new TaskTransitionError(task.id, task.status, to);
    }
  }

  /**
   * Applies a state transition to a task, updates registry and store.
   */
  private _applyTransition(
    task: RuntimeTask,
    to: TaskLifecycleState,
    patch: Partial<RuntimeTask>
  ): RuntimeTask {
    const updated: RuntimeTask = { ...task, status: to, ...patch };
    this._registry.register(updated);
    this._syncTaskToStore(updated);
    return updated;
  }

  /**
   * Adds a child task ID to a parent task's childTaskIds array.
   */
  private _patchChildIds(parentId: string, childId: string): void {
    const parent = this._registry.get(parentId);
    if (!parent) return;
    const updated: RuntimeTask = {
      ...parent,
      childTaskIds: [...parent.childTaskIds, childId],
    };
    this._registry.register(updated);
    this._syncTaskToStore(updated);
  }

  /**
   * Constructs a minimal EmitterContext for a given task.
   */
  private _makeCtx(taskId: string): EmitterContext {
    return {
      sessionId: this._sessionId,
      source: 'task-manager',
      traceId: crypto.randomUUID(),
      taskId,
    };
  }

  /**
   * Dispatches TASK_CREATED state update to the Zustand store.
   */
  private _dispatchCreated(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'task-manager');
  }

  /**
   * Syncs an updated task to the Zustand store, adjusting status index arrays.
   */
  private _syncTaskToStore(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'task-manager');
  }
}
