/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * TaskEvent — discriminated union covering all task lifecycle events.
 *
 * Maps to the typed runtime event contract for the tasks domain.
 */

export type TaskEvent =
  /** A new task has been created in the task queue. */
  | { type: 'TASK_CREATED'; taskId: string; agentId?: string; description: string; priority: number }
  /** Task execution has started. */
  | { type: 'TASK_STARTED'; taskId: string; agentId?: string }
  /** Task is blocked waiting on a dependency or resource. */
  | { type: 'TASK_BLOCKED'; taskId: string; agentId?: string; reason: string }
  /** Task has made measurable progress. */
  | { type: 'TASK_PROGRESS'; taskId: string; agentId?: string; progress: number; message?: string }
  /** Task completed successfully. */
  | { type: 'TASK_COMPLETED'; taskId: string; agentId?: string; durationMs: number }
  /** Task failed with an error. */
  | { type: 'TASK_FAILED'; taskId: string; agentId?: string; error: string; durationMs: number }
  /** Task was cancelled before completion. */
  | { type: 'TASK_CANCELLED'; taskId: string; agentId?: string | undefined; reason?: string | undefined }
  /**
   * Granular progress update for a batch job running as a task.
   *
   * Emitted by the batch processor as each item completes. UIs should use this
   * to render progress bars and ETA estimates for long-running batch operations.
   *
   * **Integration note:** Emission sites live in `platform/batch`. Wire by calling
   * `bus.emit('tasks', { type: 'BATCH_JOB_PROGRESS', ... })` at each item-complete
   * checkpoint inside the batch runner. The contract is defined here so SDK consumers
   * can subscribe to it without depending on the internal batch module.
   *
   * **Scope note:** `operationId` is operation-scoped (not task-scoped). See `lifecycle.ts`
   * for the guard that ties progress events to their originating operation lifecycle.
   */
  | {
      type: 'BATCH_JOB_PROGRESS';
      /** Stable identifier for this batch operation (survives retries). */
      operationId: string;
      /** Human-readable label for the current processing phase (e.g. `'embedding'`, `'indexing'`). */
      phase: string;
      /** Number of items completed so far. */
      completed: number;
      /** Total items in the batch (undefined if not yet known). */
      total?: number | undefined;
      /** Completion percentage 0–100 (undefined if total unknown). */
      percent?: number | undefined;
      /** Optional human-readable status message. */
      message?: string | undefined;
    }
  /**
   * Granular progress update for an export operation.
   *
   * Emitted by the export engine as records are serialised. UIs should use this
   * to render progress indicators for long-running export jobs.
   *
   * **Integration note:** Emission sites live in `platform/export`. Wire by calling
   * `bus.emit('tasks', { type: 'EXPORT_PROGRESS', ... })` at each record-write
   * checkpoint inside the export runner. The contract is defined here so SDK consumers
   * can subscribe without depending on the internal export module.
   *
   * **Scope note:** `operationId` is operation-scoped (not task-scoped). See `lifecycle.ts`
   * for the guard that ties progress events to their originating operation lifecycle.
   */
  | {
      type: 'EXPORT_PROGRESS';
      /** Stable identifier for this export operation. */
      operationId: string;
      /** Current phase of the export pipeline (e.g. `'querying'`, `'serializing'`, `'compressing'`). */
      phase: string;
      /** Records exported so far. */
      completed: number;
      /** Total records to export (undefined if not yet determined). */
      total?: number | undefined;
      /** Completion percentage 0–100 (undefined if total unknown). */
      percent?: number | undefined;
      /** Optional human-readable status message (e.g. estimated time remaining). */
      message?: string | undefined;
    };

/** All task event type literals as a union. */
export type TaskEventType = TaskEvent['type'];
