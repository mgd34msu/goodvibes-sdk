/**
 * OrchestrationEngine: pipeline scheduling, dynamic phase
 * insertion, budget refusal, resume prefix replay, cancellation, and
 * primitive reuse (phantom guard + scoped commit).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../packages/sdk/src/platform/orchestration/engine.js';
import { fromChainSpec } from '../packages/sdk/src/platform/orchestration/controller-compat.js';
import { loadWorkstreamSnapshot } from '../packages/sdk/src/platform/orchestration/persistence.js';
import type { PhaseRunnerAgentManagerLike, WrfcWorktreeOps } from '../packages/sdk/src/platform/orchestration/phase-runner.js';
import type { OrchestrationEvent, PhaseSpec, WorkItemSpec } from '../packages/sdk/src/platform/orchestration/types.js';
import { emptyWorkItemUsage, mergeWorkItemUsage } from '../packages/sdk/src/platform/orchestration/types.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    template: 'engineer',
    tools: [],
    status: 'running',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function engineerReportOutput(
  summary: string,
  opts: { filesCreated?: string[]; filesModified?: string[] } = {},
): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary,
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [summary],
      filesCreated: opts.filesCreated ?? [],
      filesModified: opts.filesModified ?? [],
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }),
    '```',
  ].join('\n');
}

function reviewerReportOutput(
  score: number,
  passed: boolean,
  constraintFindings: Array<{ constraintId: string; satisfied: boolean; evidence: string; severity?: 'critical' | 'major' | 'minor' }> = [],
): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'reviewer',
      summary: passed ? 'looks good' : 'needs fixes',
      score,
      passed,
      dimensions: [],
      issues: [],
      constraintFindings,
    }),
    '```',
  ].join('\n');
}

interface Harness {
  readonly bus: RuntimeEventBus;
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly agentStore: Map<string, AgentRecord>;
  readonly spawnedTasks: string[];
  readonly cancelCalls: Array<{ id: string; kind: 'interrupt' | 'kill' }>;
  readonly registeredSignals: Map<string, AbortSignal>;
  readonly configManager: Pick<import('../packages/sdk/src/platform/config/manager.js').ConfigManager, 'get' | 'getCategory'>;
  readonly commitCalls: Array<{ message: string; paths?: string[] | undefined }>;
  readonly mergeCalls: string[];
  readonly cleanupCalls: string[];
  readonly projectRoot: string;
  readonly configOverrides: { gates: Array<{ name: string; command: string; enabled: boolean }>; commitScope: 'off' | 'scoped' | 'all' };
  makeEngine(depsOverrides?: Partial<OrchestrationEngineDeps>): ReturnType<typeof createOrchestrationEngine>;
  completeAgent(agentId: string, output: string): void;
  failAgent(agentId: string, error: string): void;
  cancelAgentEvent(agentId: string): void;
}

function makeHarness(projectRoot: string): Harness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedTasks: string[] = [];
  const cancelCalls: Array<{ id: string; kind: 'interrupt' | 'kill' }> = [];
  const registeredSignals = new Map<string, AbortSignal>();
  const commitCalls: Array<{ message: string; paths?: string[] | undefined }> = [];
  const mergeCalls: string[] = [];
  const cleanupCalls: string[] = [];
  let counter = 0;

  const configOverrides = { gates: [] as Array<{ name: string; command: string; enabled: boolean }>, commitScope: 'scoped' as 'off' | 'scoped' | 'all' };

  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.commitScope') return configOverrides.commitScope;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'wrfc') {
        return {
          scoreThreshold: 9.9,
          maxFixAttempts: 5,
          autoCommit: true,
          transportRetryLimit: 1,
          transportRetryDelayMs: 1,
          commitScope: configOverrides.commitScope,
          gates: configOverrides.gates,
        };
      }
      return undefined;
    },
  };

  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      counter += 1;
      const id = `agent-${counter}`;
      const task = (input as { task: string }).task;
      spawnedTasks.push(task);
      const record = makeRecord({ id, task, template: (input as { template?: string }).template ?? 'engineer' });
      agentStore.set(id, record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    cancel: (id: string, kind: 'interrupt' | 'kill' = 'kill') => {
      cancelCalls.push({ id, kind });
      const record = agentStore.get(id);
      if (record) record.status = 'cancelled';
      return true;
    },
    registerCancellationSignal: (agentId, signal) => {
      registeredSignals.set(agentId, signal);
    },
    releaseCancellationSignal: (agentId) => {
      registeredSignals.delete(agentId);
    },
  };

  const createWorktree = (): WrfcWorktreeOps => ({
    merge: async (agentId) => {
      mergeCalls.push(agentId);
      return true;
    },
    cleanup: async (agentId) => {
      cleanupCalls.push(agentId);
    },
    commitWorkingTree: async (message, paths) => {
      commitCalls.push({ message, paths });
      return { hash: 'commit-hash', skippedIgnored: [] };
    },
    currentHead: async () => 'head-hash',
  });

  function makeEngine(depsOverrides: Partial<OrchestrationEngineDeps> = {}): ReturnType<typeof createOrchestrationEngine> {
    return createOrchestrationEngine({
      agentManager,
      configManager,
      runtimeBus: bus,
      projectRoot,
      createWorktree,
      persist: false,
      maxPhaseVisits: 3,
      // Scheduling/budget/cancellation tests use bare fixture reports with no
      // real files and no git repo in `projectRoot` — verifyEngineerClaims
      // would honestly flag those as phantom work (no claims, no git diff).
      // Tests that specifically exercise the phantom-work guard (the
      // "primitive reuse" describe block) override this back to false.
      skipClaimVerification: true,
      ...depsOverrides,
    });
  }

  function completeAgent(agentId: string, output: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'completed';
    record.fullOutput = output;
    record.usage = {
      inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1,
    };
    bus.emit('agents', createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  function failAgent(agentId: string, error: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'failed';
    record.error = error;
    bus.emit('agents', createEventEnvelope(
      'AGENT_FAILED',
      { type: 'AGENT_FAILED', agentId, error, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  function cancelAgentEvent(agentId: string): void {
    bus.emit('agents', createEventEnvelope(
      'AGENT_CANCELLED',
      { type: 'AGENT_CANCELLED', agentId, reason: 'operator cancellation' },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ));
  }

  return {
    bus, agentManager, agentStore, spawnedTasks, cancelCalls, registeredSignals, configManager,
    commitCalls, mergeCalls, cleanupCalls, projectRoot, configOverrides,
    makeEngine, completeAgent, failAgent, cancelAgentEvent,
  };
}

function enginePhase(): PhaseSpec {
  return { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] } };
}
function reviewPhase(capacity = 1): PhaseSpec {
  return { role: 'reviewer', capacity, kind: 'review', gate: { scope: 'off', gates: [] } };
}

let projectRoot: string;
let h: Harness;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'orch-engine-'));
  h = makeHarness(projectRoot);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('scheduler — pipeline flow, no pairwise binding', () => {
  test('two engineers share a single reviewer slot; whichever finishes first claims it', async () => {
    const engine = h.makeEngine();
    const items: WorkItemSpec[] = [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }];
    const ws = engine.createWorkstream({ title: 'ws', phases: [enginePhase(), reviewPhase(1)], items });
    engine.start(ws.id);
    await flushMicrotasks();

    // Both engineer slots (capacity 2 would be needed for true concurrency,
    // but capacity 1 here proves sequencing instead) — bump capacity to 2
    // via a second workstream is unnecessary: assert independent progress
    // using explicit engineer capacity 2.
    const engine2 = h.makeEngine();
    const ws2 = engine2.createWorkstream({
      title: 'ws2',
      phases: [{ ...enginePhase(), capacity: 2 }, reviewPhase(1)],
      items,
    });
    engine2.start(ws2.id);
    await flushMicrotasks();

    const itemA = ws2.items.find((i) => i.id === 'item-a')!;
    const itemB = ws2.items.find((i) => i.id === 'item-b')!;
    expect(itemA.state).toBe('in-phase');
    expect(itemB.state).toBe('in-phase');
    expect(itemA.agentId).toBeDefined();
    expect(itemB.agentId).toBeDefined();

    // Complete B FIRST even though A was listed first — B must claim the
    // single reviewer slot without waiting on A (the hard departure from
    // WrfcController's pairwise engineer<->reviewer binding).
    h.completeAgent(itemB.agentId!, engineerReportOutput('did B'));
    await flushMicrotasks();

    expect(itemB.state).toBe('in-phase');
    expect(itemB.currentPhaseId).toBe(ws2.phases[1]!.id);
    // A is untouched — still in its own engineer phase, not blocked by B.
    expect(itemA.state).toBe('in-phase');
    expect(itemA.currentPhaseId).toBe(ws2.phases[0]!.id);

    // A finishes next — the reviewer slot is occupied by B, so A must wait
    // (proves capacity is enforced, not bypassed).
    h.completeAgent(itemA.agentId!, engineerReportOutput('did A'));
    await flushMicrotasks();
    expect(itemA.state).toBe('awaiting-capacity');
    expect(itemA.currentPhaseId).toBe(ws2.phases[1]!.id);

    // B's review passes, freeing the slot for A.
    const bReviewerId = itemB.agentId!;
    h.completeAgent(bReviewerId, reviewerReportOutput(10, true));
    await flushMicrotasks();
    expect(itemB.state).toBe('passed');
    expect(itemA.state).toBe('in-phase');
  });
});

describe('dynamic phase insertion', () => {
  test('an unsatisfied constraint finding inserts a fix phase and re-routes only that item; visits bound the cycle', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase(), reviewPhase(1)],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    const [engPhase, revPhase] = ws.phases;
    engine.start(ws.id);
    await flushMicrotasks();

    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did A', { filesCreated: ['nonexistent.ts'] }));
    await flushMicrotasks();
    expect(item.currentPhaseId).toBe(revPhase!.id);

    h.completeAgent(item.agentId!, reviewerReportOutput(5, false, [
      { constraintId: 'c1', satisfied: false, evidence: 'missing handling' },
    ]));
    await flushMicrotasks();

    // A fix phase was inserted AFTER review (design (b): "inserts a fix
    // phase after review and re-routes that item back"), and the item was
    // re-routed into it — a float ordinal strictly after review's, existing
    // phase ids (engineer, review) untouched.
    expect(ws.phases.length).toBe(3);
    const fixPhase = ws.phases.find((p) => p.kind === 'fix')!;
    expect(fixPhase).toBeDefined();
    expect(fixPhase.ordinal).toBeGreaterThan(revPhase!.ordinal);
    expect(engPhase!.ordinal).toBeLessThan(revPhase!.ordinal); // existing phases' relative order is untouched
    expect(item.currentPhaseId).toBe(fixPhase.id);
    expect(item.visits.get(revPhase!.id)).toBe(1);

    // Fix completes cleanly -> routes back to the SAME review phase (not
    // forward past it) — and since review's single capacity slot is free
    // again, the reactive scheduler reclaims it immediately (the same
    // "instant advancement" semantics as the main pipeline-flow test), so a
    // second review agent is already spawned by the time this settles.
    h.completeAgent(item.agentId!, engineerReportOutput('fixed', { filesCreated: ['nonexistent.ts'] }));
    await flushMicrotasks();
    expect(item.currentPhaseId).toBe(revPhase!.id);
    expect(item.state).toBe('in-phase');
    expect(item.visits.get(revPhase!.id)).toBe(2);

    // Re-review passes this time.
    h.completeAgent(item.agentId!, reviewerReportOutput(10, true));
    await flushMicrotasks();
    expect(item.state).toBe('passed');
  });

  test('visits bound the re-review cycle — repeated failures eventually fail the item, not loop forever', async () => {
    const engine = h.makeEngine({ maxPhaseVisits: 2 });
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase(), reviewPhase(1)],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;

    h.completeAgent(item.agentId!, engineerReportOutput('v1'));
    await flushMicrotasks();

    // Fail review repeatedly — each cycle: review fails -> fix -> review again.
    for (let cycle = 0; cycle < 3; cycle++) {
      h.completeAgent(item.agentId!, reviewerReportOutput(3, false, [{ constraintId: 'c1', satisfied: false, evidence: 'still broken' }]));
      await flushMicrotasks();
      if (item.state === 'failed') break;
      h.completeAgent(item.agentId!, engineerReportOutput('fix attempt'));
      await flushMicrotasks();
    }

    expect(item.state).toBe('failed');
  });
});

describe('budget refusal', () => {
  test('a new claim is refused once the workstream usage reaches the ceiling; the in-flight item still completes', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }],
      budget: { maxTokens: 15 },
    });
    engine.start(ws.id);
    await flushMicrotasks();

    const itemA = ws.items.find((i) => i.id === 'item-a')!;
    const itemB = ws.items.find((i) => i.id === 'item-b')!;
    // Capacity 1 means only A was claimed on the first tick; B is still
    // waiting for capacity, untouched by budget yet.
    expect(itemA.state).toBe('in-phase');
    expect(itemB.state).toBe('pending');
    expect(h.spawnedTasks.length).toBe(1);

    // A completes with usage that pushes the workstream over its 15-token
    // ceiling (10 in + 10 out = 20 >= 15) — in-flight, so it finishes
    // normally; no mid-item cancel call for A.
    h.completeAgent(itemA.agentId!, engineerReportOutput('did A'));
    await flushMicrotasks();

    expect(itemA.state).toBe('passed');
    expect(h.cancelCalls.find((c) => c.id === itemA.agentId)).toBeUndefined();

    // B's claim is now refused — never spawned.
    expect(itemB.state).toBe('blocked-budget');
    expect(h.spawnedTasks.length).toBe(1);
  });

  test('engine.updateBudget raises the ceiling and immediately re-ticks the blocked item back into the waiting set — no need to wait on an unrelated sibling', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }],
      budget: { maxTokens: 15 },
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const itemA = ws.items.find((i) => i.id === 'item-a')!;
    const itemB = ws.items.find((i) => i.id === 'item-b')!;

    h.completeAgent(itemA.agentId!, engineerReportOutput('did A'));
    await flushMicrotasks();
    expect(itemA.state).toBe('passed');
    expect(itemB.state).toBe('blocked-budget');
    expect(itemB.blockedReason).toBeDefined();
    expect(h.spawnedTasks.length).toBe(1);

    // Raise the ceiling well above the workstream's current usage.
    const updated = engine.updateBudget(ws.id, { maxTokens: 1000 });
    expect(updated).toBe(true);

    // updateBudget's internal tick() runs synchronously up to (but not past)
    // runPhase's first genuine await, so the reclaim is already visible
    // without waiting on any sibling or an extra flush.
    expect(itemB.state).toBe('in-phase');
    expect(itemB.blockedReason).toBeUndefined();
    expect(h.spawnedTasks.length).toBe(2);

    h.completeAgent(itemB.agentId!, engineerReportOutput('did B'));
    await flushMicrotasks();
    expect(itemB.state).toBe('passed');
  });

  test('clearing the budget entirely (undefined) also unblocks', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }],
      budget: { maxTokens: 15 },
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const itemA = ws.items.find((i) => i.id === 'item-a')!;
    const itemB = ws.items.find((i) => i.id === 'item-b')!;
    h.completeAgent(itemA.agentId!, engineerReportOutput('did A'));
    await flushMicrotasks();
    expect(itemB.state).toBe('blocked-budget');

    engine.updateBudget(ws.id, undefined);
    expect(itemB.state).toBe('in-phase');
    expect(ws.budget).toBeUndefined();
  });

  test('updateBudget on an unknown workstream id is a no-op refusal', () => {
    const engine = h.makeEngine();
    expect(engine.updateBudget('no-such-workstream', undefined)).toBe(false);
  });
});

describe('cancellation', () => {
  test('engine.kill aborts the target item\'s agent via AbortSignal and AgentManager.cancel; a sibling item is unaffected', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [{ ...enginePhase(), capacity: 2 }],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();

    const itemA = ws.items.find((i) => i.id === 'item-a')!;
    const itemB = ws.items.find((i) => i.id === 'item-b')!;
    const agentAId = itemA.agentId!;
    const signal = h.registeredSignals.get(agentAId)!;
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);

    const killed = engine.kill(itemA.id);
    expect(killed).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(h.cancelCalls).toContainEqual({ id: agentAId, kind: 'kill' });
    expect(itemA.state).toBe('failed');

    // The turn-boundary poll eventually fires AGENT_CANCELLED for A — the
    // engine must not clobber the already-terminal state.
    h.cancelAgentEvent(agentAId);
    await flushMicrotasks();
    expect(itemA.state).toBe('failed');

    // B was never touched.
    expect(itemB.state).toBe('in-phase');
    expect(h.cancelCalls.find((c) => c.id === itemB.agentId)).toBeUndefined();
  });

  test('kill() on an already-terminal item is a no-op refusal', () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({ title: 'ws', phases: [], items: [{ title: 'A', task: 'do A' }] });
    expect(ws.items[0]!.state).toBe('passed'); // zero phases -> immediately terminal
    expect(engine.kill(ws.items[0]!.id)).toBe(false);
  });
});

describe('primitive reuse', () => {
  test('phantom-work guard fails the gate when claimed files do not exist and there is no git diff', async () => {
    const engine = h.makeEngine({ skipClaimVerification: false });
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('claims work', { filesCreated: ['does-not-exist.ts'] }));
    await flushMicrotasks();

    expect(item.state).toBe('failed');
    const results = engine.getPhaseResults(ws.id);
    expect(results[0]!.gate.passed).toBe(false);
    expect(results[0]!.gate.results.some((r) => r.gate === 'phantom-work-guard')).toBe(true);
    // A failing gate must never commit.
    expect(h.commitCalls.length).toBe(0);
  });

  test('a passing gate commits with the phase\'s scoped touched-paths', async () => {
    writeFileSync(join(projectRoot, 'real-file.ts'), 'export const x = 1;\n');
    const engine = h.makeEngine({ skipClaimVerification: false });
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did real work', { filesCreated: ['real-file.ts'] }));
    await flushMicrotasks();

    expect(item.state).toBe('passed');
    expect(h.commitCalls.length).toBe(1);
    expect(h.commitCalls[0]!.paths).toEqual(['real-file.ts']);
    expect(h.mergeCalls).toContain(item.agentId!);
  });

  test('commitScope "off" never commits even on a passing gate', async () => {
    writeFileSync(join(projectRoot, 'real-file.ts'), 'export const x = 1;\n');
    h.configOverrides.commitScope = 'off';
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [{ role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'off', gates: [] } }],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did real work', { filesCreated: ['real-file.ts'] }));
    await flushMicrotasks();

    expect(item.state).toBe('passed');
    expect(h.commitCalls.length).toBe(0);
  });
});

describe('dual-outcome: post-gate bookkeeping never contradicts a passed phase', () => {
  /** A worktree whose commit always throws with the given error — exercises the post-gate commit-failure paths. */
  function throwingWorktree(error: Error): () => WrfcWorktreeOps {
    return () => ({
      merge: async () => true,
      cleanup: async () => { /* no-op */ },
      commitWorkingTree: async () => { throw error; },
      currentHead: async () => null,
    });
  }

  test('passing gate + non-negating commit failure → item PASSED with a warning (commit landed-or-not is stated, never a flip to failed)', async () => {
    const engine = h.makeEngine({ createWorktree: throwingWorktree(new Error('pre-commit hook rejected the change')) });
    const events: OrchestrationEvent[] = [];
    engine.on((e) => events.push(e));
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did work', { filesCreated: ['f.ts'] }));
    await flushMicrotasks();

    // The phase passed; the item is passed — NOT failed — with the commit miss surfaced as a warning.
    expect(item.state).toBe('passed');
    expect(item.failureReason).toBeUndefined();
    expect(item.warnings?.some((w) => w.includes('commit did not complete'))).toBe(true);

    // The item-passed event carries the split honestly.
    const passed = events.find((e): e is Extract<OrchestrationEvent, { type: 'item-passed' }> => e.type === 'item-passed')!;
    expect(passed.warnings?.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'item-failed')).toBe(false);

    // The recorded PhaseResult shows a PASSED gate AND an explicit failed (non-negating) commit —
    // the contradictory "failed item, all phases passed" state is unrepresentable.
    const result = engine.getPhaseResults(ws.id)[0]!;
    expect(result.gate.passed).toBe(true);
    expect(result.commit?.status).toBe('failed');
    expect(result.commit?.negating).toBeFalsy();
  });

  test('passing gate + NEGATING commit failure (workspace corruption) → item FAILED honestly, reason names the negation', async () => {
    const engine = h.makeEngine({ createWorktree: throwingWorktree(new Error("fatal: Unable to create '/repo/.git/index.lock': File exists")) });
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did work', { filesCreated: ['f.ts'] }));
    await flushMicrotasks();

    expect(item.state).toBe('failed');
    expect(item.failureReason).toMatch(/workspace was left unrecorded\/corrupted/i);
    const result = engine.getPhaseResults(ws.id)[0]!;
    expect(result.gate.passed).toBe(true);       // the gate DID pass ...
    expect(result.commit?.status).toBe('failed'); // ... but the workspace was corrupted, so the pass can't be trusted
    expect(result.commit?.negating).toBe(true);
  });

  test('a successful scoped commit records status "committed" with the landed hash', async () => {
    const engine = h.makeEngine(); // harness worktree returns { hash: 'commit-hash', skippedIgnored: [] }
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did work', { filesCreated: ['f.ts'] }));
    await flushMicrotasks();

    expect(item.state).toBe('passed');
    expect(item.warnings ?? []).toEqual([]);
    const result = engine.getPhaseResults(ws.id)[0]!;
    expect(result.commit?.status).toBe('committed');
    expect(result.commit?.hash).toBe('commit-hash');
  });

  test('a genuine gate failure still fails the item (the split is real in both directions)', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase(), reviewPhase(1)],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();
    const item = ws.items[0]!;
    h.completeAgent(item.agentId!, engineerReportOutput('did work', { filesCreated: ['f.ts'] }));
    await flushMicrotasks();
    // Reviewer does NOT pass and reports no unsatisfied constraint findings -> terminal gate failure.
    h.completeAgent(item.agentId!, reviewerReportOutput(2, false));
    await flushMicrotasks();

    expect(item.state).toBe('failed');
    const results = engine.getPhaseResults(ws.id);
    // The failing phase records gate.passed === false — so "all phases passed" never holds for a failed item.
    expect(results.some((r) => r.gate.passed === false)).toBe(true);
  });

  test('usage rollup is MONOTONE in presence across a usage event stream WITH GAPS (engine fold)', () => {
    // Model the engine folding each completed phase's usage into item.usage
    // (mergeWorkItemUsage). Some phases report empty usage (a gap — no usage
    // event landed); assert presence, once real, never regresses to n/a.
    const gap = emptyWorkItemUsage();
    const real = (cost: number): ReturnType<typeof emptyWorkItemUsage> => ({
      ...emptyWorkItemUsage(), inputTokens: 10, outputTokens: 5, llmCallCount: 1, turnCount: 1, costUsd: cost, costState: 'priced',
    });
    const stream = [gap, real(0.1), gap, gap, real(0.2)];
    let acc = emptyWorkItemUsage();
    let everPresent = false;
    for (const ev of stream) {
      acc = mergeWorkItemUsage(acc, ev);
      const present = acc.inputTokens > 0 || acc.costUsd !== null;
      if (everPresent) expect(present).toBe(true); // never regress once present
      everPresent = everPresent || present;
    }
    expect(acc.inputTokens).toBe(20);
    expect(acc.costUsd).toBeCloseTo(0.3, 6);
    expect(acc.costState).not.toBe('unpriced');
  });
});

describe('resume prefix replay', () => {
  test('a completed phase in the imported snapshot is never re-spawned; only the uncompleted tail spawns', async () => {
    const engine = h.makeEngine();
    const seed = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase(), reviewPhase(1)],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    const [engPhase, revPhase] = seed.phases;
    const item = seed.items[0]!;
    // Simulate phase 1 already completed before a crash: item is already
    // routed to phase 2, and a PhaseResult for phase 1 exists.
    item.currentPhaseId = revPhase!.id;
    item.state = 'awaiting-capacity';
    item.visits.set(engPhase!.id, 1);
    item.usage = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1, costUsd: null, costState: 'unpriced' };

    const snapshotJson = engine.serializeWorkstream(seed.id);
    expect(snapshotJson).not.toBeNull();

    // Fresh engine/AgentManager instance — the "restart" — imports and
    // resumes purely from the snapshot JSON.
    const freshHarness = makeHarness(projectRoot);
    const freshEngine = freshHarness.makeEngine();
    const imported = freshEngine.importWorkstream(snapshotJson!);
    expect(imported).toBe(true);
    freshEngine.start(seed.id);
    await flushMicrotasks();

    // Only ONE spawn — for phase 2 (review). Phase 1 is never re-spawned.
    expect(freshHarness.spawnedTasks.length).toBe(1);
    const resumed = freshEngine.getWorkstream(seed.id)!;
    const resumedItem = resumed.items[0]!;
    expect(resumedItem.currentPhaseId).toBe(revPhase!.id);
    expect(resumedItem.state).toBe('in-phase');
  });

  test('a corrupt snapshot is quarantined, not crashed', () => {
    const dir = join(projectRoot, '.goodvibes', 'orchestration');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'ws-corrupt.json');
    writeFileSync(path, '{ this is not valid json');

    expect(() => loadWorkstreamSnapshot(projectRoot, 'ws-corrupt')).not.toThrow();
    const snapshot = loadWorkstreamSnapshot(projectRoot, 'ws-corrupt');
    expect(snapshot).toBeNull();
    // Original path is gone; quarantined alongside it.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('a future schemaVersion is rejected (fail closed)', () => {
    const dir = join(projectRoot, '.goodvibes', 'orchestration');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'ws-future.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 999, writtenAt: Date.now(), workstream: {}, completedResults: [] }));
    const snapshot = loadWorkstreamSnapshot(projectRoot, 'ws-future');
    expect(snapshot).toBeNull();
  });
});

describe('resume reconciliation — the exact restart-mid-phase blocker', () => {
  test('an item persisted in-phase (agent running when the process died) is re-queued as pending on import, unstarves its capacity-1 sibling, and the workstream reaches terminal', async () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase()], // capacity 1, single phase — a clean gate passes an item immediately.
      items: [{ id: 'item-a', title: 'A', task: 'do A' }, { id: 'item-b', title: 'B', task: 'do B' }],
    });
    engine.start(ws.id);
    await flushMicrotasks();

    const itemA = ws.items.find((i) => i.id === 'item-a')!;
    const itemB = ws.items.find((i) => i.id === 'item-b')!;
    // Capacity 1: only A claims the single phase slot; B is left pending,
    // still waiting for that same slot.
    expect(itemA.state).toBe('in-phase');
    expect(itemA.agentId).toBeDefined();
    expect(itemB.state).toBe('pending');

    // Simulate a crash: A's agent never completes. Snapshot the workstream
    // exactly as the debounced persistence writer (persistence.ts,
    // attachDebouncedWriter) would have captured it mid-claim — A still
    // 'in-phase'.
    const snapshotJson = engine.serializeWorkstream(ws.id);
    expect(snapshotJson).not.toBeNull();
    const rawSnapshot = JSON.parse(snapshotJson!) as { workstream: { items: Array<{ id: string; state: string }> } };
    expect(rawSnapshot.workstream.items.find((i) => i.id === 'item-a')!.state).toBe('in-phase');

    // Fresh engine/AgentManager instance — the "restart" — imports purely
    // from the crash snapshot. Attach a listener BEFORE import to observe
    // the requeue being stamped as an event (not just a silent state flip).
    const freshHarness = makeHarness(projectRoot);
    const freshEngine = freshHarness.makeEngine();
    const requeuedEvents: Array<{ itemId: string; reason: string }> = [];
    freshEngine.on((event) => {
      if (event.type === 'item-requeued') requeuedEvents.push({ itemId: event.itemId, reason: event.reason });
    });

    const imported = freshEngine.importWorkstream(snapshotJson!);
    expect(imported).toBe(true);
    expect(requeuedEvents.length).toBe(1);
    expect(requeuedEvents[0]!.itemId).toBe('item-a');
    expect(requeuedEvents[0]!.reason).toContain('re-queued');

    freshEngine.start(ws.id);
    await flushMicrotasks();

    const resumed = freshEngine.getWorkstream(ws.id)!;
    const resumedA = resumed.items.find((i) => i.id === 'item-a')!;
    const resumedB = resumed.items.find((i) => i.id === 'item-b')!;

    // THE BLOCKER: without reconciliation, A stays 'in-phase' forever — a
    // phantom OCCUPIED capacity-1 slot with no live agent behind it (the old
    // agent belonged to a harness/AgentManager instance that no longer
    // exists) — so nothing ever spawns on the fresh engine and neither item
    // can ever complete. This assertion is the one that fails against
    // unfixed code (0 spawns instead of 1).
    expect(freshHarness.spawnedTasks.length).toBe(1);
    expect(resumedA.state).toBe('in-phase');
    expect(resumedA.agentId).toBeDefined();
    // A genuinely NEW agent record, not a phantom carried over from the dead
    // process — it lives in the FRESH harness's own agent store (a stale
    // agentId string surviving deserialization verbatim, as the unfixed code
    // does, would not resolve here at all).
    expect(freshHarness.agentStore.get(resumedA.agentId!)?.status).toBe('running');
    expect(resumedB.state).toBe('pending'); // unstarved: still eligible, just waiting its turn

    // Complete the re-spawned A -> passes (single phase, no review) -> frees
    // the slot for B, which claims it immediately (same reactive scheduler
    // as every other test in this file).
    freshHarness.completeAgent(resumedA.agentId!, engineerReportOutput('did A (resumed)'));
    await flushMicrotasks();
    expect(resumedA.state).toBe('passed');
    expect(resumedB.state).toBe('in-phase');
    expect(resumedB.agentId).toBeDefined();

    freshHarness.completeAgent(resumedB.agentId!, engineerReportOutput('did B'));
    await flushMicrotasks();
    expect(resumedB.state).toBe('passed');

    // The workstream reaches terminal — the entire point of the fix.
    expect(resumed.items.every((i) => i.state === 'passed' || i.state === 'failed')).toBe(true);
  });

  test('importWorkstream is idempotent about reconciliation: an item already pending/awaiting-capacity/terminal in the snapshot is left untouched', () => {
    const engine = h.makeEngine();
    const ws = engine.createWorkstream({
      title: 'ws',
      phases: [enginePhase(), reviewPhase(1)],
      items: [{ id: 'item-a', title: 'A', task: 'do A' }],
    });
    const [engPhase, revPhase] = ws.phases;
    const item = ws.items[0]!;
    item.currentPhaseId = revPhase!.id;
    item.state = 'awaiting-capacity';
    item.visits.set(engPhase!.id, 1);

    const snapshotJson = engine.serializeWorkstream(ws.id);
    const freshEngine = makeHarness(projectRoot).makeEngine();
    const events: string[] = [];
    freshEngine.on((event) => events.push(event.type));
    expect(freshEngine.importWorkstream(snapshotJson!)).toBe(true);
    expect(events).not.toContain('item-requeued');
    expect(freshEngine.getWorkstream(ws.id)!.items[0]!.state).toBe('awaiting-capacity');
  });
});

describe('controller-compat', () => {
  test('fromChainSpec produces a canned engineer -> review two-phase workstream', () => {
    const configManager = {
      get: () => undefined,
      getCategory: () => ({ commitScope: 'scoped' }),
    };
    const spec = fromChainSpec({ id: 'owner-1', task: 'implement the thing' }, configManager);
    expect(spec.items).toHaveLength(1);
    expect(spec.items[0]!.task).toBe('implement the thing');
    expect(spec.phases).toHaveLength(2);
    expect(spec.phases[0]!.kind).toBe('engineer');
    expect(spec.phases[1]!.kind).toBe('review');

    const engine = h.makeEngine();
    const ws = engine.createWorkstream(spec);
    expect(ws.phases[0]!.ordinal).toBeLessThan(ws.phases[1]!.ordinal);
    expect(ws.items[0]!.currentPhaseId).toBe(ws.phases[0]!.id);
  });
});
