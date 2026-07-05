/**
 * BIG-3 item 2 — inter-item dependency gating end-to-end through the engine.
 *
 * A 3-item plan (B dependsOn A, C independent) assembled via fromPlanProposal:
 *  - C and A run concurrently while B sits in 'blocked-dependency' with an
 *    honest 'waiting on: A' reason;
 *  - B claims only after A reaches 'passed'; all three pass.
 *  - A FAILS ⇒ B is blocked with 'dependency failed: A' (refuse-not-kill — B is
 *    NOT terminally failed), and retryItem(A) recovers: A re-runs, passes, B
 *    unblocks and passes.
 *  - Resume mid-flow preserves the dependency wait.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine } from '../packages/sdk/src/platform/orchestration/engine.js';
import { fromPlanProposal } from '../packages/sdk/src/platform/orchestration/proposal-workstream.js';
import type { OrchestrationEvent } from '../packages/sdk/src/platform/orchestration/types.js';
import type { PlanProposal, WorkItem as ProposalWorkItem } from '../packages/sdk/src/platform/core/plan-proposal.js';
import {
  createOrchestrationHarness,
  engineerReportOutput,
  reviewerReportOutput,
  flushMicrotasks,
  makeFakeConfigManager,
  type OrchestrationTestHarness,
} from './_helpers/orchestration-harness.js';

const cfg = makeFakeConfigManager();

function proposalItem(o: Partial<ProposalWorkItem> & { id: string; title: string; brief: string }): ProposalWorkItem {
  return { phaseId: 'p', dependsOn: [], ...o };
}

function makeProposal(items: ProposalWorkItem[]): PlanProposal {
  return {
    id: 'prop', task: 'goal', strategy: 'parallel', rationale: 'r',
    phases: [{ id: 'p', title: 'Execute', order: 1 }],
    workItems: items, createdAt: 1, source: 'planner-agent', decomposedBy: 'agent',
  };
}

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'orch-deps-')); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

function makeEngine(h: OrchestrationTestHarness) {
  return createOrchestrationEngine({
    agentManager: h.agentManager,
    configManager: cfg,
    runtimeBus: h.bus,
    projectRoot,
    createWorktree: () => h.worktree,
    persist: false,
    skipClaimVerification: true,
  });
}

/** The single running agent driving the given item's live phase. */
function runningAgentFor(h: OrchestrationTestHarness, itemId: string): string {
  for (const [id, rec] of h.agentStore) {
    if (rec.status === 'running' && (rec as { workItemId?: string }).workItemId === itemId) return id;
  }
  throw new Error(`no running agent for item ${itemId}`);
}

/** Drive an item through engineer→review to 'passed'. */
async function passItem(h: OrchestrationTestHarness, itemId: string): Promise<void> {
  h.completeAgent(runningAgentFor(h, itemId), engineerReportOutput({ summary: `did ${itemId}` }));
  await flushMicrotasks(20);
  h.completeAgent(runningAgentFor(h, itemId), reviewerReportOutput({ passed: true }));
  await flushMicrotasks(20);
}

describe('dependency gating — concurrency, waiting, release', () => {
  test('C+A run concurrently, B waits honestly, B claims after A passes, all pass', async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h);
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));

    const spec = fromPlanProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'do A' }),
      proposalItem({ id: 'b', title: 'B', brief: 'do B', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'do C' }),
    ]), cfg);
    const ws = engine.createWorkstream(spec);
    engine.start(ws.id);
    await flushMicrotasks(20);

    const item = (id: string) => ws.items.find((i) => i.id === id)!;

    // A and C run concurrently; B is blocked on A (honest state + reason).
    expect(item('a').state).toBe('in-phase');
    expect(item('c').state).toBe('in-phase');
    expect(item('b').state).toBe('blocked-dependency');
    expect(item('b').blockedReason).toBe('waiting on: A');

    // The block was announced once, naming the unmet dependency by id.
    const blockEvents = events.filter((e) => e.type === 'item-blocked-dependency');
    expect(blockEvents).toHaveLength(1);
    expect(blockEvents[0]).toMatchObject({ itemId: 'b', reason: 'waiting on: A', deps: ['a'] });

    // Pass A fully. Its termination should release B.
    await passItem(h, 'a');
    expect(item('a').state).toBe('passed');
    expect(item('b').state).toBe('in-phase');
    expect(item('b').blockedReason).toBeUndefined();
    expect(events.some((e) => e.type === 'item-dependency-cleared' && e.itemId === 'b')).toBe(true);

    // Finish B and C — all three pass.
    await passItem(h, 'c');
    await passItem(h, 'b');
    expect(ws.items.map((i) => i.state).sort()).toEqual(['passed', 'passed', 'passed']);
  });
});

describe('dependency gating — failed dependency + retry recovery', () => {
  test("A fails ⇒ B blocked 'dependency failed: A' (not failed); retryItem(A) recovers", async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h);
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));

    const spec = fromPlanProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'do A' }),
      proposalItem({ id: 'b', title: 'B', brief: 'do B', dependsOn: ['a'] }),
    ]), cfg);
    const ws = engine.createWorkstream(spec);
    engine.start(ws.id);
    await flushMicrotasks(20);
    const item = (id: string) => ws.items.find((i) => i.id === id)!;

    // Fail A's engineer phase.
    h.failAgent(runningAgentFor(h, 'a'), 'boom');
    await flushMicrotasks(20);
    expect(item('a').state).toBe('failed');

    // B is REFUSED, not killed: still recoverable, with a failed-dependency reason.
    expect(item('b').state).toBe('blocked-dependency');
    expect(item('b').blockedReason).toBe('dependency failed: A');
    // The workstream is NOT terminal (B is neither passed nor failed).
    expect(ws.items.every((i) => i.state === 'passed' || i.state === 'failed')).toBe(false);

    // Recovery path (updateBudget-style): retry the failed dependency.
    const retried = engine.retryItem('a');
    expect(retried).toBe(true);
    expect(events.some((e) => e.type === 'item-retried' && e.itemId === 'a')).toBe(true);
    await flushMicrotasks(20);
    expect(item('a').state).toBe('in-phase'); // re-running from the first phase

    // A passes on retry ⇒ B unblocks and both pass.
    await passItem(h, 'a');
    expect(item('a').state).toBe('passed');
    expect(item('b').state).toBe('in-phase');
    await passItem(h, 'b');
    expect(item('b').state).toBe('passed');

    // retryItem refuses a non-failed item.
    expect(engine.retryItem('b')).toBe(false);
  });
});

describe('dependency gating — resume preserves the wait', () => {
  test('a blocked-dependency item stays blocked across serialize→import into a fresh engine', async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h);
    const spec = fromPlanProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'do A' }),
      proposalItem({ id: 'b', title: 'B', brief: 'do B', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'do C' }),
    ]), cfg);
    const ws = engine.createWorkstream(spec);
    engine.start(ws.id);
    await flushMicrotasks(20);
    expect(ws.items.find((i) => i.id === 'b')!.state).toBe('blocked-dependency');

    const json = engine.serializeWorkstream(ws.id)!;
    expect(json).toBeTruthy();

    // Fresh engine (new process simulation) imports the snapshot and resumes.
    const h2 = createOrchestrationHarness();
    const engine2 = makeEngine(h2);
    expect(engine2.importWorkstream(json)).toBe(true);
    engine2.start(ws.id);
    await flushMicrotasks(20);

    const ws2 = engine2.getWorkstream(ws.id)!;
    const b2 = ws2.items.find((i) => i.id === 'b')!;
    // The dependency wait survived the resume — B is still gated on A, which was
    // re-queued (its in-phase snapshot reconciled) and is running again.
    expect(b2.state).toBe('blocked-dependency');
    expect(b2.blockedReason).toBe('waiting on: A');
    expect(ws2.items.find((i) => i.id === 'a')!.state).toBe('in-phase');

    // And it still recovers: passing A releases B.
    await passItem(h2, 'a');
    expect(b2.state).toBe('in-phase');
  });
});
