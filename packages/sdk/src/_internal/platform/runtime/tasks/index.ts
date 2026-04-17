/**
 * Runtime Tasks — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createTaskManager } from './tasks/index.js';
 *
 * const taskManager = createTaskManager(store, bus, sessionId);
 * const task = taskManager.createTask({ kind: 'exec', title: 'Run lint', owner: 'exec-tool' });
 * taskManager.startTask(task.id);
 * taskManager.completeTask(task.id);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  TaskManager,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCancelParams,
  TaskFailParams,
} from './types.js';

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export {
  canTransition,
  getValidTransitions,
  isTerminalStatus,
} from './lifecycle.js';

// ── Registry ──────────────────────────────────────────────────────────────────
export { TaskRegistry } from './registry.js';

// ── Manager ───────────────────────────────────────────────────────────────────
export {
  UnifiedTaskManager,
  TaskTransitionError,
  TaskNotFoundError,
  TaskNotCancellableError,
} from './manager.js';

// ── Factory ───────────────────────────────────────────────────────────────────
import type { RuntimeStore } from '../store/index.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { TaskManager } from './types.js';
import { UnifiedTaskManager } from './manager.js';

/**
 * Creates a fully initialized UnifiedTaskManager bound to the given
 * Zustand store, RuntimeEventBus, and session identifier.
 *
 * @param store - The runtime Zustand store.
 * @param bus - The RuntimeEventBus for event emission.
 * @param sessionId - Current session identifier (used in emitter context).
 * @returns A TaskManager instance ready for use.
 *
 * @example
 * ```ts
 * const taskManager = createTaskManager(store, bus, sessionId);
 * ```
 */
export function createTaskManager(
  store: RuntimeStore,
  bus: RuntimeEventBus,
  sessionId: string
): TaskManager {
  return new UnifiedTaskManager(store, bus, sessionId);
}
