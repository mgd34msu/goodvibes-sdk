import type { OpsApi } from './ops-api.js';
import type { OpsControlPlane } from './ops/control-plane.js';
import type { RuntimeTask } from './store/domains/tasks.js';
import type { UiTasksSnapshot } from './ui-read-models.js';
import type { TaskManager } from './tasks/types.js';

export interface RuntimeOpsApiOptions {
  readonly tasksReadModel: {
    getSnapshot(): UiTasksSnapshot;
  };
  readonly taskManager: TaskManager;
  readonly opsControlPlane?: Pick<
    OpsControlPlane,
    'cancelTask' | 'pauseTask' | 'resumeTask' | 'retryTask' | 'cancelAgent'
  >;
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.floor(limit));
}

function listTasksSnapshot(snapshot: UiTasksSnapshot, limit = 100): readonly RuntimeTask[] {
  return snapshot.tasks.slice(0, normalizeLimit(limit));
}

function getTaskSnapshot(snapshot: UiTasksSnapshot, taskId: string): RuntimeTask | null {
  return snapshot.tasks.find((task) => task.id === taskId) ?? null;
}

function requireControlPlane(
  controlPlane: RuntimeOpsApiOptions['opsControlPlane'],
): NonNullable<RuntimeOpsApiOptions['opsControlPlane']> {
  if (!controlPlane) {
    throw new Error('Ops control plane is not available in this runtime.');
  }
  return controlPlane;
}

export function createRuntimeOpsApi(options: RuntimeOpsApiOptions): OpsApi {
  return {
    tasks: {
      snapshot(): UiTasksSnapshot {
        return options.tasksReadModel.getSnapshot();
      },
      list(limit = 100): readonly RuntimeTask[] {
        return listTasksSnapshot(options.tasksReadModel.getSnapshot(), limit);
      },
      get(taskId: string): RuntimeTask | null {
        return getTaskSnapshot(options.tasksReadModel.getSnapshot(), taskId);
      },
      running(): readonly RuntimeTask[] {
        return options.tasksReadModel.getSnapshot().tasks.filter((task) => task.status === 'running');
      },
      create(input) {
        return options.taskManager.createTask(input);
      },
      update(taskId, input) {
        return options.taskManager.updateTask(taskId, input);
      },
      complete(taskId, result) {
        return options.taskManager.completeTask(taskId, result);
      },
      fail(taskId, input) {
        return options.taskManager.failTask(taskId, input);
      },
      cancel(taskId, note) {
        requireControlPlane(options.opsControlPlane).cancelTask(taskId, note);
      },
      pause(taskId, note) {
        requireControlPlane(options.opsControlPlane).pauseTask(taskId, note);
      },
      resume(taskId, note) {
        requireControlPlane(options.opsControlPlane).resumeTask(taskId, note);
      },
      retry(taskId, note) {
        requireControlPlane(options.opsControlPlane).retryTask(taskId, note);
      },
    },
    agents: {
      cancel(agentId, note) {
        requireControlPlane(options.opsControlPlane).cancelAgent(agentId, note);
      },
    },
  };
}
