import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';
import { ExecutionPlanManager } from '../packages/sdk/src/platform/core/execution-plan.js';
import {
  assemblePlanProposal,
  planProposalToPlanningState,
  singleItemProposal,
  type RawDecomposition,
} from '../packages/sdk/src/platform/core/plan-proposal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTmpProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-proposal-test-'));
  tmpRoots.push(root);
  return root;
}

describe('singleItemProposal', () => {
  test('produces one phase, one item, brief==task, honest-fallback source, no deps', () => {
    const proposal = singleItemProposal('Fix the flaky auth test');

    expect(proposal.phases).toHaveLength(1);
    expect(proposal.phases[0]!.title).toBe('Execute');
    expect(proposal.workItems).toHaveLength(1);
    const item = proposal.workItems[0]!;
    expect(item.title).toBe('Fix the flaky auth test');
    expect(item.brief).toBe('Fix the flaky auth test');
    expect(item.dependsOn).toEqual([]);
    expect(item.phaseId).toBe(proposal.phases[0]!.id);
    expect(proposal.source).toBe('single-item-fallback');
    expect(proposal.strategy).toBe('single');
  });
});

describe('assemblePlanProposal — happy path', () => {
  function fixture(): RawDecomposition {
    return {
      phases: [
        { title: 'Setup' },
        { title: 'Implementation', description: 'Do the work' },
        { title: 'Verification' },
      ],
      workItems: [
        { title: 'Scaffold module', brief: 'Create the file skeleton', phase: 'Setup' },
        {
          title: 'Implement feature',
          brief: 'Write the logic',
          phase: 'Implementation',
          dependsOn: ['Scaffold module'],
        },
        {
          title: 'Write tests',
          brief: 'Cover the feature',
          phase: 'Verification',
          dependsOn: ['implement feature'], // case-insensitive match
        },
      ],
    };
  }

  test('assembles N phases / M items, order stable, source planner-agent', () => {
    const { proposal, issues } = assemblePlanProposal('Ship the feature', 'cohort', fixture());

    expect(issues).toEqual([]);
    expect(proposal.source).toBe('planner-agent');
    expect(proposal.strategy).toBe('cohort');
    expect(proposal.task).toBe('Ship the feature');
    expect(proposal.phases.map((p) => p.title)).toEqual(['Setup', 'Implementation', 'Verification']);
    expect(proposal.phases.map((p) => p.order)).toEqual([0, 1, 2]);
    expect(proposal.workItems).toHaveLength(3);
  });

  test('dependsOn resolves by title (case-insensitive) to real ids', () => {
    const { proposal, issues } = assemblePlanProposal('Ship the feature', 'cohort', fixture());
    expect(issues).toEqual([]);

    const scaffold = proposal.workItems.find((i) => i.title === 'Scaffold module')!;
    const implement = proposal.workItems.find((i) => i.title === 'Implement feature')!;
    const tests = proposal.workItems.find((i) => i.title === 'Write tests')!;

    expect(implement.dependsOn).toEqual([scaffold.id]);
    expect(tests.dependsOn).toEqual([implement.id]); // resolved despite case mismatch
  });

  test('work items land in the correct phase by phaseId', () => {
    const { proposal } = assemblePlanProposal('Ship the feature', 'cohort', fixture());
    const setupPhase = proposal.phases.find((p) => p.title === 'Setup')!;
    const scaffold = proposal.workItems.find((i) => i.title === 'Scaffold module')!;
    expect(scaffold.phaseId).toBe(setupPhase.id);
  });
});

describe('assemblePlanProposal — dependency resolution parity with ExecutionPlanManager.replaceItems', () => {
  // Same three resolution rules, exercised against structurally equivalent
  // fixtures: UUID passthrough, case-insensitive title/description lookup,
  // drop-unresolved. Never throws either way.
  const REAL_UUID = '11111111-2222-4333-8444-555555555555';

  test('assemblePlanProposal: UUID passthrough + title lookup + drop-unresolved', () => {
    const raw: RawDecomposition = {
      phases: [{ title: 'Only phase' }],
      workItems: [
        { title: 'Alpha', brief: 'a', phase: 'Only phase' },
        {
          title: 'Beta',
          brief: 'b',
          phase: 'Only phase',
          dependsOn: ['Alpha', REAL_UUID, 'Does Not Exist'],
        },
      ],
    };
    const { proposal, issues } = assemblePlanProposal('t', 'cohort', raw);
    const alpha = proposal.workItems.find((i) => i.title === 'Alpha')!;
    const beta = proposal.workItems.find((i) => i.title === 'Beta')!;

    // UUID passed through unchecked, title resolved to alpha's real id,
    // unresolved title dropped.
    expect(beta.dependsOn).toEqual([alpha.id, REAL_UUID]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe('dangling-dependency');
  });

  test('ExecutionPlanManager.replaceItems: identical rule set on an analogous fixture', () => {
    const manager = new ExecutionPlanManager(createTmpProjectRoot());
    const plan = manager.create('t', [
      { phase: 'Only phase', description: 'Alpha' },
      { phase: 'Only phase', description: 'Beta' },
    ]);
    manager.replaceItems(plan.id, [
      { phase: 'Only phase', description: 'Alpha' },
      {
        phase: 'Only phase',
        description: 'Beta',
        dependencies: ['Alpha', REAL_UUID, 'Does Not Exist'],
      },
    ]);
    const reloaded = manager.load(plan.id)!;
    const alpha = reloaded.items.find((i) => i.description === 'Alpha')!;
    const beta = reloaded.items.find((i) => i.description === 'Beta')!;

    // Identical resolution outcome shape to assemblePlanProposal above:
    // real id + UUID passthrough, unresolved dropped silently (replaceItems
    // has no issues channel, but the drop behavior matches).
    expect(beta.dependencies).toEqual([alpha.id, REAL_UUID]);
  });
});

describe('assemblePlanProposal — honest partials', () => {
  test('dangling dependency: issue emitted, item still produced, never throws', () => {
    const raw: RawDecomposition = {
      phases: [{ title: 'P1' }],
      workItems: [
        { title: 'Only item', brief: 'b', phase: 'P1', dependsOn: ['Ghost task'] },
      ],
    };
    let result: ReturnType<typeof assemblePlanProposal> | undefined;
    expect(() => {
      result = assemblePlanProposal('t', 'single', raw);
    }).not.toThrow();
    expect(result!.proposal.workItems).toHaveLength(1);
    expect(result!.proposal.workItems[0]!.dependsOn).toEqual([]);
    expect(result!.issues).toEqual([
      expect.objectContaining({ kind: 'dangling-dependency', workItemTitle: 'Only item' }),
    ]);
  });

  test('dependency cycle: issue emitted for every cyclic item, no infinite loop', () => {
    const raw: RawDecomposition = {
      phases: [{ title: 'P1' }],
      workItems: [
        { title: 'A', brief: 'a', phase: 'P1', dependsOn: ['B'] },
        { title: 'B', brief: 'b', phase: 'P1', dependsOn: ['C'] },
        { title: 'C', brief: 'c', phase: 'P1', dependsOn: ['A'] },
      ],
    };
    let result: ReturnType<typeof assemblePlanProposal> | undefined;
    expect(() => {
      result = assemblePlanProposal('t', 'cohort', raw);
    }).not.toThrow();
    const cycleIssues = result!.issues.filter((i) => i.kind === 'dependency-cycle');
    expect(cycleIssues.map((i) => i.workItemTitle).sort()).toEqual(['A', 'B', 'C']);
    // The graph itself is left intact (edges not silently removed).
    expect(result!.proposal.workItems.every((i) => i.dependsOn.length === 1)).toBe(true);
  });

  test('unresolved phase reference: item placed in synthesized "Unphased" bucket with an issue', () => {
    const raw: RawDecomposition = {
      phases: [{ title: 'Real phase' }],
      workItems: [
        { title: 'Orphan', brief: 'o', phase: 'Nonexistent phase' },
      ],
    };
    const { proposal, issues } = assemblePlanProposal('t', 'single', raw);
    const unphased = proposal.phases.find((p) => p.title === 'Unphased');
    expect(unphased).toBeDefined();
    expect(proposal.workItems[0]!.phaseId).toBe(unphased!.id);
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'unresolved-phase', workItemTitle: 'Orphan' }),
    ]);
  });
});

describe('planProposalToPlanningState', () => {
  test('maps phases+workItems -> tasks, dependsOn -> dependencies, executionApproved:false', () => {
    const raw: RawDecomposition = {
      phases: [{ title: 'Setup' }, { title: 'Build' }],
      workItems: [
        {
          title: 'Prep',
          brief: 'Get ready',
          phase: 'Setup',
          likelyFiles: ['src/a.ts'],
          verification: ['bun test'],
          canRunConcurrently: true,
          needsReview: false,
          suggestedArchetype: 'engineer',
        },
        { title: 'Build it', brief: 'Do the build', phase: 'Build', dependsOn: ['Prep'] },
      ],
    };
    const { proposal } = assemblePlanProposal('Ship it', 'cohort', raw);
    const state = planProposalToPlanningState(proposal);

    expect(state.goal).toBe('Ship it');
    expect(state.executionApproved).toBe(false);
    expect(state.tasks).toHaveLength(2);

    const prepTask = state.tasks!.find((t) => t.title === 'Prep')!;
    expect(prepTask.why).toBe('Get ready');
    expect(prepTask.likelyFiles).toEqual(['src/a.ts']);
    expect(prepTask.verification).toEqual(['bun test']);
    expect(prepTask.canRunConcurrently).toBe(true);
    expect(prepTask.needsReview).toBe(false);
    expect(prepTask.recommendedAgent).toBe('engineer');

    const buildTask = state.tasks!.find((t) => t.title === 'Build it')!;
    expect(buildTask.dependencies).toEqual([prepTask.id]);

    expect(state.dependencies).toEqual([{ fromTaskId: buildTask.id, toTaskId: prepTask.id }]);
  });
});

describe('reuse guard', () => {
  test('plan-proposal.ts does not re-implement markdown parsing or its own dependency scheduler', () => {
    const source = readFileSync(
      join(__dirname, '..', 'packages/sdk/src/platform/core/plan-proposal.ts'),
      'utf-8',
    );
    // No markdown-parsing re-implementation.
    expect(source).not.toMatch(/parseFromMarkdown|checkboxRe|phaseRe\s*=/);
    // No home-grown "next actionable items" scheduler — that stays
    // ExecutionPlanManager.getNextItems' job (exercised in
    // plan-integration.test.ts).
    expect(source).not.toMatch(/function\s+getNextItems|function\s+nextActionable|function\s+scheduleNext/);
    // No I/O, no LLM/agent spawn — the module stays pure.
    expect(source).not.toMatch(/readFileSync|writeFileSync|fetch\(|AgentManager|LLMProvider/);
  });
});
