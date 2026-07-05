/**
 * BIG-3 item 5 (+ items 2/3 in worktree mode) — configured quality gates run
 * INSIDE the item's worktree in worktree-isolation mode, and the dependency
 * flow composes with per-item worktrees + the sequential integration lane.
 *
 * Proof:
 *  - a fixture gate (`pwd >> log`) records the working directory it ran in;
 *    in worktree mode every recorded cwd is the item's `.goodvibes/.worktrees`
 *    path (the marker "lands in the worktree"), never the shared projectRoot;
 *  - shared mode is unchanged: the same gate runs in the process cwd, not a
 *    per-item worktree;
 *  - a 3-item plan (B dependsOn A, C independent) in worktree mode integrates
 *    in dependency-respecting order — A merges before B — because B cannot even
 *    start (let alone pass and enqueue) until A has passed and enqueued.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import { createOrchestrationEngine } from '../packages/sdk/src/platform/orchestration/engine.js';
import { fromPlanProposal } from '../packages/sdk/src/platform/orchestration/proposal-workstream.js';
import type { OrchestrationEvent } from '../packages/sdk/src/platform/orchestration/types.js';
import type { PhaseRunnerAgentManagerLike } from '../packages/sdk/src/platform/orchestration/phase-runner.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { PlanProposal, WorkItem as ProposalWorkItem } from '../packages/sdk/src/platform/core/plan-proposal.js';
import { engineerReportOutput, makeRecord, reviewerReportOutput } from './_helpers/orchestration-harness.js';

const ctx = { sessionId: 'test', traceId: 'test', source: 'test' } as const;

function runGit(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(Buffer.from(r.stderr).toString('utf8'));
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-gates-'));
  runGit(dir, ['init']);
  runGit(dir, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'seed']);
  return dir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Harness {
  readonly bus: RuntimeEventBus;
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly agentStore: Map<string, AgentRecord>;
  completeAgent(agentId: string, output: string): void;
}

function makeHarness(): Harness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  let counter = 0;
  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      counter += 1;
      const id = `agent-${counter}`;
      const raw = input as unknown as { task?: string; template?: string };
      const record = makeRecord({ id, task: raw.task ?? 'task', template: raw.template ?? 'engineer' });
      agentStore.set(id, record);
      return record;
    },
    getStatus: (id) => agentStore.get(id) ?? null,
    cancel: (id) => { const r = agentStore.get(id); if (r) r.status = 'cancelled'; return true; },
    registerCancellationSignal: () => undefined,
    releaseCancellationSignal: () => undefined,
  };
  function completeAgent(agentId: string, output: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'completed';
    record.fullOutput = output;
    record.usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };
    emitAgentCompleted(bus, ctx, { agentId, durationMs: 1 });
  }
  return { bus, agentManager, agentStore, completeAgent };
}

/** A config manager exposing one always-passing fixture gate that logs its cwd. */
function makeGateConfig(logPath: string): { get: (k: string) => unknown; getCategory: (c: string) => unknown } {
  const gates = [{ name: 'marker', command: `pwd >> ${JSON.stringify(logPath)}`, enabled: true }];
  return {
    get: (k: string) => (k === 'wrfc.transportRetryLimit' ? 0 : k === 'wrfc.commitScope' ? 'scoped' : undefined),
    getCategory: (c: string) => (c === 'wrfc' ? { gates, commitScope: 'scoped', transportRetryLimit: 0 } : undefined),
  };
}

function runningAgentFor(h: Harness, itemId: string): string {
  for (const [id, rec] of h.agentStore) {
    if (rec.status === 'running' && (rec as { workItemId?: string }).workItemId === itemId) return id;
  }
  throw new Error(`no running agent for ${itemId}`);
}
function hasRunningAgentFor(h: Harness, itemId: string): boolean {
  for (const rec of h.agentStore.values()) {
    if (rec.status === 'running' && (rec as { workItemId?: string }).workItemId === itemId) return true;
  }
  return false;
}

function proposalItem(o: Partial<ProposalWorkItem> & { id: string; title: string; brief: string }): ProposalWorkItem {
  return { phaseId: 'p', dependsOn: [], ...o };
}
function makeProposal(items: ProposalWorkItem[]): PlanProposal {
  return {
    id: 'prop', task: 'goal', strategy: 'parallel', rationale: 'r',
    phases: [{ id: 'p', title: 'Execute', order: 1 }], workItems: items, createdAt: 1, source: 'planner-agent',
  };
}

describe('worktree-mode gates + dependency composition (BIG-3 items 2/3/5)', () => {
  test('gates run IN each item worktree; A integrates before B; C concurrent', async () => {
    const root = freshRepo();
    const gateLog = join(root, 'gate-cwds.log');
    const h = makeHarness();
    const events: OrchestrationEvent[] = [];
    const engine = createOrchestrationEngine({
      agentManager: h.agentManager,
      configManager: makeGateConfig(gateLog),
      runtimeBus: h.bus,
      projectRoot: root,
      persist: false,
      skipClaimVerification: true,
    });
    engine.on((e) => events.push(e));

    const spec = fromPlanProposal(makeProposal([
      proposalItem({ id: 'a', title: 'A', brief: 'do A' }),
      proposalItem({ id: 'b', title: 'B', brief: 'do B', dependsOn: ['a'] }),
      proposalItem({ id: 'c', title: 'C', brief: 'do C' }),
    ]), makeGateConfig(gateLog));
    const ws = engine.createWorkstream({ ...spec, isolation: 'worktree' });
    engine.start(ws.id);

    const item = (id: string) => ws.items.find((i) => i.id === id)!;

    // A and C claim + get worktrees; B is dependency-blocked (no worktree yet).
    await waitUntil(() => hasRunningAgentFor(h, 'a') && hasRunningAgentFor(h, 'c'));
    expect(item('a').worktreePath).toBeDefined();
    expect(item('c').worktreePath).toBeDefined();
    expect(item('b').state).toBe('blocked-dependency');
    expect(item('b').worktreePath).toBeUndefined();

    // Drive an item engineer→review inside its worktree, writing a real file so
    // the scoped commit produces a mergeable branch.
    const pass = async (id: string): Promise<void> => {
      await waitUntil(() => !!item(id).worktreePath && hasRunningAgentFor(h, id));
      writeFileSync(join(item(id).worktreePath!, `${id}.txt`), `content ${id}\n`);
      h.completeAgent(runningAgentFor(h, id), engineerReportOutput({ filesCreated: [`${id}.txt`] }));
      await waitUntil(() => hasRunningAgentFor(h, id));
      h.completeAgent(runningAgentFor(h, id), reviewerReportOutput({ passed: true }));
    };

    await pass('a');
    await pass('c');
    // B only becomes claimable after A passed.
    await pass('b');

    await waitUntil(() => events.filter((e) => e.type === 'item-merged').length === 3, 25_000);

    const mergedOrder = events.filter((e) => e.type === 'item-merged').map((e) => (e as { itemId: string }).itemId);
    // Dependency-respecting integration: A merges before B.
    expect(mergedOrder.indexOf('a')).toBeLessThan(mergedOrder.indexOf('b'));
    expect(ws.items.every((i) => i.state === 'passed')).toBe(true);

    // Every gate invocation ran inside a per-item worktree, never the shared root.
    const loggedCwds = readFileSync(gateLog, 'utf-8').trim().split('\n').filter(Boolean);
    expect(loggedCwds.length).toBeGreaterThan(0);
    for (const cwd of loggedCwds) {
      expect(cwd).toContain(join('.goodvibes', '.worktrees', 'ws'));
      expect(cwd).not.toBe(root);
    }

    engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }, 40_000);

  test('shared mode is unchanged — gates do NOT run in a per-item worktree', async () => {
    const root = freshRepo();
    const gateLog = join(root, 'gate-cwds.log');
    const h = makeHarness();
    const engine = createOrchestrationEngine({
      agentManager: h.agentManager,
      configManager: makeGateConfig(gateLog),
      runtimeBus: h.bus,
      projectRoot: root,
      persist: false,
      skipClaimVerification: true,
    });
    const spec = fromPlanProposal(makeProposal([proposalItem({ id: 'a', title: 'A', brief: 'do A' })]), makeGateConfig(gateLog));
    const ws = engine.createWorkstream(spec); // default: shared isolation
    engine.start(ws.id);
    await waitUntil(() => hasRunningAgentFor(h, 'a'));
    h.completeAgent(runningAgentFor(h, 'a'), engineerReportOutput({ filesCreated: ['a.txt'] }));
    await waitUntil(() => existsSync(gateLog));

    const loggedCwds = readFileSync(gateLog, 'utf-8').trim().split('\n').filter(Boolean);
    for (const cwd of loggedCwds) {
      expect(cwd).not.toContain(join('.goodvibes', '.worktrees'));
    }

    engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});
