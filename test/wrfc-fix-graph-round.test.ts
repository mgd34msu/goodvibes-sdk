/**
 * wrfc-fix-graph-round.test.ts — the fix-phase rework's done-when clauses at
 * the engine/planner level (the controller-side clauses are pinned in
 * wrfc-constraint-propagation / wrfc-controller / wrfc-phantom-fixes):
 *
 * - a multi-finding review decomposes into a dependency graph (visible via the
 *   graph snapshot surfaces render);
 * - release semantics: a blocker's claimed-done releases NOTHING — only its
 *   review-pass + landed merge releases an edge (test pins this exact case);
 * - a mid-task discovered dependency adds a live edge (and may re-queue);
 * - a seeded cycle and an orphaned task surface as structured outcomes
 *   immediately;
 * - a ready task with all agents busy spawns a new fleet agent that picks it
 *   up, while at-cap renders the visible "N ready, M running, at cap" state
 *   instead of spawning; an idle agent with an empty ready set retires;
 * - one ceiling: a native agent + an ACP-hosted row + an elastic fixer all
 *   count against fleet.maxSize (the responsibility-counting seam), and the
 *   legacy key migrates invisibly with a receipt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine } from '../packages/sdk/src/platform/orchestration/engine.js';
import { parseReviewIntoTasks, planTaskGraph, planFixWorkstream } from '../packages/sdk/src/platform/orchestration/review-task-source.js';
import { dependencySatisfied } from '../packages/sdk/src/platform/orchestration/scheduler.js';
import { countOwnedActiveAgents, fleetCapacityProbeFrom } from '../packages/sdk/src/platform/runtime/orchestration/fleet-count.js';
import { migrateFleetMaxSizeRename } from '../packages/sdk/src/platform/config/migrations.js';
import { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { OrchestrationEvent, WorkItem, Workstream } from '../packages/sdk/src/platform/orchestration/types.js';
import type { ReviewerReport } from '../packages/sdk/src/platform/agents/completion-report.js';
import {
  createOrchestrationHarness,
  engineerReportOutput,
  reviewerReportOutput,
  flushMicrotasks,
  makeFakeConfigManager,
  type OrchestrationTestHarness,
} from './_helpers/orchestration-harness.js';

const cfg = makeFakeConfigManager();

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'fix-graph-')); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

function multiFindingReview(): ReviewerReport {
  return {
    version: 1,
    archetype: 'reviewer',
    summary: 'multiple problems',
    score: 4,
    passed: false,
    dimensions: [],
    issues: [
      { severity: 'critical', description: 'null deref in parser', file: 'src/parser/core.ts', line: 10, pointValue: 3 },
      { severity: 'major', description: 'wrong flag name', file: 'src/cli/flags.ts', line: 5, pointValue: 2 },
      { severity: 'minor', description: 'stale comment in parser', file: 'src/parser/core.ts', line: 99, pointValue: 1 },
      { severity: 'suggestion', description: 'could rename a variable', pointValue: 0 },
    ],
    constraintFindings: [
      { constraintId: 'c1', satisfied: false, evidence: 'output has 3 columns, task asked for 2', severity: 'major' },
    ],
    acceptanceChecklist: [
      { item: 'writes exactly 2 rows', verified: false, evidence: 'wrote 3' },
      { item: 'accepts --input flag', verified: true, evidence: 'ran it', howExercised: 'real invocation' },
    ],
  };
}

describe('parser/planner — a multi-finding review becomes a dependency graph', () => {
  test('typed tasks with citations; shared-file + semantic edges; suggestions and verified items excluded', () => {
    const tasks = parseReviewIntoTasks({ review: multiFindingReview(), originalTask: 'Build the CSV tool' });
    // 3 findings (suggestion excluded) + 1 unmet constraint + 1 unverified checklist item.
    expect(tasks).toHaveLength(5);
    expect(tasks.every((t) => t.description.includes('Build the CSV tool'))).toBe(true);
    const parserTasks = tasks.filter((t) => t.files.includes('src/parser/core.ts'));
    expect(parserTasks).toHaveLength(2);

    const { specs, edgeCount } = planTaskGraph(tasks);
    expect(edgeCount).toBeGreaterThan(0);
    // Shared-file edge: the minor parser task waits on the critical parser fix.
    const critical = specs.find((s) => s.title.includes('null deref'))!;
    const minor = specs.find((s) => s.title.includes('stale comment'))!;
    expect(minor.dependsOn).toContain(critical.id!);
    expect(critical.dependsOn ?? []).toHaveLength(0);
    // Semantic edges: verification tasks wait on every finding fix.
    const checklist = specs.find((s) => s.title.startsWith('Make verifiable'))!;
    expect(checklist.dependsOn).toEqual(expect.arrayContaining([critical.id!, minor.id!]));
    // Clusters derive from file paths.
    expect(critical.cluster).toBe('src/parser');

    const planned = planFixWorkstream({
      chainId: 'chain-1', originalTask: 'Build the CSV tool', review: multiFindingReview(), attempt: 1, commitScope: 'scoped',
    })!;
    expect(planned.workstream.isolation).toBe('worktree');
    expect(planned.workstream.releasePolicy).toBe('reviewed-and-merged');
  });

  test('the graph is visible on surfaces via the snapshot (nodes, edges, states)', async () => {
    const h = createOrchestrationHarness();
    const engine = createOrchestrationEngine({
      agentManager: h.agentManager, configManager: cfg, runtimeBus: h.bus, projectRoot,
      createWorktree: () => h.worktree, persist: false, skipClaimVerification: true,
    });
    const planned = planFixWorkstream({
      chainId: 'chain-g', originalTask: 'Build the CSV tool', review: multiFindingReview(), attempt: 1, commitScope: 'scoped',
    })!;
    // Shared isolation for this harness (no real git); graph shape is identical.
    const ws = engine.createWorkstream({ ...planned.workstream, isolation: 'shared' });
    const snapshot = engine.getGraphSnapshot(ws.id)!;
    expect(snapshot.nodes).toHaveLength(5);
    expect(snapshot.edges.length).toBeGreaterThan(0);
    expect(snapshot.nodes.every((n) => typeof n.remainingDepth === 'number')).toBe(true);
    const criticalNode = snapshot.nodes.find((n) => n.title.includes('null deref'))!;
    expect(criticalNode.files).toContain('src/parser/core.ts');
    // Deepest-remaining-path: the critical fix outranks its dependents.
    expect(criticalNode.remainingDepth).toBeGreaterThan(0);
  });
});

describe('release semantics — claimed-done releases NOTHING', () => {
  function fakeWorkstream(dep: Partial<WorkItem>): { ws: Workstream; dep: WorkItem } {
    const item = {
      id: 'dep', title: 'Blocker', task: 't', dependsOn: [], currentPhaseId: null,
      state: 'passed', allAgentIds: [], visits: new Map(), touchedPaths: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
      transportRetryCount: 0, createdAt: 1, ...dep,
    } as WorkItem;
    const ws = {
      id: 'ws', title: 'w', schemaVersion: 1, phases: [], items: [item],
      isolation: 'worktree', releasePolicy: 'reviewed-and-merged', createdAt: 1,
    } as unknown as Workstream;
    return { ws, dep: item };
  }

  test('in-flight (claimed/working) releases nothing; passed-but-unmerged releases nothing; passed+merged releases (test pins this exact case)', () => {
    // An agent CLAIMING the work (in-phase) — or even claiming it finished
    // while review is pending — releases nothing.
    expect(dependencySatisfied(...(() => { const { ws, dep } = fakeWorkstream({ state: 'in-phase' }); return [ws, dep] as const; })())).toBe(false);
    // Slice review passed (item state 'passed') but the merge has NOT landed:
    // still released? NO — reviewed AND merged is the edge contract.
    expect(dependencySatisfied(...(() => { const { ws, dep } = fakeWorkstream({ state: 'passed', mergeState: 'pending' }); return [ws, dep] as const; })())).toBe(false);
    // Review passed AND the merge landed in the integration lane: released.
    expect(dependencySatisfied(...(() => { const { ws, dep } = fakeWorkstream({ state: 'passed', mergeState: 'merged' }); return [ws, dep] as const; })())).toBe(true);
    // Legacy policy (no releasePolicy): passed alone still releases (back-compat).
    const { ws, dep } = fakeWorkstream({ state: 'passed', mergeState: 'pending' });
    (ws as { releasePolicy?: string }).releasePolicy = undefined;
    expect(dependencySatisfied(ws, dep)).toBe(true);
  });
});

describe('dynamic graph — live edges, cycles, orphans', () => {
  function makeEngine(h: OrchestrationTestHarness, extra: Record<string, unknown> = {}) {
    return createOrchestrationEngine({
      agentManager: h.agentManager, configManager: cfg, runtimeBus: h.bus, projectRoot,
      createWorktree: () => h.worktree, persist: false, skipClaimVerification: true, ...extra,
    });
  }

  test('a mid-task discovered dependency adds a live edge and the discoverer may re-queue', async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h);
    const ws = engine.createWorkstream({
      title: 'live edge', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 8, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [
        { id: 't1', title: 'T1', task: 'one' },
        { id: 't2', title: 'T2', task: 'two' },
      ],
    });
    engine.start(ws.id);
    await flushMicrotasks(20);
    // Both independent tasks are running concurrently.
    expect(ws.items.every((i) => i.state === 'in-phase')).toBe(true);

    // T2's agent discovers it needs T1 first: live edge + re-queue.
    const result = engine.addDependency('t2', 't1', 'discovered a missed dependency');
    expect(result?.added).toBe(true);
    expect(engine.requeueItem('t2', 'requeued after discovering the dependency')).toBe(true);
    await flushMicrotasks(20);
    const t2 = ws.items.find((i) => i.id === 't2')!;
    expect(t2.dependsOn).toContain('t1');
    expect(t2.state).toBe('blocked-dependency'); // waits for T1 now
    expect(t2.blockedReason).toContain('T1');
  });

  test('a seeded cycle surfaces IMMEDIATELY as a structured outcome — never a silently-never-ready node', async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h);
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));
    const ws = engine.createWorkstream({
      title: 'cycle', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [
        { id: 'a', title: 'A', task: 'a', dependsOn: ['b'] },
        { id: 'b', title: 'B', task: 'b' },
      ],
    });
    // Seeding b -> a would close the cycle a -> b -> a: refused + structured.
    const result = engine.addDependency('b', 'a', 'seeded cycle');
    expect(result?.added).toBe(false);
    expect(result?.cycle).toBeDefined();
    const cycleEvent = events.find((e) => e.type === 'graph-cycle');
    expect(cycleEvent).toBeDefined();
    expect((cycleEvent as { cycle: string[] }).cycle.join('->')).toContain('A');
    // The graph is unchanged — no silently-poisoned edge.
    expect(ws.items.find((i) => i.id === 'b')!.dependsOn).toHaveLength(0);
  });

  test('an orphaned task (blocker hard-failed past the retry bound) surfaces immediately as a structured outcome', async () => {
    const h = createOrchestrationHarness();
    const engine = makeEngine(h, { maxItemRetries: 1 });
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));
    const ws = engine.createWorkstream({
      title: 'orphan', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 8, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [
        { id: 'root', title: 'Root fix', task: 'root' },
        { id: 'child', title: 'Child fix', task: 'child', dependsOn: ['root'] },
      ],
    });
    engine.start(ws.id);
    await flushMicrotasks(20);

    // Fail root once → bounded auto-retry consumes it (attempt 1/1).
    h.failAgent(ws.items.find((i) => i.id === 'root')!.agentId!, 'engine exploded');
    await flushMicrotasks(30);
    const retried = events.find((e) => e.type === 'item-retried');
    expect(retried).toBeDefined();

    // Fail the retry too → HARD failure → the child is orphaned IMMEDIATELY.
    h.failAgent(ws.items.find((i) => i.id === 'root')!.agentId!, 'still exploding');
    await flushMicrotasks(30);
    const orphanEvent = events.find((e) => e.type === 'item-orphaned');
    expect(orphanEvent).toBeDefined();
    expect((orphanEvent as { itemId: string }).itemId).toBe('child');
    const child = ws.items.find((i) => i.id === 'child')!;
    expect(child.orphaned).toBe(true);
    expect(child.blockedReason).toContain('hard-failed past its retry bound');
  });
});

describe('elastic pool — spawn on ready, visible at-cap, retire on empty', () => {
  function makeElasticEngine(h: OrchestrationTestHarness, probe: () => { active: number; maxSize: number; capKey: string; refusal?: string }) {
    return createOrchestrationEngine({
      agentManager: h.agentManager, configManager: cfg, runtimeBus: h.bus, projectRoot,
      createWorktree: () => h.worktree, persist: false, skipClaimVerification: true,
      fleetCapacity: probe,
    });
  }

  test('a ready task with fleet headroom spawns a NEW agent that picks it up (test pins this)', async () => {
    const h = createOrchestrationHarness();
    const engine = makeElasticEngine(h, () => ({
      active: [...h.agentStore.values()].filter((a) => a.status === 'running' || a.status === 'pending').length,
      maxSize: 8,
      capKey: 'fleet.maxSize',
    }));
    const ws = engine.createWorkstream({
      title: 'elastic', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 8, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [{ id: 'e1', title: 'E1', task: 'one' }, { id: 'e2', title: 'E2', task: 'two' }],
    });
    const before = h.agentStore.size;
    engine.start(ws.id);
    await flushMicrotasks(20);
    // Two ready tasks, no available agents → TWO fresh agents spawned into the fleet.
    expect(h.agentStore.size).toBe(before + 2);
    expect(ws.items.every((i) => i.state === 'in-phase')).toBe(true);
  });

  test('at-cap renders the visible "N ready, M running, at cap" state instead of spawning; a policy refusal names its reason', async () => {
    const h = createOrchestrationHarness();
    let maxSize = 0; // at cap immediately (0 headroom)
    let refusal: string | undefined;
    const engine = makeElasticEngine(h, () => ({ active: 5, maxSize: maxSize || 5, capKey: 'fleet.maxSize', refusal }));
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));
    const ws = engine.createWorkstream({
      title: 'capped', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 8, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [{ id: 'c1', title: 'C1', task: 'one' }],
    });
    engine.start(ws.id);
    await flushMicrotasks(20);

    const item = ws.items[0]!;
    expect(item.state).toBe('awaiting-capacity'); // visibly ready, not silently stalled
    expect(item.blockedReason).toContain('at cap');
    expect(item.blockedReason).toContain('fleet.maxSize=5');
    const atCap = events.find((e) => e.type === 'pool-at-cap');
    expect(atCap).toBeDefined();
    expect(atCap).toMatchObject({ ready: 1, running: 0, capKey: 'fleet.maxSize', maxSize: 5 });
    // The graph snapshot serves the pool state for the chip/graph rendering.
    const snapshot = engine.getGraphSnapshot(ws.id)!;
    expect(snapshot.pool).toMatchObject({ atCap: true, capKey: 'fleet.maxSize' });
    expect(h.agentStore.size).toBe(0); // nothing spawned at cap

    // A spawn REFUSAL (host resources / policy) leaves the task visibly ready with its reason.
    maxSize = 50;
    refusal = 'host memory pressure';
    engine.start(ws.id);
    await flushMicrotasks(20);
    expect(ws.items[0]!.state).toBe('awaiting-capacity');
    expect(ws.items[0]!.blockedReason).toContain('host memory pressure');
    expect(events.some((e) => e.type === 'pool-spawn-refused')).toBe(true);
  });

  test('an idle agent with an empty ready set and no imminent release retires', async () => {
    const h = createOrchestrationHarness();
    const engine = makeElasticEngine(h, () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }));
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));
    const ws = engine.createWorkstream({
      title: 'retire', isolation: 'shared', releasePolicy: 'reviewed-and-merged',
      phases: [{ role: 'engineer', capacity: 8, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
      items: [{ id: 'r1', title: 'R1', task: 'only task' }],
    });
    engine.start(ws.id);
    await flushMicrotasks(20);
    const agentId = ws.items[0]!.agentId!;
    h.completeAgent(agentId, engineerReportOutput({ summary: 'done' }));
    await flushMicrotasks(30);
    // The single task passed; the ready set is empty; nothing in flight could
    // release an edge — the agent retires cleanly instead of idling warm.
    const retired = events.find((e) => e.type === 'agent-retired');
    expect(retired).toBeDefined();
    expect(retired).toMatchObject({ agentId, reason: 'ready set empty; no imminent edge release' });
  });
});

describe('fleet.maxSize — one ceiling, responsibility-counted, invisible migration', () => {
  test('a native agent + an ACP-hosted row + an elastic fixer share the ONE ceiling', () => {
    // The counting seam takes OWNED sources only; the elastic fixer spawns
    // through the same native AgentManager, so all three meet at one number.
    let nativeIncludingElasticFixers = 2; // 1 ordinary native agent + 1 elastic fixer
    const acpHosted = 1;
    const count = () => countOwnedActiveAgents({
      countNativeActive: () => nativeIncludingElasticFixers,
      countAcpHosted: () => acpHosted,
    });
    expect(count()).toBe(3);
    const probe = fleetCapacityProbeFrom({
      readConfig: (key) => (key === 'fleet.maxSize' ? 3 : undefined),
      sources: { countNativeActive: () => nativeIncludingElasticFixers, countAcpHosted: () => acpHosted },
    });
    expect(probe).toMatchObject({ active: 3, maxSize: 3, capKey: 'fleet.maxSize' });
    // One more of ANY kind crosses the same ceiling.
    nativeIncludingElasticFixers += 1;
    expect(countOwnedActiveAgents({ countNativeActive: () => nativeIncludingElasticFixers, countAcpHosted: () => acpHosted })).toBe(4);
  });

  test('the legacy orchestration.maxActiveAgents migrates invisibly onto fleet.maxSize with a receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-migrate-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ orchestration: { maxActiveAgents: 12 } }, null, 2), 'utf-8');
      const manager = new ConfigManager({ configDir: dir });
      // The value moved; the new key resolves it; the legacy key is gone from disk.
      expect(manager.get('fleet.maxSize' as never)).toBe(12);
      const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
      expect(onDisk.fleet).toEqual({ maxSize: 12 });
      expect(onDisk.orchestration).toBeUndefined();
      // Pure-function contract too (idempotent, no-op without the legacy key).
      expect(migrateFleetMaxSizeRename({}).migrated).toBe(false);
      expect(migrateFleetMaxSizeRename({ orchestration: { maxActiveAgents: 4 } })).toMatchObject({ migrated: true, movedValue: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
