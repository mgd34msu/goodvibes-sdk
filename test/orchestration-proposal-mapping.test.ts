/**
 * BIG-3 item 1 — PlanProposal → CreateWorkstreamInput assembly
 * (proposal-workstream.ts fromPlanProposal). Proves the honest mapping: one
 * work item per proposal item (title + brief → title/task), the SAME
 * engineer→review phase template fromChainSpec uses (parameterized by
 * capacity), dependencies carried through as item ids, workstream-level
 * provenance, and the assemble-time cycle/dangling assertions.
 */
import { describe, expect, test } from 'bun:test';
import { fromPlanProposal } from '../packages/sdk/src/platform/orchestration/proposal-workstream.js';
import { fromChainSpec, engineerReviewPhases } from '../packages/sdk/src/platform/orchestration/controller-compat.js';
import type { PlanProposal, WorkItem as ProposalWorkItem } from '../packages/sdk/src/platform/core/plan-proposal.js';
import { makeFakeConfigManager } from './_helpers/orchestration-harness.js';

function proposalItem(overrides: Partial<ProposalWorkItem> & { id: string; title: string; brief: string }): ProposalWorkItem {
  return {
    phaseId: 'phase-exec',
    dependsOn: [],
    ...overrides,
  };
}

function makeProposal(items: ProposalWorkItem[], overrides: Partial<PlanProposal> = {}): PlanProposal {
  return {
    id: 'prop-1',
    task: 'Build the thing',
    strategy: 'parallel',
    rationale: 'because',
    phases: [{ id: 'phase-exec', title: 'Execute', order: 1 }],
    workItems: items,
    createdAt: 1,
    source: 'planner-agent',
    ...overrides,
  };
}

const cfg = makeFakeConfigManager();

describe('fromPlanProposal — item mapping', () => {
  test('one work item per proposal item; title + brief become title + task', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'Item A', brief: 'do A carefully' }),
      proposalItem({ id: 'b', title: 'Item B', brief: 'do B next' }),
    ]);
    const spec = fromPlanProposal(proposal, cfg);
    expect(spec.items).toHaveLength(2);
    expect(spec.items[0]).toMatchObject({ id: 'a', title: 'Item A', task: 'do A carefully' });
    expect(spec.items[1]).toMatchObject({ id: 'b', title: 'Item B', task: 'do B next' });
    expect(spec.title).toBe('Build the thing');
  });

  test('uses the SAME engineer→review phase template as fromChainSpec, parameterized only by capacity', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b' }),
      proposalItem({ id: 'c', title: 'C', brief: 'c' }),
    ]);
    const spec = fromPlanProposal(proposal, cfg);
    // Default capacity = item count (3), so independent items run concurrently.
    expect(spec.phases).toEqual(engineerReviewPhases('scoped', 3));
    // fromChainSpec is the same template at capacity 1 — the only difference.
    const chain = fromChainSpec({ id: 'x', task: 't' }, cfg);
    expect(chain.phases).toEqual(engineerReviewPhases('scoped', 1));
    expect(spec.phases.map((p) => p.kind)).toEqual(chain.phases.map((p) => p.kind));
    expect(spec.phases.map((p) => p.role)).toEqual(chain.phases.map((p) => p.role));
  });

  test('opts.capacity caps concurrency (clamped to >= 1)', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b' }),
    ]);
    expect(fromPlanProposal(proposal, cfg, { capacity: 1 }).phases[0]!.capacity).toBe(1);
    expect(fromPlanProposal(proposal, cfg, { capacity: 0 }).phases[0]!.capacity).toBe(1);
  });

  test('dependencies carry through as item ids (B dependsOn A)', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'c' }),
    ]);
    const spec = fromPlanProposal(proposal, cfg);
    const b = spec.items.find((i) => i.id === 'b')!;
    const a = spec.items.find((i) => i.id === 'a')!;
    const c = spec.items.find((i) => i.id === 'c')!;
    expect(b.dependsOn).toEqual(['a']);
    // Independent items omit dependsOn entirely (no empty-array noise).
    expect(a.dependsOn).toBeUndefined();
    expect(c.dependsOn).toBeUndefined();
  });
});

describe('fromPlanProposal — provenance', () => {
  test('carries decomposedBy/proposalId/strategy/cost/elapsed', () => {
    const proposal = makeProposal(
      [proposalItem({ id: 'a', title: 'A', brief: 'a' })],
      { decomposedBy: 'agent', agentCostUsd: 0.42, elapsedMs: 1234 },
    );
    const spec = fromPlanProposal(proposal, cfg);
    expect(spec.provenance).toEqual({
      decomposedBy: 'agent',
      proposalId: 'prop-1',
      strategy: 'parallel',
      agentCostUsd: 0.42,
      elapsedMs: 1234,
    });
  });

  test('omits absent optional provenance fields (heuristic, no cost)', () => {
    const proposal = makeProposal([proposalItem({ id: 'a', title: 'A', brief: 'a' })], { decomposedBy: 'heuristic' });
    const spec = fromPlanProposal(proposal, cfg);
    expect(spec.provenance).toEqual({ decomposedBy: 'heuristic', proposalId: 'prop-1', strategy: 'parallel' });
  });
});

describe('fromPlanProposal — assemble-time assertions (BIG-3 item 2)', () => {
  test('throws on a dangling dependency id', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['nonexistent'] }),
    ]);
    expect(() => fromPlanProposal(proposal, cfg)).toThrow(/unknown item id "nonexistent"/);
  });

  test('throws on a dependency cycle', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a', dependsOn: ['b'] }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
    ]);
    expect(() => fromPlanProposal(proposal, cfg)).toThrow(/cycle detected/);
  });

  test('throws on a self-dependency (degenerate cycle)', () => {
    const proposal = makeProposal([proposalItem({ id: 'a', title: 'A', brief: 'a', dependsOn: ['a'] })]);
    expect(() => fromPlanProposal(proposal, cfg)).toThrow(/cycle detected/);
  });

  test('accepts a valid diamond (D deps B,C; B,C dep A)', () => {
    const proposal = makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'a' }),
      proposalItem({ id: 'b', title: 'B', brief: 'b', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'c', dependsOn: ['a'] }),
      proposalItem({ id: 'd', title: 'D', brief: 'd', dependsOn: ['b', 'c'] }),
    ]);
    expect(() => fromPlanProposal(proposal, cfg)).not.toThrow();
    const spec = fromPlanProposal(proposal, cfg);
    expect(spec.items.find((i) => i.id === 'd')!.dependsOn).toEqual(['b', 'c']);
  });
});
