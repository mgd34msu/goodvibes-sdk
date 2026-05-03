/**
 * Phase 5: Constraint-propagation integration tests.
 *
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
  const engineerRecord = h.addAgent('eng-seed', 'seed task');
  const chain = h.controller.createChain(engineerRecord);

  h.setOutput('eng-seed', engineerOutput(constraints));
  emitAgentCompleted(h.bus, 'eng-seed');
  await flushMicrotasks(20);

  const reviewerAgentId = () => h.spawnedRecords[0]?.id ?? '';
  return { h, chain, engineerAgentId: 'eng-seed', reviewerAgentId };
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
    expect(enumerated).toBeDefined();
    const data = eventData(enumerated!);
    const emittedConstraints = data['constraints'] as Constraint[];
    expect(emittedConstraints).toHaveLength(2);
    expect(emittedConstraints.map((c) => c.id)).toContain('c1');
    expect(emittedConstraints.map((c) => c.id)).toContain('c2');

    // Reviewer should have been spawned (chain in reviewing)
    expect(chain.state).toBe('reviewing');
    expect(h.spawnedRecords.length).toBe(1);

    // The reviewer task should contain the constraint section
    const reviewerTask = h.spawnedRecords[0]!.task;
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
    expect(reviewEvent).toBeDefined();
    expect(eventData(reviewEvent!)['passed']).toBe(false);

    // The fixer agent task should contain SATISFIED and UNSATISFIED markers
    const fixerRecord = h.spawnedRecords[1]; // [0] = reviewer, [1] = fixer
    expect(fixerRecord).toBeDefined();
    const fixerTask = fixerRecord!.task;
    expect(fixerTask).toContain('c1 [SATISFIED]');
    expect(fixerTask).toContain('c2 [UNSATISFIED]');
    expect(fixerTask).toContain('Constraint preservation during fix');

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
    const fixerRecord = h.spawnedRecords[1]!;

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

    const fixerRecord = h.spawnedRecords[1]!;
    // Fixer only returns c1, drops c2
    h.setOutput(fixerRecord.id, engineerOutput([{ id: 'c1', text: 'must be pure', source: 'prompt' }]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // syntheticIssues is cleared into the reviewer2 task during startReview;
    // verify it was injected by checking the reviewer2 task content.
    const reviewer2Record = h.spawnedRecords[2];
    expect(reviewer2Record).toBeDefined();
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

    const fixerRecord = h.spawnedRecords[1]!;
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
    const reviewer2Record = h.spawnedRecords[2];
    expect(reviewer2Record).toBeDefined();
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

    const fixerRecord = h.spawnedRecords[1]!;
    // Fixer drops c2 → inject synthetic issue
    h.setOutput(fixerRecord.id, engineerOutput([{ id: 'c1', text: 'must be pure', source: 'prompt' }]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    // The second reviewer's task should be prepended with synthetic issue block
    const reviewer2Record = h.spawnedRecords[2];
    expect(reviewer2Record).toBeDefined();
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

    const reviewerRecord = h.spawnedRecords[0]!;
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
    const fixerRecord = h.spawnedRecords[1]!;
    const fixerTask = fixerRecord.task;

    expect(fixerTask).not.toContain('## Constraints (authoritative');
    expect(fixerTask).not.toContain('Constraint preservation during fix');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A9: Gate-retry inheritance — immediate (followUpChain path)
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

describe('A9: Gate-retry inheritance — immediate (followUpChain)', () => {
  test('child chain inherits constraints with source:inherited, constraintsEnumerated:true', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a9');

    const parentConstraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];

    const engRecord = makeRecord({ id: 'eng-gate-a9', task: 'gated task' });
    agentStore.set('eng-gate-a9', engRecord);
    const parentChain = controller.createChain(engRecord);

    engRecord.fullOutput = engineerOutput(parentConstraints);
    emitAgentCompleted(bus, 'eng-gate-a9');
    await flushMicrotasks(20);

    // Reviewer spawned
    const reviewerRecord = spawnedRecords[0]!;
    reviewerRecord.fullOutput = reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c2', satisfied: true, evidence: 'no external deps' },
    ]);

    // Wait for WORKFLOW_CHAIN_PASSED (gate processing is async — runs real subprocess)
    const passedPromise = waitForEvent(bus, 'WORKFLOW_CHAIN_PASSED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await passedPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('passed');

    // The gate fail spawned a follow-up agent; register it as a chain so we can inspect it.
    // (The controller spawns the agent but only registers a chain when createChain is called externally.)
    const followUpRecord = spawnedRecords[1];
    expect(followUpRecord).toBeDefined();
    const followUpChain = controller.createChain(followUpRecord!);
    await flushMicrotasks(20);

    // Inherited constraints: source flipped to 'inherited', id/text preserved
    expect(followUpChain.constraintsEnumerated).toBe(true);
    expect(followUpChain.constraints).toHaveLength(2);
    expect(followUpChain.constraints[0]?.source).toBe('inherited');
    expect(followUpChain.constraints[1]?.source).toBe('inherited');
    expect(followUpChain.constraints[0]?.id).toBe('c1');
    expect(followUpChain.constraints[1]?.id).toBe('c2');
    expect(followUpChain.constraints[0]?.text).toBe('must be pure');
    expect(followUpChain.constraints[1]?.text).toBe('no deps');

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A10: Gate-retry inheritance — pending path
// ---------------------------------------------------------------------------

describe('A10: Gate-retry inheritance — pending path', () => {
  test('child chain receives inherited constraints via attachPendingParentChain', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a10');

    const parentConstraints: Constraint[] = [
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ];

    const engRecord = makeRecord({ id: 'eng-pend-a10', task: 'pending path task' });
    agentStore.set('eng-pend-a10', engRecord);
    const parentChain = controller.createChain(engRecord);

    engRecord.fullOutput = engineerOutput(parentConstraints);
    emitAgentCompleted(bus, 'eng-pend-a10');
    await flushMicrotasks(20);

    const reviewerRecord = spawnedRecords[0]!;
    reviewerRecord.fullOutput = reviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure' },
      { constraintId: 'c2', satisfied: true, evidence: 'no deps' },
    ]);

    const passedPromise = waitForEvent(bus, 'WORKFLOW_CHAIN_PASSED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await passedPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('passed');

    // The gate fail spawned a follow-up agent via the pending path; register it as a chain.
    // (The controller queues parentChainId + constraints for the agent, applied on createChain.)
    const followUpRecord = spawnedRecords[1];
    expect(followUpRecord).toBeDefined();
    const childChain = controller.createChain(followUpRecord!);
    await flushMicrotasks(20);

    // Child should have inherited constraints applied via attachPendingParentChain
    expect(childChain.constraints).toHaveLength(2);
    expect(childChain.constraints.every((c) => c.source === 'inherited')).toBe(true);
    expect(childChain.constraintsEnumerated).toBe(true);
    expect(childChain.parentChainId).toBe(parentChain.id);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// A11: Zero-constraint gate-retry
// ---------------------------------------------------------------------------

describe('A11: Zero-constraint gate-retry', () => {
  test('parent with empty constraints → child has empty constraints, constraintsEnumerated:false', async () => {
    const { bus, controller, agentStore, spawnedRecords } = createGateHarness('always-fail-a11');

    const engRecord = makeRecord({ id: 'eng-zero-a11', task: 'unconstrained task' });
    agentStore.set('eng-zero-a11', engRecord);
    const parentChain = controller.createChain(engRecord);

    engRecord.fullOutput = engineerOutput([]);
    emitAgentCompleted(bus, 'eng-zero-a11');
    await flushMicrotasks(20);

    const reviewerRecord = spawnedRecords[0]!;
    reviewerRecord.fullOutput = reviewerOutput(10.0, []);

    const passedPromise = waitForEvent(bus, 'WORKFLOW_CHAIN_PASSED');
    emitAgentCompleted(bus, reviewerRecord.id);
    await passedPromise;
    await flushMicrotasks(20);

    expect(parentChain.state).toBe('passed');

    // Register the follow-up agent as a chain to inspect constraint inheritance.
    const followUpRecord = spawnedRecords[1];
    expect(followUpRecord).toBeDefined();
    const childChain = controller.createChain(followUpRecord!);
    await flushMicrotasks(20);

    // Zero-constraint parent: child has empty constraints and constraintsEnumerated:false
    // (pending path only sets constraintsEnumerated:true when inherited.length > 0)
    expect(childChain.constraints).toHaveLength(0);
    expect(childChain.constraintsEnumerated).toBe(false);

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
    expect(reviewEvent).toBeDefined();
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
    expect(reviewEvent).toBeDefined();
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
    expect(reviewEvent).toBeDefined();
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
    expect(reviewEvent).toBeDefined();
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
    expect(reviewEvent).toBeDefined();
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
    expect(reviewEvent).toBeDefined();
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

    const fixerRecord = h.spawnedRecords[1]!;
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
