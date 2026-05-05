import { describe, expect, test } from 'bun:test';
import { createDomainDispatch, createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { SchedulerTaskAdapter } from '../packages/sdk/src/platform/runtime/tasks/adapters/scheduler-adapter.js';
import type { ScheduledTask, TaskRunRecord } from '../packages/sdk/src/platform/scheduler/scheduler.js';

describe('runtime store lifecycle seams', () => {
  test('task events do not synthesize records or double-count terminal state', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'missing-task', durationMs: 1 });
    expect(store.getState().tasks.tasks.has('missing-task')).toBe(false);
    expect(store.getState().tasks.totalCompleted).toBe(0);

    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 'task-1', description: 'Run build', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 'task-1', description: 'Run build again', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 'task-1' });
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'task-1', durationMs: 12 });
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'task-1', durationMs: 24 });
    dispatch.dispatchTaskEvent({ type: 'TASK_FAILED', taskId: 'task-1', error: 'late failure', durationMs: 30 });

    const tasks = store.getState().tasks;
    expect(tasks.totalCreated).toBe(1);
    expect(tasks.totalCompleted).toBe(1);
    expect(tasks.totalFailed).toBe(0);
    expect(tasks.tasks.get('task-1')?.status).toBe('completed');
  });

  test('agent events do not synthesize records or double-count terminal state', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'missing-agent', durationMs: 1 });
    expect(store.getState().agents.agents.has('missing-agent')).toBe(false);
    expect(store.getState().agents.totalCompleted).toBe(0);

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Inspect state' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Inspect state again' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'agent-1' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 12 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 24 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'agent-1', error: 'late failure', durationMs: 30 });

    const agents = store.getState().agents;
    expect(agents.totalSpawned).toBe(1);
    expect(agents.totalCompleted).toBe(1);
    expect(agents.totalFailed).toBe(0);
    expect(agents.agents.get('agent-1')?.status).toBe('completed');
  });

  test('scheduler adapter preserves failed run status when wrapping history', () => {
    const store = createRuntimeStore();
    const adapter = new SchedulerTaskAdapter(store);
    const run: TaskRunRecord = {
      taskId: 'scheduled-1',
      agentId: 'run-agent-1',
      startedAt: Date.now(),
      status: 'failed',
      error: 'scheduled job failed',
    };
    const scheduledTask: ScheduledTask = {
      id: 'scheduled-1',
      name: 'Nightly check',
      cron: '0 0 * * *',
      prompt: 'Check runtime state',
      enabled: true,
      runCount: 1,
      missedRuns: 0,
      createdAt: Date.now(),
    };

    const taskId = adapter.wrapScheduledRun(run, scheduledTask);
    const task = store.getState().tasks.tasks.get(taskId);

    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('scheduled job failed');
    expect(store.getState().tasks.totalFailed).toBe(1);
  });
});
