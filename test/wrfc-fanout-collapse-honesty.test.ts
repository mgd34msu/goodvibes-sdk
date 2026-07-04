/**
 * WO UX-A item 1 — batch-collapse guard honesty.
 *
 * When the topology guard collapses a requested multi-agent fan-out into one
 * WRFC owner chain, the parallelism/spawn-count constraints the collapse itself
 * made unsatisfiable must be:
 *   (b) excluded from the review rubric, derived mechanically from the collapse
 *       (only fan-out-shape constraints, only when a collapse actually happened);
 *   (c) un-loopable — never counted as unsatisfied, never able to fail the review,
 *       never entered into the fix-loop target set.
 * And the guard must NOT collapse at all when the user explicitly asked for a
 * parallel fan-out of independent implementation deliverables (explicit intent).
 */

import { describe, expect, test } from 'bun:test';
import {
  evaluateWrfcBatchPolicy,
  isFanoutShapeConstraintText,
  userRequestsParallelFanout,
} from '../packages/sdk/src/platform/tools/agent/wrfc-batch-policy.js';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';
import type { Constraint, ConstraintFinding, EngineerReport, ReviewerReport } from '../packages/sdk/src/platform/agents/completion-report.js';

// --------------------------------------------------------------------------
// Pure detector helpers
// --------------------------------------------------------------------------

describe('fan-out request / constraint-shape detectors', () => {
  test('userRequestsParallelFanout matches explicit parallel/per-unit phrasings, not plain builds', () => {
    expect(userRequestsParallelFanout('spawn a separate subagent per file, in parallel')).toBe(true);
    expect(userRequestsParallelFanout('run one agent per module concurrently')).toBe(true);
    expect(userRequestsParallelFanout('fan out the work across agents')).toBe(true);
    expect(userRequestsParallelFanout('give each file its own agent')).toBe(true);
    // Plain implementation asks must NOT match (would over-suppress the guard).
    expect(userRequestsParallelFanout('build a token bucket rate limiter')).toBe(false);
    expect(userRequestsParallelFanout('review the implementation and fix the bugs')).toBe(false);
    expect(userRequestsParallelFanout(undefined)).toBe(false);
  });

  test('isFanoutShapeConstraintText matches topology constraints, not ordinary ones', () => {
    expect(isFanoutShapeConstraintText('The explicit prompt constraint to spawn a separate subagent per file')).toBe(true);
    expect(isFanoutShapeConstraintText('agents must run in parallel')).toBe(true);
    expect(isFanoutShapeConstraintText('one dedicated agent per deliverable')).toBe(true);
    // Ordinary constraints (the ones a fix agent CAN satisfy) must not be dropped.
    expect(isFanoutShapeConstraintText('the function must be pure with no side effects')).toBe(false);
    expect(isFanoutShapeConstraintText('do not add new dependencies')).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Ruling: explicit parallel fan-out request is honored (not collapsed)
// --------------------------------------------------------------------------

describe('evaluateWrfcBatchPolicy — explicit parallel fan-out ruling', () => {
  test('honors an explicit parallel request for independent implementation deliverables (no collapse)', () => {
    const decision = evaluateWrfcBatchPolicy({
      mode: 'batch-spawn',
      authoritativeTask: 'implement each endpoint as a separate subagent per file, in parallel',
      reviewMode: 'wrfc',
      tasks: [
        { task: 'Implement the users endpoint in users.ts', template: 'engineer' },
        { task: 'Implement the orders endpoint in orders.ts', template: 'engineer' },
        { task: 'Implement the billing endpoint in billing.ts', template: 'engineer' },
      ],
    });
    expect(decision.kind).toBe('independent');
    expect(decision.reason).toContain('explicit parallel fan-out');
  });

  test('still collapses a compound implementation batch when no explicit parallel request is present, and marks the collapse', () => {
    const decision = evaluateWrfcBatchPolicy({
      mode: 'batch-spawn',
      authoritativeTask: 'implement the three endpoints',
      reviewMode: 'wrfc',
      tasks: [
        { task: 'Implement the users endpoint in users.ts', template: 'engineer' },
        { task: 'Implement the orders endpoint in orders.ts', template: 'engineer' },
        { task: 'Implement the billing endpoint in billing.ts', template: 'engineer' },
      ],
    });
    expect(decision.kind).toBe('collapse-to-wrfc');
    expect(decision.ownerInput?.fanoutCollapse?.requestedAgentCount).toBe(3);
  });
});

// --------------------------------------------------------------------------
// Controller: system-unsatisfiable constraint exclusion (parts b + c)
// --------------------------------------------------------------------------

function jsonBlock(obj: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

function engineerOutput(constraints: Constraint[], overrides: Partial<EngineerReport> = {}): string {
  return jsonBlock({
    version: 1, archetype: 'engineer', summary: 'seed', gatheredContext: [], plannedActions: [],
    appliedChanges: [], filesCreated: [], filesModified: [], filesDeleted: [], decisions: [],
    issues: [], uncertainties: [], constraints, ...overrides,
  });
}

function reviewerOutput(score: number, findings: ConstraintFinding[], overrides: Partial<ReviewerReport> = {}): string {
  return jsonBlock({
    version: 1, archetype: 'reviewer', summary: 'review', score, passed: score >= 9.9,
    dimensions: [], issues: [], constraintFindings: findings, ...overrides,
  });
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id, task: overrides.task, template: overrides.template ?? 'engineer', tools: [],
    status: 'running', startedAt: Date.now(), toolCallCount: 0, orchestrationDepth: 0,
    executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only', ...overrides,
  };
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function createHarness() {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string }> = [];
  bus.onDomain('workflows', (envelope) => { workflowEvents.push({ type: envelope.type }); });

  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return 9.9;
      if (key === 'wrfc.maxFixAttempts') return 3;
      if (key === 'wrfc.autoCommit') return false;
      return undefined;
    },
    getCategory: (category: string): unknown =>
      category === 'wrfc' ? { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, gates: [] } : undefined,
  };

  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawnedRecords.length + 1}`;
      const record = makeRecord({
        id,
        task: (input as { task?: string }).task ?? 'spawned',
        template: (input as { template?: string }).template ?? 'engineer',
        status: 'running',
      });
      agentStore.set(id, record);
      spawnedRecords.push(record);
      return record;
    },
    getStatus: (id) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: () => false,
    listByCohort: () => [],
    clear: () => agentStore.clear(),
  };
  const messageBus = { registerAgent: () => {} };
  const controller = new WrfcController(bus, messageBus, {
    agentManager, configManager, projectRoot: '/tmp/test-fanout-collapse',
    skipClaimVerification: true,
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  return { bus, controller, agentStore, spawnedRecords, workflowEvents };
}

function emitAgentCompleted(bus: RuntimeEventBus, agentId: string): void {
  bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', { type: 'AGENT_COMPLETED', agentId, durationMs: 0 }, { sessionId: 'test', traceId: 'test', source: 'test' }));
}

describe('WrfcController — fan-out-collapse system-unsatisfiable constraints', () => {
  test('a fan-out-shape constraint on a collapsed chain is excluded from the rubric and cannot fail the review', async () => {
    const h = createHarness();
    const owner = makeRecord({ id: 'owner-1', task: 'implement three endpoints, one separate agent per file in parallel' });
    owner.fanoutCollapse = { requestedAgentCount: 3, requestedShape: '3 separate agents' };
    const chain = h.controller.createChain(owner);

    const constraints: Constraint[] = [
      { id: 'c1', text: 'The explicit prompt constraint to spawn a separate subagent per file, in parallel', source: 'prompt' },
      { id: 'c2', text: 'each endpoint must validate input server-side', source: 'prompt' },
    ];
    const engineer = h.agentStore.get(chain.engineerAgentId!)!;
    engineer.fullOutput = engineerOutput(constraints);
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    // Part (b): c1 was recognised as system-unsatisfiable and excluded from the rubric.
    expect(chain.systemUnsatisfiableConstraintIds).toEqual(['c1']);
    const reviewerTask = h.spawnedRecords.find((r) => r.template === 'reviewer')!.task;
    // The "Constraints to verify" rubric lists each active constraint as "- <id>: <text>".
    // c2 is listed; the excluded c1 rubric line is absent (its text still appears in the
    // echoed engineer-report digest, which is not the rubric).
    expect(reviewerTask).toContain('- c2: each endpoint must validate input server-side');
    expect(reviewerTask).not.toContain('- c1: The explicit prompt constraint');

    // Reviewer marks the (excluded) c1 unsatisfied AND the real c2 satisfied, score above threshold.
    const reviewerId = h.spawnedRecords.find((r) => r.template === 'reviewer')!.id;
    h.agentStore.get(reviewerId)!.fullOutput = reviewerOutput(10, [
      { constraintId: 'c1', satisfied: false, evidence: 'only one agent ran', severity: 'major' },
      { constraintId: 'c2', satisfied: true, evidence: 'validates server-side' },
    ]);
    emitAgentCompleted(h.bus, reviewerId);
    await flushMicrotasks();

    // Part (c): the chain did NOT enter a fix loop chasing c1 — it advanced past review.
    expect(chain.state).not.toBe('fixing');
    expect(['awaiting_gates', 'gating', 'passed', 'committing']).toContain(chain.state);
    expect(h.spawnedRecords.some((r) => r.wrfcRole === 'fixer')).toBe(false);
    h.controller.dispose();
  });

  test('without a collapse, the same fan-out-shape constraint is NOT dropped and still governs the review', async () => {
    const h = createHarness();
    const owner = makeRecord({ id: 'owner-2', task: 'implement endpoints with agents in parallel' });
    // No fanoutCollapse marker — nothing was collapsed, so nothing is excluded.
    const chain = h.controller.createChain(owner);

    const constraints: Constraint[] = [
      { id: 'c1', text: 'agents must run in parallel', source: 'prompt' },
    ];
    const engineer = h.agentStore.get(chain.engineerAgentId!)!;
    engineer.fullOutput = engineerOutput(constraints);
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    expect(chain.systemUnsatisfiableConstraintIds).toBeUndefined();

    const reviewerId = h.spawnedRecords.find((r) => r.template === 'reviewer')!.id;
    h.agentStore.get(reviewerId)!.fullOutput = reviewerOutput(10, [
      { constraintId: 'c1', satisfied: false, evidence: 'ran serially', severity: 'major' },
    ]);
    emitAgentCompleted(h.bus, reviewerId);
    await flushMicrotasks();

    // The constraint still forces a fix (no blanket drop).
    expect(chain.state).toBe('fixing');
    h.controller.dispose();
  });
});
