/**
 * Tests every propagation path, every guard, and every no-op through the
 * WrfcController without spinning up a real LLM. Constraints are injected via
 * structured EngineerReport / ReviewerReport JSON blocks in agent fullOutput,
 * exactly as the production parseEngineerCompletionReport / parseReviewerCompletionReport
 * parsers expect.
 *
 * Key encoding: wrap JSON in ```json\n...\n``` so parseCompletionReport's
 * strategy-1 path picks it up reliably.
 *
 * NOTE on RuntimeEventEnvelope structure:
 *   createEventEnvelope produces: { type, ts, traceId, sessionId, source, payload }
 *   where payload = the typed event object.
 *   So to read event data: envelope.payload.fieldName
 *   In tests we store the envelope as `payload`, so access is: event.payload['payload']['field']
 */

import { describe, expect, test } from 'bun:test';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';
import type { Constraint, EngineerReport, ReviewerReport, ConstraintFinding } from '../packages/sdk/src/platform/agents/completion-report.js';

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Wrap a JSON object in a ```json block so parseCompletionReport picks it up. */
function jsonBlock(obj: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

/** Encode a minimal EngineerReport as fullOutput text. */
function engineerOutput(
  constraints: Constraint[],
  overrides: Partial<EngineerReport> = {},
): string {
  const report: Record<string, unknown> = {
    version: 1,
    archetype: 'engineer',
    summary: 'Test engineer output',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [],
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
    constraints,
    ...overrides,
  };
  return jsonBlock(report);
}

/** Encode a minimal ReviewerReport as fullOutput text. */
function reviewerOutput(
  score: number,
  findings: ConstraintFinding[],
  overrides: Partial<ReviewerReport> = {},
): string {
  const report: Record<string, unknown> = {
    version: 1,
    archetype: 'reviewer',
    summary: 'Test reviewer output',
    score,
    passed: score >= 9.9,
    dimensions: [],
    issues: [],
    constraintFindings: findings,
    ...overrides,
  };
  return jsonBlock(report);
}

/** Get the inner payload data from a stored workflow event. */
function eventData(event: { type: string; payload: Record<string, unknown> }): Record<string, unknown> {
  return event.payload['payload'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Harness (same pattern as wrfc-controller.test.ts)
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AgentRecord> & { id: string; task: string }): AgentRecord {
  return {
    id: overrides.id,
    task: overrides.task,
    template: overrides.template ?? 'engineer',
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

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Harness {
  bus: RuntimeEventBus;
  controller: WrfcController;
  agentStore: Map<string, AgentRecord>;
  spawnedRecords: AgentRecord[];
  workflowEvents: Array<{ type: string; payload: Record<string, unknown> }>;
  setOutput(agentId: string, fullOutput: string): void;
  addAgent(id: string, task: string, template?: string): AgentRecord;
}

function latestSpawnedByWrfcRole(records: AgentRecord[], role: NonNullable<AgentRecord['wrfcRole']>): AgentRecord {
  const record = records.filter((candidate) => candidate.wrfcRole === role).at(-1);
  if (!record) throw new Error(`Expected spawned WRFC ${role} agent`);
  return record;
}

function createHarness(opts?: {
  scoreThreshold?: number;
  maxFixAttempts?: number;
}): Harness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

  bus.onDomain('workflows', (envelope) => {
    workflowEvents.push({
      type: envelope.type,
      payload: envelope as unknown as Record<string, unknown>,
    });
  });

  const threshold = opts?.scoreThreshold ?? 9.9;
  const maxFixAttempts = opts?.maxFixAttempts ?? 3;

  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return threshold;
      if (key === 'wrfc.maxFixAttempts') return maxFixAttempts;
      if (key === 'wrfc.autoCommit') return false;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'wrfc') {
        return {
          scoreThreshold: threshold,
          maxFixAttempts,
          autoCommit: false,
          gates: [] as Array<{ name: string; command: string; enabled: boolean }>,
        };
      }
      return undefined;
    },
  };

  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-${spawnedRecords.length + 1}`;
      const record = makeRecord({
        id,
        task: (input as { task?: string }).task ?? 'spawned-task',
        template: (input as { template?: string }).template ?? 'engineer',
        parentAgentId: (input as { parentAgentId?: string }).parentAgentId,
        status: 'running',
      });
      agentStore.set(id, record);
      spawnedRecords.push(record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: (_id: string) => false,
    listByCohort: (_cohort: string) => [],
    clear: () => { agentStore.clear(); },
  };

  const messageBus = { registerAgent: (_opts: unknown) => {} };

  const controller = new WrfcController(bus, messageBus, {
    agentManager,
    configManager,
    projectRoot: '/tmp/test-propagation',
    createWorktree: () => ({
      merge: async (_agentId: string) => true,
      cleanup: async (_agentId: string) => {},
    }),
  });

  const addAgent = (id: string, task: string, template = 'engineer'): AgentRecord => {
    const record = makeRecord({ id, task, template });
    agentStore.set(id, record);
    return record;
  };

  const setOutput = (agentId: string, fullOutput: string): void => {
    const record = agentStore.get(agentId);
    if (record) record.fullOutput = fullOutput;
  };

  return { bus, controller, agentStore, spawnedRecords, workflowEvents, setOutput, addAgent };
}

function emitAgentCompleted(bus: RuntimeEventBus, agentId: string): void {
  bus.emit(
    'agents',
    createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ),
  );
}

// ---------------------------------------------------------------------------
// Helper: seed a chain that has already captured constraints
// (engineer completed + constraints captured, now in reviewing state)
// ---------------------------------------------------------------------------

interface SeededChain {
  h: Harness;
  chain: ReturnType<WrfcController['createChain']>;
  engineerAgentId: string;
  reviewerAgentId: () => string;
}

async function seedChainWithConstraints(
  constraints: Constraint[],
  opts?: { scoreThreshold?: number; maxFixAttempts?: number },
): Promise<SeededChain> {
  const h = createHarness(opts);
  const ownerRecord = h.addAgent('owner-seed', 'seed task');
  const chain = h.controller.createChain(ownerRecord);

  h.setOutput(chain.engineerAgentId!, engineerOutput(constraints));
  emitAgentCompleted(h.bus, chain.engineerAgentId!);
  await flushMicrotasks(20);

  const reviewerAgentId = () => latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer').id;
  return { h, chain, engineerAgentId: chain.engineerAgentId!, reviewerAgentId };
}

// ---------------------------------------------------------------------------
// A1: Engineer → review propagation
// ---------------------------------------------------------------------------

describe('A1: Engineer → review propagation', () => {
  test('constraints captured from engineer report and appear in review task', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain } = await seedChainWithConstraints(constraints);

    // Chain constraints should match exactly
    expect(chain.constraints).toHaveLength(2);
    expect(chain.constraints[0]?.id).toBe('c1');
    expect(chain.constraints[1]?.id).toBe('c2');
    expect(chain.constraintsEnumerated).toBe(true);

    // WORKFLOW_CONSTRAINTS_ENUMERATED should have been emitted
    const enumerated = h.workflowEvents.find((e) => e.type === 'WORKFLOW_CONSTRAINTS_ENUMERATED');
    expect(enumerated?.type).toBe('WORKFLOW_CONSTRAINTS_ENUMERATED');
    const data = eventData(enumerated!);
    const emittedConstraints = data['constraints'] as Constraint[];
    expect(emittedConstraints).toHaveLength(2);
    expect(emittedConstraints.map((c) => c.id)).toContain('c1');
    expect(emittedConstraints.map((c) => c.id)).toContain('c2');

    // Reviewer should have been spawned (chain in reviewing)
    expect(chain.state).toBe('reviewing');
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer')).toHaveLength(1);

    // The reviewer task should contain the constraint section
    const reviewerTask = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer').task;
    expect(reviewerTask).toContain('## Constraints to verify');
    expect(reviewerTask).toContain('c1');
    expect(reviewerTask).toContain('c2');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A2: Review → fix propagation with markers
// ---------------------------------------------------------------------------

describe('A2: Review → fix propagation with markers', () => {
  test('unsatisfied constraint forces hard-fail despite score >= threshold, SATISFIED/UNSATISFIED markers in fix task', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    const findings: ConstraintFinding[] = [
      { constraintId: 'c1', satisfied: true, evidence: 'pure function, no side effects' },
      { constraintId: 'c2', satisfied: false, evidence: 'imports lodash', severity: 'major' },
    ];
    h.setOutput(reviewerAgentId(), reviewerOutput(9.95, findings));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    // Hard-fail on unsatisfied constraint even though score >= 9.9 threshold
    expect(chain.state).toBe('fixing');

    // The WORKFLOW_REVIEW_COMPLETED event should show passed: false
    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(false);

    // The fixer agent task should contain SATISFIED and UNSATISFIED markers
    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    expect(fixerRecord).not.toBeUndefined(); // presence-only: fixer agent was spawned
    const fixerTask = fixerRecord!.task;
    expect(fixerTask).toContain('c1 [SATISFIED]');
    expect(fixerTask).toContain('c2 [UNSATISFIED]');
    expect(fixerTask).toContain('Constraint preservation during fix');

    h.controller.dispose();
  });

  test('missing finding for a known constraint forces fix and is observable', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure function, no side effects' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    expect(chain.state).toBe('fixing');

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    const reviewPayload = eventData(reviewEvent!);
    expect(reviewPayload['passed']).toBe(false);
    expect(reviewPayload['constraintsSatisfied']).toBe(1);
    expect(reviewPayload['constraintsTotal']).toBe(2);
    expect(reviewPayload['unsatisfiedConstraintIds']).toEqual(['c2']);

    const fixEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_FIX_ATTEMPTED');
    expect(fixEvent?.type).toBe('WORKFLOW_FIX_ATTEMPTED');
    expect(eventData(fixEvent!)['targetConstraintIds']).toEqual(['c2']);

    const fixerTask = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer').task;
    expect(fixerTask).toContain('c1 [SATISFIED]');
    expect(fixerTask).toContain('c2 [UNVERIFIED]');

    h.controller.dispose();
  });

  test('unknown constraint findings are ignored with a review issue, not treated as satisfied scope', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ]);

    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c99', satisfied: false, evidence: 'not part of this chain', severity: 'major' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');
    expect(chain.reviewerReport?.issues.some((issue) =>
      issue.description.includes('unknown constraints') && issue.description.includes('c99'),
    )).toBe(true);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(true);
    expect(eventData(reviewEvent!)['constraintsTotal']).toBe(1);

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A3: Fixer continuity enforcement — clean return
// ---------------------------------------------------------------------------

describe('A3: Fixer continuity — clean return', () => {
  test('fixer returns same ids → no synthetic issues injected', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    // Fail review to trigger fixer
    const findings: ConstraintFinding[] = [
      { constraintId: 'c1', satisfied: false, evidence: 'has side effects', severity: 'major' },
      { constraintId: 'c2', satisfied: false, evidence: 'uses lodash', severity: 'major' },
    ];
    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, findings));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    expect(chain.state).toBe('fixing');
    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');

    // Fixer returns same constraint ids — continuity preserved
    h.setOutput(fixerRecord.id, engineerOutput(constraints));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    expect(chain.syntheticIssues ?? []).toHaveLength(0);
    expect(chain.constraints).toHaveLength(2);
    expect(chain.constraints[0]?.id).toBe('c1');
    expect(chain.constraints[1]?.id).toBe('c2');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A4: Fixer continuity — missing id
// ---------------------------------------------------------------------------

describe('A4: Fixer continuity — id missing', () => {
  test('fixer drops c2 → synthetic critical issue injected, authoritative list preserved', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    const findings: ConstraintFinding[] = [
      { constraintId: 'c1', satisfied: false, evidence: 'side effect', severity: 'major' },
      { constraintId: 'c2', satisfied: false, evidence: 'uses lodash', severity: 'major' },
    ];
    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, findings));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    // Fixer only returns c1, drops c2
    h.setOutput(fixerRecord.id, engineerOutput([{ id: 'c1', text: 'must be pure', source: 'prompt' }]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // syntheticIssues is cleared into the reviewer2 task during startReview;
    // verify it was injected by checking the reviewer2 task content.
    const reviewer2Record = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    expect(reviewer2Record).not.toBeUndefined(); // presence-only: array element existence check
    const reviewer2Task = reviewer2Record!.task;
    expect(reviewer2Task).toContain('## Synthetic issues from controller');
    expect(reviewer2Task).toContain('c2');
    expect(reviewer2Task).toContain('[CRITICAL]');

    // Authoritative constraint list unchanged
    expect(chain.constraints).toHaveLength(2);
    expect(chain.constraints.map((c) => c.id)).toContain('c1');
    expect(chain.constraints.map((c) => c.id)).toContain('c2');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A5: Fixer continuity — extra id
// ---------------------------------------------------------------------------

describe('A5: Fixer continuity — id extra', () => {
  test('fixer adds c99 → synthetic critical issue injected, authoritative list unchanged', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    // Fixer invents c99
    h.setOutput(fixerRecord.id, engineerOutput([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
      { id: 'c99', text: 'invented constraint', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // syntheticIssues is cleared into the reviewer2 task during startReview;
    // verify it was injected by checking the reviewer2 task content.
    const reviewer2Record = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    expect(reviewer2Record).not.toBeUndefined(); // presence-only: array element existence check
    const reviewer2Task = reviewer2Record!.task;
    expect(reviewer2Task).toContain('## Synthetic issues from controller');
    expect(reviewer2Task).toContain('c99');
    expect(reviewer2Task).toContain('[CRITICAL]');
    // Authoritative list still has exactly 2
    expect(chain.constraints).toHaveLength(2);
    expect(chain.constraints.map((c) => c.id)).not.toContain('c99');

    h.controller.dispose();
  });
});

describe('A5b: Fixer continuity — no authoritative constraints', () => {
  test('fixer-invented constraints are ignored and not forwarded as synthetic review failures', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([], { maxFixAttempts: 3 });

    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    expect(fixerRecord.task).toContain('Return "constraints": []');
    h.setOutput(fixerRecord.id, engineerOutput([
      { id: 'c1', text: 'invented implementation detail', source: 'prompt' },
      { id: 'c2', text: 'another invented detail', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    const reviewer2Record = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    expect(reviewer2Record.task).not.toContain('## Synthetic issues from controller');
    expect(reviewer2Record.task).not.toContain('Fixer regressed constraint continuity');
    expect(reviewer2Record.task).toContain('"constraints": []');
    expect(reviewer2Record.task).not.toContain('invented implementation detail');
    expect(chain.constraints).toEqual([]);

    h.controller.dispose();
  });
});

describe('A5c: Fixer continuity — malformed constrained fixer report', () => {
  test('non-engineer fixer output creates one synthetic continuity issue for missing authoritative constraints', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    h.setOutput(fixerRecord.id, 'Fixed the issue, but did not return an EngineerReport JSON block.');
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    const reviewer2Record = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    const reviewer2Task = reviewer2Record.task;
    expect(reviewer2Task).toContain('## Synthetic issues from controller');
    expect(reviewer2Task).toContain('missing=[c1,c2] extra=[]');
    expect(reviewer2Task.match(/Fixer regressed constraint continuity/g) ?? []).toHaveLength(1);
    expect(chain.constraints.map((constraint) => constraint.id)).toEqual(['c1', 'c2']);

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A6: Synthetic issue consumption (fire-once)
// ---------------------------------------------------------------------------

describe('A6: Synthetic issue consumption', () => {
  test('synthetic issues prepended to review task then cleared', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    // Fail review → fixer
    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    // Fixer drops c2 → inject synthetic issue
    h.setOutput(fixerRecord.id, engineerOutput([{ id: 'c1', text: 'must be pure', source: 'prompt' }]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // The second reviewer's task should be prepended with synthetic issue block
    const reviewer2Record = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    expect(reviewer2Record).not.toBeUndefined(); // presence-only: array element existence check
    const reviewer2Task = reviewer2Record!.task;
    expect(reviewer2Task).toContain('## Synthetic issues from controller');
    expect(reviewer2Task).toContain('[CRITICAL]');

    // syntheticIssues should be cleared after the review was started
    expect(chain.syntheticIssues ?? []).toHaveLength(0);

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A7: Empty-list no-op — reviewer side
// ---------------------------------------------------------------------------

describe('A7: Empty-list no-op — reviewer side', () => {
  test('constraints:[] → review task has no constraint section', async () => {
    const { h, chain } = await seedChainWithConstraints([]);

    expect(chain.constraints).toHaveLength(0);
    expect(chain.state).toBe('reviewing');

    const reviewerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    const reviewerTask = reviewerRecord.task;

    expect(reviewerTask).not.toContain('## Constraints to verify');
    expect(reviewerTask).not.toContain('Constraint verification (runs alongside the 10-dimension rubric');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A8: Empty-list no-op — fixer side
// ---------------------------------------------------------------------------

describe('A8: Empty-list no-op — fixer side', () => {
  test('constraints:[] → fix task has no constraint section', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([], { maxFixAttempts: 3 });

    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    expect(chain.state).toBe('fixing');
    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    const fixerTask = fixerRecord.task;

    expect(fixerTask).not.toContain('## Constraints (authoritative');
    expect(fixerTask).not.toContain('Constraint preservation during fix');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A9: Gate retry — same-chain fix
// ---------------------------------------------------------------------------

function createGateHarness(gateName: string) {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

  bus.onDomain('workflows', (envelope) => {
    workflowEvents.push({ type: envelope.type, payload: envelope as unknown as Record<string, unknown> });
  });

  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return 9.9;
      if (key === 'wrfc.maxFixAttempts') return 3;
      if (key === 'wrfc.autoCommit') return false;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'wrfc') {
        return {
          scoreThreshold: 9.9,
          maxFixAttempts: 3,
          autoCommit: false,
          gates: [{ name: gateName, command: 'exit 1', enabled: true }],
        };
      }
      return undefined;
    },
  };

  const agentManager: AgentManagerLike = {
    spawn: (input) => {
      const id = `agent-g-${spawnedRecords.length + 1}`;
      const record = makeRecord({
        id,
        task: (input as { task?: string }).task ?? 'spawned-task',
        template: (input as { template?: string }).template ?? 'engineer',
        parentAgentId: (input as { parentAgentId?: string }).parentAgentId,
        status: 'running',
      });
      agentStore.set(id, record);
      spawnedRecords.push(record);
      return record;
    },
    getStatus: (id: string) => agentStore.get(id) ?? null,
    list: () => Array.from(agentStore.values()),
    cancel: () => false,
    listByCohort: () => [],
    clear: () => { agentStore.clear(); },
  };

  const messageBus = { registerAgent: (_opts: unknown) => {} };
  const controller = new WrfcController(bus, messageBus, {
    agentManager,
    configManager,
    projectRoot: '/tmp/test-gate-inh',
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });

  return { bus, controller, agentStore, spawnedRecords, workflowEvents };
}

/** Wait for a specific workflow event type on the bus. */
function waitForEvent(bus: RuntimeEventBus, eventType: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = bus.onDomain('workflows', (envelope) => {
      if (envelope.type === eventType) {
        unsub();
        resolve();
      }
    });
  });
}

describe('A9: Gate retry — same-chain fix', () => {
  test('gate failure keeps owner chain active and sends constraints to the fixer', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a9');

    const parentConstraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];

    const engRecord = makeRecord({ id: 'eng-gate-a9', task: 'gated task' });
    agentStore.set('eng-gate-a9', engRecord);
    const parentChain = controller.createChain(engRecord);

    agentStore.get(parentChain.engineerAgentId!)!.fullOutput = engineerOutput(parentConstraints);
    emitAgentCompleted(bus, parentChain.engineerAgentId!);
    await flushMicrotasks(20);

    // Reviewer spawned
    const reviewerRecord = latestSpawnedByWrfcRole(spawnedRecords, 'reviewer');
    reviewerRecord.fullOutput = reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c2', satisfied: true, evidence: 'no external deps' },
    ]);

    // Wait for WORKFLOW_FIX_ATTEMPTED (gate processing is async — runs real subprocess)
    const fixPromise = waitForEvent(bus, 'WORKFLOW_FIX_ATTEMPTED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await fixPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('fixing');

    const fixerRecord = latestSpawnedByWrfcRole(spawnedRecords, 'fixer');
    expect(fixerRecord.task).toContain('## Constraints to preserve');
    expect(fixerRecord.task).toContain('c1: must be pure');
    expect(fixerRecord.task).toContain('c2: no deps');
    expect(parentChain.constraintsEnumerated).toBe(true);
    expect(parentChain.constraints).toEqual(parentConstraints);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A10: Gate retry does not create child chains
// ---------------------------------------------------------------------------

describe('A10: Gate retry — no child chain', () => {
  test('gate failure does not create a second WRFC chain', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a10');

    const parentConstraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];

    const engRecord = makeRecord({ id: 'eng-pend-a10', task: 'pending path task' });
    agentStore.set('eng-pend-a10', engRecord);
    const parentChain = controller.createChain(engRecord);

    agentStore.get(parentChain.engineerAgentId!)!.fullOutput = engineerOutput(parentConstraints);
    emitAgentCompleted(bus, parentChain.engineerAgentId!);
    await flushMicrotasks(20);

    const reviewerRecord = latestSpawnedByWrfcRole(spawnedRecords, 'reviewer');
    reviewerRecord.fullOutput = reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c2', satisfied: true, evidence: 'no deps' },
    ]);

    const fixPromise = waitForEvent(bus, 'WORKFLOW_FIX_ATTEMPTED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await fixPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('fixing');
    expect(controller.listChains()).toHaveLength(1);
    expect(latestSpawnedByWrfcRole(spawnedRecords, 'fixer').parentAgentId).toBe(parentChain.ownerAgentId);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A11: Zero-constraint gate retry
// ---------------------------------------------------------------------------

describe('A11: Zero-constraint gate retry', () => {
  test('same-chain gate fix omits constraint section when no constraints were enumerated', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a11');

    const engRecord = makeRecord({ id: 'eng-zero-a11', task: 'unconstrained task' });
    agentStore.set('eng-zero-a11', engRecord);
    const parentChain = controller.createChain(engRecord);

    agentStore.get(parentChain.engineerAgentId!)!.fullOutput = engineerOutput([]);
    emitAgentCompleted(bus, parentChain.engineerAgentId!);
    await flushMicrotasks(20);

    const reviewerRecord = latestSpawnedByWrfcRole(spawnedRecords, 'reviewer');
    reviewerRecord.fullOutput = reviewerOutput(10.0, []);

    const fixPromise = waitForEvent(bus, 'WORKFLOW_FIX_ATTEMPTED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await fixPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('fixing');
    expect(parentChain.constraints).toHaveLength(0);
    expect(latestSpawnedByWrfcRole(spawnedRecords, 'fixer').task).not.toContain('## Constraints to preserve');

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A12: Score-vs-constraint conflict matrix (4 cases)
// ---------------------------------------------------------------------------

describe('A12: Score-vs-constraint conflict matrix', () => {
  test('score 10 + all satisfied → passed:true', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ]);
    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(true);
    // No gates configured → chain transitions awaiting_gates → gating → passed immediately
    expect(chain.state).toBe('passed');
    h.controller.dispose();
  });

  test('score 8 + all satisfied → passed:false (score gate)', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ], { maxFixAttempts: 3 });
    h.setOutput(reviewerAgentId(), reviewerOutput(8.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(false);
    expect(chain.state).toBe('fixing');
    h.controller.dispose();
  });

  test('score 10 + one unsatisfied → passed:false (constraint gate)', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ], { maxFixAttempts: 3 });
    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: false, evidence: 'has side effects', severity: 'major' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(false);
    expect(chain.state).toBe('fixing');
    h.controller.dispose();
  });

  test('score 7 + one unsatisfied → passed:false (both gates fail)', async () => {
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ], { maxFixAttempts: 3 });
    h.setOutput(reviewerAgentId(), reviewerOutput(7.0, [
      { constraintId: 'c1', satisfied: false, evidence: 'impure', severity: 'critical' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    expect(eventData(reviewEvent!)['passed']).toBe(false);
    expect(chain.state).toBe('fixing');
    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A13: WORKFLOW_REVIEW_COMPLETED event payload with / without constraints
// ---------------------------------------------------------------------------

describe('A13: WORKFLOW_REVIEW_COMPLETED event payload', () => {
  test('with constraints → event carries constraintsSatisfied, constraintsTotal, unsatisfiedConstraintIds', async () => {
    const { h, reviewerAgentId } = await seedChainWithConstraints([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ], { maxFixAttempts: 3 });
    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c2', satisfied: false, evidence: 'uses lodash', severity: 'major' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    const p = eventData(reviewEvent!);
    expect(p['constraintsSatisfied']).toBe(1);
    expect(p['constraintsTotal']).toBe(2);
    expect(p['unsatisfiedConstraintIds']).toEqual(['c2']);

    h.controller.dispose();
  });

  test('without constraints → event does NOT carry constraint fields', async () => {
    const { h, reviewerAgentId } = await seedChainWithConstraints([]);
    h.setOutput(reviewerAgentId(), reviewerOutput(10.0, []));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    const p = eventData(reviewEvent!);
    expect(p['constraintsSatisfied']).toBeUndefined();
    expect(p['constraintsTotal']).toBeUndefined();
    expect(p['unsatisfiedConstraintIds']).toBeUndefined();

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A14: WORKFLOW_CONSTRAINTS_ENUMERATED emitted exactly once per chain
// ---------------------------------------------------------------------------

describe('A14: WORKFLOW_CONSTRAINTS_ENUMERATED emitted exactly once', () => {
  test('emitted on initial engineer completion, NOT re-emitted on fixer re-runs', async () => {
    const constraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ];
    const { h, chain, reviewerAgentId } = await seedChainWithConstraints(constraints, { maxFixAttempts: 3 });

    const enumeratedCount = () =>
      h.workflowEvents.filter((e) => e.type === 'WORKFLOW_CONSTRAINTS_ENUMERATED').length;

    // After engineer completion: exactly 1 emission
    expect(enumeratedCount()).toBe(1);

    // Fail review → spawn fixer
    h.setOutput(reviewerAgentId(), reviewerOutput(5.0, [
      { constraintId: 'c1', satisfied: false, evidence: 'impure', severity: 'major' },
    ]));
    emitAgentCompleted(h.bus, reviewerAgentId());
    await flushMicrotasks(20);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    // Fixer returns same constraints
    h.setOutput(fixerRecord.id, engineerOutput(constraints));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // Still exactly 1 — fixer re-run does NOT re-emit
    expect(enumeratedCount()).toBe(1);
    expect(chain.constraintsEnumerated).toBe(true);

    h.controller.dispose();
  });
});
