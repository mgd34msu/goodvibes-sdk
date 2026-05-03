/**
 * router-e2e-tasks.test.ts
 *
 * Router-level E2E tests for the task route family.
 * Exercises dispatchTaskRoutes which handles:
 *   POST /task               → postTask
 *   GET  /task               → returns null (explicit pass-through)
 *   GET  /api/tasks          → getIntegrationTasks
 *   GET  /api/tasks/:id      → getRuntimeTask
 *   POST /api/tasks/:id/(cancel|retry)  → runtimeTaskAction
 *   GET  /task/:id           → getTaskStatus
 *
 * Uses dispatchTaskRoutes directly with makeDefaultDaemonHandlerStub.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchTaskRoutes } from '../packages/daemon-sdk/src/tasks.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';
import { makeRequest } from './_helpers/router-requests.js';

// ---------------------------------------------------------------------------
// describe: task routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e tasks — POST /task (happy path)', () => {
  test('POST /task delegates to postTask and returns response', async () => {
    let handlerCalled = false;
    const handlers = makeDefaultDaemonHandlerStub({
      postTask: async (_req) => {
        handlerCalled = true;
        return Response.json({ taskId: 'task-123' }, { status: 200 });
      },
    });
    const req = makeRequest('POST', 'http://localhost/task', { prompt: 'do something' });
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.taskId).toBe('task-123');
    expect(handlerCalled).toBe(true);
  });

  test('GET /api/tasks returns integration task list', async () => {
    const handlers = makeDefaultDaemonHandlerStub({
      getIntegrationTasks: () => Response.json({ tasks: [{ id: 'task-1', status: 'pending' }] }),
    });
    const req = makeRequest('GET', 'http://localhost/api/tasks');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { tasks: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(1);
  });

  test('GET /api/tasks/:id retrieves specific runtime task', async () => {
    let capturedId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      getRuntimeTask: (taskId) => {
        capturedId = taskId;
        return Response.json({ id: taskId, status: 'running' });
      },
    });
    const req = makeRequest('GET', 'http://localhost/api/tasks/task-abc');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.id).toBe('task-abc');
    expect(capturedId).toBe('task-abc');
  });

  test('POST /api/tasks/:id/cancel delegates runtimeTaskAction with cancel', async () => {
    let capturedAction: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      runtimeTaskAction: (taskId, action, _req) => {
        capturedAction = action;
        return Response.json({ ok: true, taskId, action });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/tasks/task-42/cancel');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedAction).toBe('cancel');
  });

  test('POST /api/tasks/:id/retry delegates runtimeTaskAction with retry', async () => {
    let capturedAction: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      runtimeTaskAction: (taskId, action, _req) => {
        capturedAction = action;
        return Response.json({ ok: true, taskId, action });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/tasks/task-42/retry');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedAction).toBe('retry');
  });

  test('GET /task/:id retrieves task status', async () => {
    let capturedId: string | null = null;
    const handlers = makeDefaultDaemonHandlerStub({
      getTaskStatus: (taskId) => {
        capturedId = taskId;
        return Response.json({ id: taskId, status: 'completed' });
      },
    });
    const req = makeRequest('GET', 'http://localhost/task/task-xyz');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.status).toBe('completed');
    expect(capturedId).toBe('task-xyz');
  });
});

// ---------------------------------------------------------------------------
// describe: task routes — failure paths
// ---------------------------------------------------------------------------

describe('router-e2e tasks — failure paths', () => {
  test('returns null for GET /task (explicit pass-through in dispatcher)', async () => {
    // The dispatcher has an explicit `return null` for GET /task
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/task');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for unmatched route', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('GET', 'http://localhost/api/no-such-task-route');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('returns null for DELETE /api/tasks/:id (method not registered)', async () => {
    const handlers = makeDefaultDaemonHandlerStub();
    const req = makeRequest('DELETE', 'http://localhost/api/tasks/task-1');
    const res = await dispatchTaskRoutes(req, handlers);
    expect(res).toBeNull();
  });
});
