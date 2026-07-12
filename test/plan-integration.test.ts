import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ProjectPlanningService,
} from '../packages/sdk/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../packages/sdk/src/platform/knowledge/store.js';
import { ExecutionPlanManager } from '../packages/sdk/src/platform/core/execution-plan.js';
import {
  assemblePlanProposal,
  planProposalToExecutionPlanItems,
  planProposalToPlanningState,
  type RawDecomposition,
} from '../packages/sdk/src/platform/core/plan-proposal.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

function createPlanningService(): ProjectPlanningService {
  const root = createTmpRoot('plan-integration-');
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  return new ProjectPlanningService(store, { defaultProjectId: 'planning-project' });
}

function buildProposal() {
  const raw: RawDecomposition = {
    phases: [{ title: 'Design' }, { title: 'Build' }],
    workItems: [
      {
        title: 'Draft API contract',
        brief: 'Write the request/response shape for the rate limiter.',
        phase: 'Design',
        verification: ['Reviewed by a second engineer'],
      },
      {
        title: 'Implement handler',
        brief: 'Wire the rate limiter into the request pipeline.',
        phase: 'Build',
        dependsOn: ['Draft API contract'],
        verification: ['bun test test/rate-limit.test.ts'],
      },
    ],
  };
  const { proposal, issues } = assemblePlanProposal('Add rate limiting to the public API', 'cohort', raw);
  expect(issues).toEqual([]);
  return proposal;
}

describe('proposal -> planning-state approval seam (readiness gate)', () => {
  test('needs-user-input (unapproved) before approval, executable after — mirrors /plan approve', async () => {
    const service = createPlanningService();
    const projectId = 'planning-project';
    const proposal = buildProposal();
    const partialState = planProposalToPlanningState(proposal);

    await service.upsertState({ projectId, state: partialState });

    const evalBefore = await service.evaluate({ projectId });
    expect(evalBefore.readiness).toBe('needs-user-input');
    expect(evalBefore.gaps.map((g) => g.kind)).toEqual(['unapproved-execution']);

    // Mirrors the TUI's `/plan approve` (planning-runtime.ts): fetch current
    // state, flip executionApproved, upsert again.
    const current = await service.getState({ projectId });
    expect(current.state).not.toBeNull();
    await service.upsertState({
      projectId,
      state: { ...current.state!, executionApproved: true },
    });

    const evalAfter = await service.evaluate({ projectId });
    expect(evalAfter.gaps).toEqual([]);
    expect(evalAfter.readiness).toBe('executable');
  });
});

describe('proposal -> ExecutionPlanManager persistence (reuse, no duplicate scheduler)', () => {
  test('create + replaceItems resolves dependencies; getNextItems gates on them; updateItem unblocks downstream', () => {
    const proposal = buildProposal();
    const { title, items } = planProposalToExecutionPlanItems(proposal);

    const manager = new ExecutionPlanManager(createTmpRoot('plan-exec-'));
    const shell = manager.create(title, []);
    manager.replaceItems(shell.id, items);

    const populated = manager.load(shell.id)!;
    expect(populated.items).toHaveLength(2);

    // Only the dependency-free item is actionable first.
    const first = manager.getNextItems(populated);
    expect(first.map((i) => i.description)).toEqual(['Draft API contract']);

    manager.updateItem(shell.id, first[0]!.id, 'complete');
    const afterComplete = manager.load(shell.id)!;

    // Completing the prerequisite unblocks the dependent item.
    const second = manager.getNextItems(afterComplete);
    expect(second.map((i) => i.description)).toEqual(['Implement handler']);
  });
});
