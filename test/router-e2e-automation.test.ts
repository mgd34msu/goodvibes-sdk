/**
 * router-e2e-automation.test.ts
 *
 * Router-level E2E tests for the automation route family.
 * Exercises dispatchAutomationRoutes which handles:
 *   GET  /api/review
 *   GET  /api/automation/jobs
 *   POST /api/automation/jobs
 *   GET  /api/automation/runs
 *   GET  /api/automation/runs/:id
 *   POST /api/automation/runs/:id/(cancel|retry)
 *   PATCH/DELETE /api/automation/jobs/:id
 *   POST /api/automation/jobs/:id/(enable|disable|run)
 */

import { describe, expect, test } from 'bun:test';
import { dispatchAutomationRoutes } from '../packages/daemon-sdk/src/automation.js';
import type { DaemonApiRouteHandlers } from '../packages/daemon-sdk/src/context.js';
import { makeRequest } from './_helpers/router-requests.js';

function makeJob(id = 'job-1') {
  return {
    id,
    name: `Job ${id}`,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeRun(id = 'run-1', status: 'running' | 'completed' | 'failed' = 'completed') {
  return { id, status, jobId: 'job-1', createdAt: Date.now() };
}

/**
 * Minimal stub satisfying the Pick used by dispatchAutomationRoutes.
 */
function makeAutomationHandlers(
  overrides: Partial<DaemonApiRouteHandlers> = {},
): DaemonApiRouteHandlers {
  const defaults: Partial<DaemonApiRouteHandlers> = {
    getReview: () => Response.json({ review: { status: 'ok' } }),
    getIntegrationSession: () => Response.json({ session: null }),
    getIntegrationAutomation: () => Response.json({ automation: {} }),
    getAutomationJobs: () => Response.json({ jobs: [makeJob()] }),
    postAutomationJob: async (_req) => {
      return Response.json(makeJob('job-new'), { status: 201 });
    },
    getAutomationRuns: () => Response.json({ runs: [makeRun()] }),
    getAutomationRun: (runId) => {
      if (runId === 'run-1') return Response.json(makeRun('run-1'));
      return Response.json({ error: 'not found', code: 'NOT_FOUND' }, { status: 404 });
    },
    automationRunAction: (runId, action) =>
      Response.json({ ok: true, runId, action }),
    patchAutomationJob: (jobId, _req) =>
      Response.json({ ...makeJob(jobId), name: 'Updated Job' }),
    deleteAutomationJob: (jobId) =>
      Response.json({ ok: true, jobId }),
    setAutomationJobEnabled: (jobId, enabled) =>
      Response.json({ ok: true, jobId, enabled }),
    runAutomationJobNow: (jobId) =>
      Response.json({ ok: true, jobId }),
    getDeliveries: () => Response.json({ deliveries: [] }),
    getDelivery: (id) => Response.json({ id, status: 'delivered' }),
    getSchedules: () => Response.json({ schedules: [] }),
    postSchedule: async () => Response.json({ id: 'sched-1' }, { status: 201 }),
    deleteSchedule: (id) => Response.json({ ok: true, id }),
    setScheduleEnabled: (id, enabled) => Response.json({ ok: true, id, enabled }),
    runScheduleNow: (id) => Response.json({ ok: true, id }),
  };

  return { ...defaults, ...overrides } as DaemonApiRouteHandlers;
}

// ---------------------------------------------------------------------------
// describe: automation routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e automation — GET /api/automation/jobs (happy path)', () => {
  test('returns 200 with jobs array', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/jobs');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/automation/jobs creates a job and returns 201', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('POST', 'http://localhost/api/automation/jobs', {
      name: 'New Job',
      trigger: { type: 'every', interval: '1h' },
      task: 'do something',
    });
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.id).toBeDefined();
  });
});

describe('router-e2e automation — runs (happy path)', () => {
  test('GET /api/automation/runs returns run list', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
  });

  test('GET /api/automation/runs/:id retrieves specific run', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs/run-1');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.id).toBe('run-1');
  });

  test('POST /api/automation/runs/:id/cancel cancels the run', async () => {
    let capturedAction: string | null = null;
    const handlers = makeAutomationHandlers({
      automationRunAction: (runId, action) => {
        capturedAction = action;
        return Response.json({ ok: true, runId, action });
      },
    });
    const req = makeRequest('POST', 'http://localhost/api/automation/runs/run-1/cancel');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(capturedAction).toBe('cancel');
  });
});

// ---------------------------------------------------------------------------
// describe: automation routes — failure paths
// ---------------------------------------------------------------------------

describe('router-e2e automation — failure paths', () => {
  test('GET /api/automation/runs/:id returns 404 for unknown run', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/automation/runs/nonexistent-run');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('NOT_FOUND');
  });

  test('returns null for unmatched route', async () => {
    const handlers = makeAutomationHandlers();
    const req = makeRequest('GET', 'http://localhost/api/no-such-automation-route');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).toBeNull();
  });

  test('DELETE /api/automation/jobs/:id removes job', async () => {
    let capturedId: string | null = null;
    const handlers = makeAutomationHandlers({
      deleteAutomationJob: (jobId) => {
        capturedId = jobId;
        return Response.json({ ok: true, jobId });
      },
    });
    const req = makeRequest('DELETE', 'http://localhost/api/automation/jobs/job-abc');
    const res = await dispatchAutomationRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(capturedId).toBe('job-abc');
  });
});
