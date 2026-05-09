import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ProjectPlanningService,
  type ProjectWorkPlanSnapshot,
  projectKnowledgeSpaceId,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning service', () => {
  test('stores planning artifacts in isolated project knowledge spaces', async () => {
    const service = createService();
    await service.upsertState({
      projectId: 'alpha',
      state: {
        goal: 'Add conversational planning support',
        scope: 'SDK contracts only',
        tasks: [{
          id: 'contracts',
          title: 'Add passive planning contracts',
          verification: ['bun test test/project-planning-service.test.ts'],
        }],
        verificationGates: [{
          id: 'unit-tests',
          description: 'Project planning tests pass',
          required: true,
        }],
        executionApproved: true,
      },
    });
    await service.recordDecision({
      projectId: 'alpha',
      decision: {
        title: 'Planning loop remains TUI-owned',
        decision: 'The daemon stores/evaluates planning artifacts but never drives the interview.',
        reasoning: 'Programmatic surfaces should not enter conversational planning loops.',
      },
    });
    await service.upsertLanguage({
      projectId: 'alpha',
      language: {
        terms: [{
          term: 'Surface',
          definition: 'A user-facing channel where GoodVibes receives or sends interaction.',
          avoid: ['client'],
        }],
        ambiguities: [{
          phrase: 'agent channel',
          resolution: 'Split into chat and background agent routes.',
        }],
      },
    });

    const alpha = await service.getState({ projectId: 'alpha' });
    const beta = await service.getState({ projectId: 'beta' });
    const status = await service.status({ projectId: 'alpha' });
    const decisions = await service.listDecisions({ projectId: 'alpha' });
    const language = await service.getLanguage({ projectId: 'alpha' });

    expect(alpha.knowledgeSpaceId).toBe(projectKnowledgeSpaceId('alpha'));
    expect(alpha.state?.readiness).toBe('executable');
    expect(beta.state).toBeNull();
    expect(status.counts).toEqual({ states: 1, decisions: 1, languageArtifacts: 1, workPlans: 1, workPlanTasks: 1 });
    expect(status.passiveOnly).toBe(true);
    expect(decisions.decisions[0]?.title).toBe('Planning loop remains TUI-owned');
    expect(language.language?.terms[0]?.term).toBe('Surface');
    const workPlan = await service.getWorkPlanSnapshot({ projectId: 'alpha' });
    expect(workPlan.tasks[0]?.source).toBe('planning');
    expect(workPlan.tasks[0]?.metadata?.planningTaskId).toBe('contracts');
  });

  test('evaluates gaps and next questions without mutating stored state', async () => {
    const service = createService();
    const evaluation = await service.evaluate({
      projectId: 'alpha',
      state: {
        goal: 'Improve setup',
      },
    });
    const status = await service.status({ projectId: 'alpha' });

    expect(evaluation.readiness).toBe('needs-user-input');
    expect(evaluation.gaps.map((gap) => gap.kind)).toContain('missing-scope');
    expect(evaluation.gaps.map((gap) => gap.kind)).toContain('ambiguous-language');
    expect(evaluation.nextQuestion?.prompt).toContain('scope');
    expect(status.counts.states).toBe(0);
  });

  test('stores durable work-plan tasks and emits task deltas plus snapshot invalidations', async () => {
    const bus = new RuntimeEventBus();
    const service = createService(bus);
    const events: string[] = [];
    const snapshots: ProjectWorkPlanSnapshot[] = [];
    const unsubscribeCreated = bus.on('WORK_PLAN_TASK_CREATED', ({ payload }) => {
      events.push(`${payload.type}:${payload.task.title}`);
    });
    const unsubscribeStatus = bus.on('WORK_PLAN_TASK_STATUS_CHANGED', ({ payload }) => {
      events.push(`${payload.type}:${payload.previousStatus}->${payload.status}`);
    });
    const unsubscribeSnapshot = bus.on('WORK_PLAN_SNAPSHOT_INVALIDATED', ({ payload }) => {
      snapshots.push(payload.snapshot as ProjectWorkPlanSnapshot);
    });

    const created = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: {
        title: 'Build shared work-plan primitive',
        owner: 'sdk',
        priority: 10,
        source: 'wrfc',
        chainId: 'chain-1',
        phaseId: 'engineer',
        agentId: 'agent-1',
        linkedArtifactIds: ['artifact-1'],
        linkedSourceIds: ['source-1'],
        linkedNodeIds: ['node-1'],
        originSurface: 'tui',
        tags: ['wrfc', 'planning'],
      },
    });
    const started = await service.setWorkPlanTaskStatus({
      projectId: 'alpha',
      taskId: created.task!.taskId,
      status: 'in_progress',
      reason: 'Engineer started',
    });
    const listed = await service.getWorkPlanSnapshot({ projectId: 'alpha', chainId: 'chain-1' });
    const beta = await service.getWorkPlanSnapshot({ projectId: 'beta' });
    const status = await service.status({ projectId: 'alpha' });

    unsubscribeCreated();
    unsubscribeStatus();
    unsubscribeSnapshot();

    expect(created.snapshot.counts.pending).toBe(1);
    expect(started.task?.status).toBe('in_progress');
    expect(started.task?.metadata?.statusReason).toBe('Engineer started');
    expect(listed.tasks[0]?.linkedNodeIds).toEqual(['node-1']);
    expect(beta.tasks).toEqual([]);
    expect(status.counts.workPlans).toBe(1);
    expect(status.counts.workPlanTasks).toBe(1);
    expect(events).toContain('WORK_PLAN_TASK_CREATED:Build shared work-plan primitive');
    expect(events).toContain('WORK_PLAN_TASK_STATUS_CHANGED:pending->in_progress');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  test('reorders and clears work-plan tasks with durable counts', async () => {
    const service = createService();
    const first = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: { title: 'First task' },
    });
    const second = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: { title: 'Second task' },
    });

    const reordered = await service.reorderWorkPlanTasks({
      projectId: 'alpha',
      orderedTaskIds: [second.task!.taskId, first.task!.taskId],
    });
    expect(reordered.tasks.map((task) => task.title)).toEqual(['Second task', 'First task']);

    await service.setWorkPlanTaskStatus({
      projectId: 'alpha',
      taskId: second.task!.taskId,
      status: 'done',
    });
    const cleared = await service.clearCompletedWorkPlanTasks({ projectId: 'alpha' });
    expect(cleared.clearedTaskIds).toEqual([second.task!.taskId]);
    expect(cleared.snapshot.counts.total).toBe(1);
    expect(cleared.snapshot.tasks[0]?.title).toBe('First task');
  });
});

function createService(runtimeBus?: RuntimeEventBus): ProjectPlanningService {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  return new ProjectPlanningService(store, { defaultProjectId: 'default-project', runtimeBus });
}
