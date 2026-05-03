import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { ProjectPlanningRoutes } from '../packages/sdk/src/platform/daemon/http/project-planning-routes.js';
import { ProjectPlanningService } from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning routes', () => {
  test('requires admin for writes and allows passive evaluation reads', async () => {
    const routes = createRoutes({ admin: false });
    const write = await routes.handle(jsonRequest('/api/projects/planning/state', {
      projectId: 'alpha',
      state: { goal: 'Add feature' },
    }));
    const evaluate = await routes.handle(jsonRequest('/api/projects/planning/evaluate', {
      projectId: 'alpha',
      state: { goal: 'Improve setup' },
    }));

    expect(write?.status).toBe(403);
    expect(evaluate?.status).toBe(200);
    const body = await evaluate!.json() as { readonly readiness: string; readonly gaps: readonly { readonly kind: string }[] };
    expect(body.readiness).toBe('needs-user-input');
    expect(body.gaps.some((gap) => gap.kind === 'ambiguous-language')).toBe(true);
  });

  test('persists state through the daemon route when admin is present', async () => {
    const routes = createRoutes({ admin: true });
    const saved = await routes.handle(jsonRequest('/api/projects/planning/state', {
      projectId: 'alpha',
      state: {
        goal: 'Add planning support',
        scope: 'SDK passive storage',
        tasks: [{ id: 'service', title: 'Build service', verification: ['unit tests'] }],
        verificationGates: [{ id: 'tests', description: 'Tests pass' }],
        executionApproved: true,
      },
    }));
    const loaded = await routes.handle(new Request('http://daemon.local/api/projects/planning/state?projectId=alpha'));

    expect(saved?.status).toBe(200);
    expect(loaded?.status).toBe(200);
    const body = await loaded!.json() as { readonly state: { readonly readiness: string; readonly goal: string } };
    expect(body.state.goal).toBe('Add planning support');
    expect(body.state.readiness).toBe('executable');
  });
});

function createRoutes(input: { readonly admin: boolean }): ProjectPlanningRoutes {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-routes-'));
  tmpRoots.push(root);
  const service = new ProjectPlanningService(
    new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }),
    { defaultProjectId: 'default-project' },
  );
  return new ProjectPlanningRoutes({
    projectPlanningService: service,
    parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
    parseOptionalJsonBody: async (req) => req.body ? await req.json() as Record<string, unknown> : null,
    requireAdmin: () => input.admin ? null : Response.json({ error: 'admin required' }, { status: 403 }),
  });
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://daemon.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

