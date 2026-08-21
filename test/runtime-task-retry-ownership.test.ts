/**
 * runtime-task-retry-ownership.test.ts
 *
 * POST /api/tasks/:id/retry spawns a NEW agent for the task, but the task
 * record's `owner` used to keep naming the previous, already-terminal agent.
 * The reducer merges the transition patch over the existing record, so nothing
 * downstream repaired it, and POST /api/tasks/:id/cancel reads exactly that
 * field: the operator got a 200 with the task marked cancelled while
 * AgentManager.cancel() no-oped on a dead id and the retried agent kept
 * running.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonRuntimeSessionRouteHandlers } from '../packages/daemon-sdk/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../packages/daemon-sdk/src/runtime-route-types.js';

interface TaskRecord {
  readonly kind: string;
  readonly owner: string;
  readonly status: string;
  readonly description?: string;
  readonly [key: string]: unknown;
}

interface Harness {
  readonly handlers: ReturnType<typeof createDaemonRuntimeSessionRouteHandlers>;
  readonly tasks: Map<string, TaskRecord>;
  readonly cancelled: string[];
  readonly spawned: string[];
}

function makeHarness(taskId: string, initial: TaskRecord): Harness {
  const tasks = new Map<string, TaskRecord>([[taskId, initial]]);
  const cancelled: string[] = [];
  const spawned: string[] = [];
  let nextAgent = 0;

  const context = {
    parseJsonBody: async () => ({}),
    parseOptionalJsonBody: async () => null,
    recordApiResponse: (_req: unknown, _path: unknown, response: Response) => response,
    requireAdmin: () => null,
    agentManager: {
      getStatus: () => null,
      // Mirrors AgentManager.cancel: unknown/terminal ids are a silent no-op.
      cancel: (id: string) => { cancelled.push(id); return false; },
    },
    trySpawnAgent: () => {
      nextAgent += 1;
      const id = `agent-spawned-${nextAgent}`;
      spawned.push(id);
      return { id, status: 'running', task: 'retried', tools: [], startedAt: Date.now() };
    },
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: { getState: () => ({ tasks: { tasks } }) },
    runtimeDispatch: {
      // Same merge shape as the real reducer (transitionTaskDomainRecord).
      transitionRuntimeTask: (id: string, status: string, patch: Record<string, unknown>) => {
        const existing = tasks.get(id);
        if (!existing) return;
        tasks.set(id, { ...existing, ...patch, status } as TaskRecord);
      },
    },
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('stream', { status: 200 }),
  } as unknown as DaemonRuntimeRouteContext;

  return { handlers: createDaemonRuntimeSessionRouteHandlers(context), tasks, cancelled, spawned };
}

function actionRequest(taskId: string, action: string): Request {
  return new Request(`http://localhost/api/tasks/${taskId}/${action}`, { method: 'POST' });
}

describe('retrying a runtime task moves ownership to the agent that is actually running', () => {
  test('cancel after retry reaches the retried agent, not the dead one', async () => {
    const taskId = 'task-1';
    const harness = makeHarness(taskId, {
      kind: 'agent',
      owner: 'agent-dead',
      status: 'failed',
      description: 'do the thing',
      error: 'boom',
      endedAt: 1,
    });

    const retry = await harness.handlers.runtimeTaskAction(taskId, 'retry', actionRequest(taskId, 'retry'));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { agentId: string; retried: boolean };
    expect(retryBody.retried).toBe(true);
    expect(harness.spawned).toEqual([retryBody.agentId]);

    // Before the fix the record still said 'agent-dead' here.
    expect(harness.tasks.get(taskId)?.owner).toBe(retryBody.agentId);
    expect(harness.tasks.get(taskId)?.status).toBe('queued');
    expect(harness.tasks.get(taskId)?.error).toBeUndefined();

    const cancel = await harness.handlers.runtimeTaskAction(taskId, 'cancel', actionRequest(taskId, 'cancel'));
    expect(cancel.status).toBe(200);
    expect(harness.cancelled).toEqual([retryBody.agentId]);
    expect(harness.tasks.get(taskId)?.status).toBe('cancelled');
  });

  test('cancel without a retry still targets the original owner', async () => {
    const taskId = 'task-2';
    const harness = makeHarness(taskId, { kind: 'agent', owner: 'agent-original', status: 'running' });

    const cancel = await harness.handlers.runtimeTaskAction(taskId, 'cancel', actionRequest(taskId, 'cancel'));
    expect(cancel.status).toBe(200);
    expect(harness.cancelled).toEqual(['agent-original']);
  });
});
