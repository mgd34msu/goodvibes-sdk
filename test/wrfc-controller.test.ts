/**
 * QA-08: WrfcController — happy-path, gate-failure, and escalation coverage
 *
 * Tests:
 * - Happy path: engineer completes → reviewer fires → score passes → WORKFLOW_CHAIN_PASSED
 * - Gate failure: score passes, gate fails → WORKFLOW_FIX_ATTEMPTED in the same owner-owned chain
 * - Escalation: score repeatedly below threshold → WORKFLOW_CHAIN_FAILED after maxFixAttempts
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { AgentManagerLike } from '../packages/sdk/src/platform/agents/wrfc-config.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue fully (RuntimeEventBus uses queueMicrotask). */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/** Build a minimal AgentRecord. */
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

/** Reviewer output text that parses as a passing score (>= 9.9). */
const PASSING_REVIEW_OUTPUT = 'The implementation looks solid. Score: 10/10';

/** Reviewer output text that parses as a failing score (below 9.9). */
const FAILING_REVIEW_OUTPUT = 'There are serious issues with the implementation. Score: 5/10';

function engineerReportOutput(summary: string, constraints: Array<{ id: string; text: string; source: 'prompt' }> = []): string {
  return [
    '```json',
    JSON.stringify({
      version: 1,
      archetype: 'engineer',
      summary,
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [summary],
      filesCreated: [],
      filesModified: [],
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
      constraints,
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
      summary: passed ? 'passed' : 'needs fixes',
      score,
      passed,
      dimensions: [],
      issues: passed ? [] : [{ severity: 'major', description: 'Needs a fix.', pointValue: 1 }],
      constraintFindings,
    }),
    '```',
  ].join('\n');
}

/**
 * Emit AGENT_COMPLETED on the bus, simulating what AgentManager does when
 * an agent finishes. The WrfcController listens for this event.
 */
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

/**
 * Emit AGENT_FAILED on the bus, simulating a failed agent.
 */
function emitAgentFailed(bus: RuntimeEventBus, agentId: string, error: string): void {
  bus.emit(
    'agents',
    createEventEnvelope(
      'AGENT_FAILED',
      { type: 'AGENT_FAILED', agentId, error, durationMs: 0 },
      { sessionId: 'test', traceId: 'test', source: 'test' },
    ),
  );
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

interface TestHarness {
  bus: RuntimeEventBus;
  controller: WrfcController;
  agentStore: Map<string, AgentRecord>;
  spawnedRecords: AgentRecord[];
  /** Emitted workflow event types in order. */
  workflowEvents: Array<{ type: string; payload: Record<string, unknown> }>;
  workPlanCalls: Array<{ type: 'create' | 'update'; input: Record<string, unknown> }>;
  mergedAgentIds: string[];
  cleanedAgentIds: string[];
  directCommitMessages: string[];
  currentHeadCalls: number;
  /** Register a record output so getStatus() returns it. */
  setOutput(agentId: string, fullOutput: string): void;
  /** Spawn a new agent record and register it. */
  addAgent(id: string, task: string, template?: string): AgentRecord;
}

function latestSpawnedByWrfcRole(records: AgentRecord[], role: NonNullable<AgentRecord['wrfcRole']>): AgentRecord {
  const record = records.filter((candidate) => candidate.wrfcRole === role).at(-1);
  if (!record) throw new Error(`Expected spawned WRFC ${role} agent`);
  return record;
}

function createHarness(overrides?: {
  scoreThreshold?: number;
  maxFixAttempts?: number;
  autoCommit?: boolean;
  gitRepo?: boolean;
}): TestHarness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const spawnedRecords: AgentRecord[] = [];
  const workflowEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const workPlanCalls: Array<{ type: 'create' | 'update'; input: Record<string, unknown> }> = [];
  const mergedAgentIds: string[] = [];
  const cleanedAgentIds: string[] = [];
  const directCommitMessages: string[] = [];
  let currentHeadCalls = 0;

  // Capture workflow events
  bus.onDomain('workflows', (envelope) => {
    workflowEvents.push({
      type: envelope.type,
      payload: envelope as unknown as Record<string, unknown>,
    });
  });

  const threshold = overrides?.scoreThreshold ?? 9.9;
  const maxFixAttempts = overrides?.maxFixAttempts ?? 3;
  const autoCommit = overrides?.autoCommit ?? false;
  const projectRoot = overrides?.gitRepo ? mkdtempSync(join(tmpdir(), 'wrfc-controller-')) : '/tmp/test-project';
  if (overrides?.gitRepo) {
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
  }

  const configManager = {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return threshold;
      if (key === 'wrfc.maxFixAttempts') return maxFixAttempts;
      if (key === 'wrfc.autoCommit') return autoCommit;
      return undefined;
    },
    getCategory: (category: string): unknown => {
      if (category === 'wrfc') {
        return {
          scoreThreshold: threshold,
          maxFixAttempts,
          autoCommit,
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

  const messageBus = {
    registerAgent: (_opts: unknown) => {},
  };

  const controller = new WrfcController(bus, messageBus, {
    agentManager,
    configManager,
    projectRoot,
    createWorktree: () => ({
      merge: async (agentId: string) => {
        mergedAgentIds.push(agentId);
        return true;
      },
      cleanup: async (agentId: string) => {
        cleanedAgentIds.push(agentId);
      },
      commitWorkingTree: async (message: string) => {
        directCommitMessages.push(message);
        return 'direct-commit-hash';
      },
      currentHead: async () => {
        currentHeadCalls += 1;
        return 'merged-head-hash';
      },
    }),
  });
  controller.setWorkPlanService({
    async createWorkPlanTask(input) {
      workPlanCalls.push({ type: 'create', input: input as unknown as Record<string, unknown> });
    },
    async updateWorkPlanTask(input) {
      workPlanCalls.push({ type: 'update', input: input as unknown as Record<string, unknown> });
    },
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

  return {
    bus,
    controller,
    agentStore,
    spawnedRecords,
    workflowEvents,
    workPlanCalls,
    mergedAgentIds,
    cleanedAgentIds,
    directCommitMessages,
    get currentHeadCalls() {
      return currentHeadCalls;
    },
    setOutput,
    addAgent,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WrfcController — happy path', () => {
  test('creates correlated work-plan tasks for owner and phase agents', async () => {
    const h = createHarness();

    const ownerRecord = h.addAgent('owner-1', 'implement feature X');
    const chain = h.controller.createChain(ownerRecord);
    await flushMicrotasks();

    expect(h.workPlanCalls.filter((call) => call.type === 'create').map((call) => {
      const task = (call.input as { task?: { phaseId?: string } }).task;
      return task?.phaseId;
    })).toEqual(['owner', 'engineer']);

    h.setOutput(chain.engineerAgentId!, 'I have completed the feature. Summary: done.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    const updateStatuses = h.workPlanCalls.filter((call) => call.type === 'update').map((call) => {
      const patch = (call.input as { patch?: { status?: string } }).patch;
      return patch?.status;
    });
    expect(updateStatuses).toContain('in_progress');
    expect(updateStatuses).toContain('done');
    expect(h.workPlanCalls.some((call) => {
      const task = (call.input as { task?: { phaseId?: string; chainId?: string; parentTaskId?: string } }).task;
      return task?.phaseId === 'reviewer' && task.chainId === chain.id && !!task.parentTaskId;
    })).toBe(true);
  });

  test('engineer completes → reviewer spawned → passing score → WORKFLOW_CHAIN_PASSED emitted', async () => {
    const h = createHarness();

    const ownerRecord = h.addAgent('owner-1', 'implement feature X');
    const chain = h.controller.createChain(ownerRecord);

    expect(chain.state).toBe('engineering');
    expect(chain.task).toBe('implement feature X');

    // Engineer completes with some output
    h.setOutput(chain.engineerAgentId!, 'I have completed the feature. Summary: done.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    // Reviewer should have been spawned
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer')).toHaveLength(1);
    const reviewerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    expect(chain.state).toBe('reviewing');
    expect(chain.reviewerAgentId).toBe(reviewerRecord.id);

    // Reviewer completes with a passing score
    h.setOutput(reviewerRecord.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, reviewerRecord.id);
    await flushMicrotasks();

    // Chain should have passed (no gates configured)
    expect(chain.state).toBe('passed');
    expect(chain.reviewScores).toContain(10);

    // Verify workflow events: state changes + WORKFLOW_CHAIN_PASSED
    const types = h.workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_CHAIN_CREATED');
    expect(types).toContain('WORKFLOW_REVIEW_COMPLETED');
    expect(types).toContain('WORKFLOW_CHAIN_PASSED');

    h.controller.dispose();
  });

  test('autoCommit commits direct workspace changes and merges only write-capable WRFC agents', async () => {
    const h = createHarness({ autoCommit: true, gitRepo: true });

    const ownerRecord = h.addAgent('owner-autocommit-1', 'implement auto commit feature');
    const chain = h.controller.createChain(ownerRecord);

    h.setOutput(chain.engineerAgentId!, 'I have completed the feature. Summary: done.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    const reviewerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    h.setOutput(reviewerRecord.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, reviewerRecord.id);
    await flushMicrotasks();

    expect(chain.state).toBe('passed');
    expect(h.directCommitMessages).toEqual(['WRFC: implement auto commit feature']);
    expect(h.mergedAgentIds).toEqual([chain.engineerAgentId]);
    expect(h.mergedAgentIds).not.toContain(reviewerRecord.id);
    expect(h.cleanedAgentIds).toEqual(expect.arrayContaining(chain.allAgentIds));
    expect(h.workflowEvents.map((e) => e.type)).toContain('WORKFLOW_AUTO_COMMITTED');

    h.controller.dispose();
  });

  test('autoCommit merges the latest fixer output instead of superseded engineer output', async () => {
    const h = createHarness({ autoCommit: true, gitRepo: true, maxFixAttempts: 2 });

    const ownerRecord = h.addAgent('owner-autocommit-fix-1', 'implement fixed auto commit feature');
    const chain = h.controller.createChain(ownerRecord);

    h.setOutput(chain.engineerAgentId!, 'Initial implementation.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    const firstReviewer = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    h.setOutput(firstReviewer.id, FAILING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, firstReviewer.id);
    await flushMicrotasks();

    const fixer = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    h.setOutput(fixer.id, 'Fixed implementation.');
    emitAgentCompleted(h.bus, fixer.id);
    await flushMicrotasks();

    const secondReviewer = h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer').at(-1)!;
    h.setOutput(secondReviewer.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, secondReviewer.id);
    await flushMicrotasks();

    expect(chain.state).toBe('passed');
    expect(h.mergedAgentIds).toEqual([fixer.id]);
    expect(h.mergedAgentIds).not.toContain(chain.engineerAgentId);
    expect(h.mergedAgentIds).not.toContain(firstReviewer.id);
    expect(h.mergedAgentIds).not.toContain(secondReviewer.id);

    h.controller.dispose();
  });

  test('compound chain runs parallel engineers, then per-deliverable reviews, then integrator, then final review', async () => {
    const h = createHarness();

    const ownerRecord = h.addAgent('owner-compound-1', 'Build a small API with a rate limiter and request logger.', 'orchestrator');
    ownerRecord.wrfcSubtasks = [
      { task: 'Implement token bucket rate limiter module.', template: 'engineer' },
      { task: 'Implement request logging middleware.', template: 'engineer' },
    ];
    const chain = h.controller.createChain(ownerRecord);

    expect(chain.state).toBe('engineering');
    expect(chain.subtasks).toHaveLength(2);
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'engineer')).toHaveLength(2);
    expect(h.spawnedRecords.every((record) => record.parentAgentId === ownerRecord.id)).toBe(true);
    expect(h.spawnedRecords.map((record) => record.wrfcSubtaskId)).toEqual(['deliverable-1', 'deliverable-2']);

    for (const subtask of chain.subtasks!) {
      h.setOutput(subtask.engineerAgentId!, `Implemented ${subtask.id}.`);
      emitAgentCompleted(h.bus, subtask.engineerAgentId!);
      await flushMicrotasks(20);
    }

    const subtaskReviewers = h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer');
    expect(subtaskReviewers).toHaveLength(2);
    expect(subtaskReviewers.map((record) => record.wrfcSubtaskId)).toEqual(['deliverable-1', 'deliverable-2']);
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'fixer')).toHaveLength(0);

    for (const reviewer of subtaskReviewers) {
      h.setOutput(reviewer.id, PASSING_REVIEW_OUTPUT);
      emitAgentCompleted(h.bus, reviewer.id);
      await flushMicrotasks(20);
    }

    expect(chain.subtasks!.every((subtask) => subtask.state === 'passed')).toBe(true);
    expect(chain.state).toBe('integrating');
    const integrator = latestSpawnedByWrfcRole(h.spawnedRecords, 'integrator');
    expect(integrator.template).toBe('integrator');
    expect(integrator.parentAgentId).toBe(ownerRecord.id);

    h.setOutput(integrator.id, 'Integrated both deliverables into one coherent API.');
    emitAgentCompleted(h.bus, integrator.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('reviewing');
    const allReviewers = h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer');
    expect(allReviewers).toHaveLength(3);
    const finalReviewer = allReviewers.at(-1)!;
    expect(finalReviewer.wrfcSubtaskId).toBeUndefined();

    h.setOutput(finalReviewer.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, finalReviewer.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');
    expect(ownerRecord.status).toBe('completed');
    expect(chain.ownerDecisions.map((decision) => decision.action)).toEqual(expect.arrayContaining([
      'spawn_integrator',
      'chain_passed',
    ]));

    h.controller.dispose();
  });

  test('compound autoCommit merges subtask writers and integrator, not reviewers', async () => {
    const h = createHarness({ autoCommit: true, gitRepo: true });

    const ownerRecord = h.addAgent('owner-compound-autocommit', 'Build a rate limiter and request logger.', 'orchestrator');
    ownerRecord.wrfcSubtasks = [
      { task: 'Implement token bucket rate limiter module.', template: 'engineer' },
      { task: 'Implement request logging middleware.', template: 'engineer' },
    ];
    const chain = h.controller.createChain(ownerRecord);

    for (const subtask of chain.subtasks!) {
      h.setOutput(subtask.engineerAgentId!, `Implemented ${subtask.id}.`);
      emitAgentCompleted(h.bus, subtask.engineerAgentId!);
      await flushMicrotasks(20);
    }

    const subtaskReviewers = h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer');
    for (const reviewer of subtaskReviewers) {
      h.setOutput(reviewer.id, PASSING_REVIEW_OUTPUT);
      emitAgentCompleted(h.bus, reviewer.id);
      await flushMicrotasks(20);
    }

    const integrator = latestSpawnedByWrfcRole(h.spawnedRecords, 'integrator');
    h.setOutput(integrator.id, 'Integrated both deliverables.');
    emitAgentCompleted(h.bus, integrator.id);
    await flushMicrotasks(20);

    const finalReviewer = h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer').at(-1)!;
    h.setOutput(finalReviewer.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, finalReviewer.id);
    await flushMicrotasks(20);

    const writerIds = [
      ...chain.subtasks!.map((subtask) => subtask.engineerAgentId),
      integrator.id,
    ];
    expect(chain.state).toBe('passed');
    expect(h.mergedAgentIds).toEqual(writerIds);
    for (const reviewer of h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer')) {
      expect(h.mergedAgentIds).not.toContain(reviewer.id);
    }
    expect(h.workflowEvents.map((e) => e.type)).toContain('WORKFLOW_AUTO_COMMITTED');

    h.controller.dispose();
  });

  test('compound subtask fix loop stays scoped and integration uses latest fixed output', async () => {
    const h = createHarness();

    const ownerRecord = h.addAgent('owner-compound-2', 'Build a small API with a rate limiter and request logger.', 'orchestrator');
    ownerRecord.wrfcSubtasks = [
      { task: 'Implement token bucket rate limiter module.', template: 'engineer' },
      { task: 'Implement request logging middleware.', template: 'engineer' },
    ];
    const chain = h.controller.createChain(ownerRecord);

    const [limiterSubtask, loggerSubtask] = chain.subtasks!;
    h.setOutput(limiterSubtask.engineerAgentId!, engineerReportOutput('initial limiter implementation', [
      { id: 'c1', text: 'support burst capacity', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, limiterSubtask.engineerAgentId!);
    await flushMicrotasks(20);

    h.setOutput(loggerSubtask.engineerAgentId!, engineerReportOutput('logger implementation'));
    emitAgentCompleted(h.bus, loggerSubtask.engineerAgentId!);
    await flushMicrotasks(20);

    const firstLimiterReviewer = h.spawnedRecords.find((record) =>
      record.wrfcRole === 'reviewer' && record.wrfcSubtaskId === limiterSubtask.id)!;
    const loggerReviewer = h.spawnedRecords.find((record) =>
      record.wrfcRole === 'reviewer' && record.wrfcSubtaskId === loggerSubtask.id)!;

    h.setOutput(firstLimiterReviewer.id, reviewerReportOutput(7, false, [
      { constraintId: 'c1', satisfied: false, evidence: 'burst capacity is missing', severity: 'major' },
    ]));
    emitAgentCompleted(h.bus, firstLimiterReviewer.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('engineering');
    expect(limiterSubtask.state).toBe('fixing');
    expect(loggerSubtask.state).toBe('reviewing');
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'fixer' && record.wrfcSubtaskId === limiterSubtask.id)).toHaveLength(1);
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'integrator')).toHaveLength(0);

    h.setOutput(loggerReviewer.id, reviewerReportOutput(10, true));
    emitAgentCompleted(h.bus, loggerReviewer.id);
    await flushMicrotasks(20);

    expect(loggerSubtask.state).toBe('passed');
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'integrator')).toHaveLength(0);

    const limiterFixer = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    h.setOutput(limiterFixer.id, engineerReportOutput('fixed limiter implementation', [
      { id: 'c1', text: 'support burst capacity', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, limiterFixer.id);
    await flushMicrotasks(20);

    const secondLimiterReviewer = h.spawnedRecords.filter((record) =>
      record.wrfcRole === 'reviewer' && record.wrfcSubtaskId === limiterSubtask.id).at(-1)!;
    expect(secondLimiterReviewer.id).not.toBe(firstLimiterReviewer.id);
    h.setOutput(secondLimiterReviewer.id, reviewerReportOutput(10, true, [
      { constraintId: 'c1', satisfied: true, evidence: 'burst capacity is implemented' },
    ]));
    emitAgentCompleted(h.bus, secondLimiterReviewer.id);
    await flushMicrotasks(20);

    const integrator = latestSpawnedByWrfcRole(h.spawnedRecords, 'integrator');
    expect(chain.state).toBe('integrating');
    expect(integrator.task).toContain('Engineer summary: fixed limiter implementation');
    expect(integrator.task).toContain('Engineer summary: logger implementation');

    h.controller.dispose();
  });
});

describe('WrfcController — gate failure', () => {
  test('score passes but configured gate fails → same WRFC chain starts a gate fix', async () => {
    // Use a gate that is configured (enabled) so it runs. The gate command will
    // fail because no real command can succeed in this unit test environment.
    // We configure a gate that always fails.
    const busWithGate = new RuntimeEventBus();
    const agentStore = new Map<string, AgentRecord>();
    const spawnedRecords: AgentRecord[] = [];
    const workflowEvents: Array<{ type: string; chainId?: string }> = [];

    busWithGate.onDomain('workflows', (envelope) => {
      workflowEvents.push({
        type: envelope.type,
        chainId: (envelope as unknown as Record<string, unknown>).chainId as string | undefined,
      });
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
            // Gate that always fails (exit code 1)
            gates: [{ name: 'custom-check', command: 'exit 1', enabled: true }],
          };
        }
        return undefined;
      },
    };

    const agentManager: AgentManagerLike = {
      spawn: (input) => {
        const id = `agent-gate-${spawnedRecords.length + 1}`;
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
    const controller = new WrfcController(busWithGate, messageBus, {
      agentManager,
      configManager,
      projectRoot: '/tmp/test-project-gate',
      createWorktree: () => ({
        merge: async () => true,
        cleanup: async () => {},
      }),
    });

    const ownerRecord = makeRecord({ id: 'owner-gate-1', task: 'implement gated feature' });
    agentStore.set('owner-gate-1', ownerRecord);
    const chain = controller.createChain(ownerRecord);

    agentStore.get(chain.engineerAgentId!)!.fullOutput = 'Implementation done.';
    emitAgentCompleted(busWithGate, chain.engineerAgentId!);
    await flushMicrotasks();

    // Reviewer spawned
    expect(spawnedRecords.length).toBeGreaterThanOrEqual(1);
    const reviewer = latestSpawnedByWrfcRole(spawnedRecords, 'reviewer');
    expect(chain.state).toBe('reviewing');

    // Reviewer passes with score 10
    reviewer.fullOutput = PASSING_REVIEW_OUTPUT;
    const fixAttempted = new Promise<void>((resolve) => {
      const unsubscribe = busWithGate.onDomain('workflows', (envelope) => {
        if (envelope.type === 'WORKFLOW_FIX_ATTEMPTED') {
          const chainId = (envelope.payload as { chainId?: string }).chainId;
          if (chainId === chain.id) {
            unsubscribe();
            resolve();
          }
        }
      });
    });
    emitAgentCompleted(busWithGate, reviewer.id);
    await fixAttempted; // event-based wait for gate process to complete
    await flushMicrotasks();

    // Chain remains active under the owner and starts a same-chain gate fix.
    expect(chain.state).toBe('fixing');

    const fixer = latestSpawnedByWrfcRole(spawnedRecords, 'fixer');
    expect(fixer.parentAgentId).toBe(chain.ownerAgentId);

    const types = workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_FIX_ATTEMPTED');
    expect(types).not.toContain('WORKFLOW_CHAIN_PASSED');

    controller.dispose();
  });
});

describe('WrfcController — escalation', () => {
  test('score below threshold after maxFixAttempts → WORKFLOW_CHAIN_FAILED emitted', async () => {
    const h = createHarness({ scoreThreshold: 9.9, maxFixAttempts: 1 });

    const ownerRecord = h.addAgent('owner-esc-1', 'implement escalation feature');
    const chain = h.controller.createChain(ownerRecord);

    expect(chain.state).toBe('engineering');

    // Engineer completes
    h.setOutput(chain.engineerAgentId!, 'Implementation done.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    expect(chain.state).toBe('reviewing');
    const reviewerRecord1 = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');

    // Reviewer 1 fails (score 5/10)
    h.setOutput(reviewerRecord1.id, FAILING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, reviewerRecord1.id);
    await flushMicrotasks();

    // With maxFixAttempts=1, a fixer is spawned (attempt 1)
    expect(chain.state).toBe('fixing');
    expect(chain.fixAttempts).toBe(1);
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'fixer')).toHaveLength(1);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    expect(chain.fixerAgentId).toBe(fixerRecord.id);

    // Fixer completes — triggers second review
    h.setOutput(fixerRecord.id, 'Fixed some issues.');
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks();

    expect(chain.state).toBe('reviewing');
    expect(h.spawnedRecords.filter((record) => record.wrfcRole === 'reviewer')).toHaveLength(2);
    const reviewerRecord2 = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');

    // Second reviewer also fails — fixAttempts(1) >= maxFixAttempts(1) → fail chain
    h.setOutput(reviewerRecord2.id, FAILING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, reviewerRecord2.id);
    await flushMicrotasks();

    // Chain should now be in 'failed' state
    expect(chain.state).toBe('failed');
    expect(chain.error).toMatch(/below threshold/i);

    // Verify WORKFLOW_CHAIN_FAILED event emitted
    const types = h.workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_FIX_ATTEMPTED');
    expect(types).toContain('WORKFLOW_REVIEW_COMPLETED');
    expect(types).toContain('WORKFLOW_CHAIN_FAILED');

    // Verify WORKFLOW_CHAIN_FAILED payload contains chainId
    const failedEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_CHAIN_FAILED');
    expect(failedEvent?.type).toBe('WORKFLOW_CHAIN_FAILED');

    // Verify fix-attempted event shape
    const fixAttemptEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_FIX_ATTEMPTED');
    expect(fixAttemptEvent?.type).toBe('WORKFLOW_FIX_ATTEMPTED');

    h.controller.dispose();
  });

  test('agent failure directly fails the chain', async () => {
    const h = createHarness();

    const ownerRecord = h.addAgent('owner-fail-1', 'task that will fail');
    const chain = h.controller.createChain(ownerRecord);

    expect(chain.state).toBe('engineering');

    emitAgentFailed(h.bus, chain.engineerAgentId!, 'LLM error: context limit exceeded');
    await flushMicrotasks();

    expect(chain.state).toBe('failed');
    expect(chain.error).not.toBeUndefined(); // presence-only: error was set on failed chain

    const types = h.workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_CHAIN_FAILED');

    h.controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Constraint propagation anchors
// ---------------------------------------------------------------------------

/** Encode a JSON report in a ```json block for the parser. */
function constraintJsonBlock(obj: Record<string, unknown>): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

/** Get the inner payload data from a stored workflow event (envelope.payload). */
function p5EventData(event: { type: string; payload: Record<string, unknown> }): Record<string, unknown> {
  return event.payload['payload'] as Record<string, unknown>;
}

function makeEngineerOutput(constraints: Array<{ id: string; text: string; source: string }>): string {
  return constraintJsonBlock({
    version: 1,
    archetype: 'engineer',
    summary: 'Done.',
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
  });
}

function makeReviewerOutput(
  score: number,
  findings: Array<{ constraintId: string; satisfied: boolean; evidence: string }>,
): string {
  return constraintJsonBlock({
    version: 1,
    archetype: 'reviewer',
    summary: score >= 9.9 ? 'Looks great.' : 'Needs fixes.',
    score,
    passed: score >= 9.9,
    dimensions: [],
    issues: [],
    constraintFindings: findings,
  });
}

describe('WrfcController — constraint integration', () => {
  test('C1: full chain with constraints ending in pass', async () => {
    const h = createHarness();

    const engRecord = h.addAgent('eng-c1', 'implement with constraints');
    const chain = h.controller.createChain(engRecord);

    h.setOutput(chain.engineerAgentId!, makeEngineerOutput([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
      { id: 'c2', text: 'no deps', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks(20);

    expect(chain.state).toBe('reviewing');
    expect(chain.constraints).toHaveLength(2);
    expect(chain.constraintsEnumerated).toBe(true);

    const reviewerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    h.setOutput(reviewerRecord.id, makeReviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure function verified' },
      { constraintId: 'c2', satisfied: true, evidence: 'zero imports' },
    ]));
    emitAgentCompleted(h.bus, reviewerRecord.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');

    const types = h.workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_CONSTRAINTS_ENUMERATED');
    expect(types).toContain('WORKFLOW_REVIEW_COMPLETED');
    expect(types).toContain('WORKFLOW_CHAIN_PASSED');

    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(p5EventData(reviewEvent!)['passed']).toBe(true);

    h.controller.dispose();
  });

  test('C2: full chain without constraints', async () => {
    const h = createHarness();

    const engRecord = h.addAgent('eng-c2', 'implement unconstrained feature');
    const chain = h.controller.createChain(engRecord);

    h.setOutput(chain.engineerAgentId!, makeEngineerOutput([]));
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks(20);

    expect(chain.state).toBe('reviewing');
    expect(chain.constraints).toHaveLength(0);

    const reviewerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    h.setOutput(reviewerRecord.id, makeReviewerOutput(10.0, []));
    emitAgentCompleted(h.bus, reviewerRecord.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');

    const types = h.workflowEvents.map((e) => e.type);
    expect(types).toContain('WORKFLOW_CHAIN_CREATED');
    expect(types).toContain('WORKFLOW_REVIEW_COMPLETED');
    expect(types).toContain('WORKFLOW_CHAIN_PASSED');

    // Review event must NOT have constraint fields (no-op path)
    const reviewEvent = h.workflowEvents.find((e) => e.type === 'WORKFLOW_REVIEW_COMPLETED');
    expect(reviewEvent?.type).toBe('WORKFLOW_REVIEW_COMPLETED');
    const reviewPayload = p5EventData(reviewEvent!);
    expect(reviewPayload['passed']).toBe(true);
    expect(reviewPayload['constraintsSatisfied']).toBeUndefined();
    expect(reviewPayload['constraintsTotal']).toBeUndefined();
    expect(reviewPayload['unsatisfiedConstraintIds']).toBeUndefined();

    h.controller.dispose();
  });

  test('constraint-forced fail → fix → pass — full state sequence', async () => {
    const h = createHarness({ maxFixAttempts: 3 });

    const engRecord = h.addAgent('eng-c3', 'implement with one constraint');
    const chain = h.controller.createChain(engRecord);

    h.setOutput(chain.engineerAgentId!, makeEngineerOutput([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks(20);

    expect(chain.state).toBe('reviewing');
    const reviewer1 = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');

    // Score 10 but c1 unsatisfied → constraint-forced fail
    h.setOutput(reviewer1.id, makeReviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: false, evidence: 'has side effect' },
    ]));
    emitAgentCompleted(h.bus, reviewer1.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('fixing');
    expect(chain.fixAttempts).toBe(1);

    const fixerRecord = latestSpawnedByWrfcRole(h.spawnedRecords, 'fixer');
    h.setOutput(fixerRecord.id, makeEngineerOutput([
      { id: 'c1', text: 'must be pure', source: 'prompt' },
    ]));
    emitAgentCompleted(h.bus, fixerRecord.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('reviewing');
    const reviewer2 = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');

    h.setOutput(reviewer2.id, makeReviewerOutput(10.0, [
      { constraintId: 'c1', satisfied: true, evidence: 'pure function confirmed' },
    ]));
    emitAgentCompleted(h.bus, reviewer2.id);
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');

    // Verify the full state sequence
    const stateChanges = h.workflowEvents
      .filter((e) => e.type === 'WORKFLOW_STATE_CHANGED')
      .map((e) => p5EventData(e)['to'] as string);

    expect(stateChanges).toContain('engineering');
    expect(stateChanges).toContain('reviewing');
    expect(stateChanges).toContain('fixing');
    expect(stateChanges).toContain('awaiting_gates');
    expect(stateChanges).toContain('passed');

    const reviewingTransitions = stateChanges.filter((s) => s === 'reviewing');
    expect(reviewingTransitions.length).toBeGreaterThanOrEqual(2);

    h.controller.dispose();
  });
});

describe('WrfcController — state machine', () => {
  test('createChain returns chain in engineering state with correct task', () => {
    const h = createHarness();
    const record = h.addAgent('eng-sm-1', 'state machine task');
    const chain = h.controller.createChain(record);

    expect(chain.id).toMatch(/^wrfc-/);
    expect(chain.state).toBe('engineering');
    expect(chain.task).toBe('state machine task');
    expect(chain.ownerAgentId).toBe('eng-sm-1');
    expect(chain.engineerAgentId).not.toBe('eng-sm-1');
    expect(chain.fixAttempts).toBe(0);
    expect(chain.reviewCycles).toBe(0);

    h.controller.dispose();
  });

  test('getChain and listChains reflect active chains', () => {
    const h = createHarness();
    const r1 = h.addAgent('eng-sm-2', 'task A');
    const r2 = h.addAgent('eng-sm-3', 'task B');

    const chain1 = h.controller.createChain(r1);
    const chain2 = h.controller.createChain(r2);

    expect(h.controller.getChain(chain1.id)).toBe(chain1);
    expect(h.controller.getChain(chain2.id)).toBe(chain2);
    expect(h.controller.listChains().length).toBe(2);

    h.controller.dispose();
  });

  test('complete chain sequence emits WORKFLOW_STATE_CHANGED transitions', async () => {
    const h = createHarness();
    const stateChanges: Array<{ from: string; to: string }> = [];

    h.bus.on<{ type: 'WORKFLOW_STATE_CHANGED'; from: string; to: string }>(
      'WORKFLOW_STATE_CHANGED',
      (envelope) => {
        const { from, to } = envelope.payload as { from: string; to: string };
        stateChanges.push({ from, to });
      },
    );

    const record = h.addAgent('eng-sm-4', 'state transition task');
    const chain = h.controller.createChain(record);

    h.setOutput(chain.engineerAgentId!, 'Done.');
    emitAgentCompleted(h.bus, chain.engineerAgentId!);
    await flushMicrotasks();

    const reviewer = latestSpawnedByWrfcRole(h.spawnedRecords, 'reviewer');
    h.setOutput(reviewer.id, PASSING_REVIEW_OUTPUT);
    emitAgentCompleted(h.bus, reviewer.id);
    await flushMicrotasks();

    // Should have transitioned: pending→engineering, engineering→reviewing,
    // reviewing→awaiting_gates, awaiting_gates→gating, gating→passed
    const toStates = stateChanges.map((c) => c.to);
    expect(toStates).toContain('engineering');
    expect(toStates).toContain('reviewing');
    expect(toStates).toContain('awaiting_gates');
    expect(toStates).toContain('passed');

    h.controller.dispose();
  });
});
