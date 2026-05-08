import { describe, expect, test } from 'bun:test';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { WrfcExternalWorkBridge, type WrfcExternalWorkAdapter } from '../packages/sdk/src/platform/agents/wrfc-external-adapter.js';
import { buildFixTask, buildReviewTask } from '../packages/sdk/src/platform/agents/wrfc-reporting.js';
import { AgentManager, type AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/event-envelope.js';

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function emitAgentCompleted(bus: RuntimeEventBus, agentId: string): void {
  bus.emit(
    'agents',
    createEventEnvelope(
      'AGENT_COMPLETED',
      { type: 'AGENT_COMPLETED', agentId, durationMs: 0 },
      { sessionId: 'test', traceId: `test:${agentId}:completed`, source: 'test' },
    ),
  );
}

function waitForWorkflowEvent(bus: RuntimeEventBus, type: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = bus.onDomain('workflows', (envelope) => {
      if (envelope.type === type) {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe('WRFC owner agent orchestration', () => {
  test('root spawn creates a durable owner and runs phase agents as owner children', async () => {
    const bus = new RuntimeEventBus();
    const runRecords: AgentRecord[] = [];
    const messageBus = { registerAgent: () => {} };
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
            gates: [],
          };
        }
        return undefined;
      },
    };

    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus,
      configManager,
      executor: {
        async runAgent(record) {
          record.status = 'running';
          runRecords.push(record);
        },
      },
    });
    manager.setRuntimeBus(bus);
    const controller = new WrfcController(bus, messageBus, {
      agentManager: manager,
      configManager,
      projectRoot: '/tmp/wrfc-owner-agent-test',
      createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
      selectChildRoute: ({ role }) => role === 'reviewer'
        ? {
            model: 'openai:gpt-5.3-codex-spark',
            provider: 'openai',
            reasoningEffort: 'low',
            reason: 'reviewer route selected for cheaper full-scope review',
          }
        : null,
    });
    manager.setWrfcController(controller);

    const owner = manager.spawn({
      mode: 'spawn',
      task: 'implement owner-controlled WRFC work',
      template: 'engineer',
      model: 'openai:gpt-5.5',
      reasoningEffort: 'high',
      orchestrationGraphId: 'wrfc-owner-graph',
      orchestrationNodeId: 'owner-node',
    });

    expect(owner.wrfcRole).toBe('owner');
    expect(owner.status).toBe('running');
    expect(owner.parentAgentId).toBeUndefined();
    expect(runRecords.map((record) => record.id)).not.toContain(owner.id);

    const chain = controller.listChains()[0]!;
    expect(chain.ownerAgentId).toBe(owner.id);
    expect(chain.state).toBe('engineering');
    expect(chain.engineerAgentId).toBeDefined();

    const engineer = manager.getStatus(chain.engineerAgentId!)!;
    expect(engineer.wrfcRole).toBe('engineer');
    expect(engineer.parentAgentId).toBe(owner.id);
    expect(engineer.orchestrationGraphId).toBe('wrfc-owner-graph');
    expect(engineer.parentNodeId).toBe('owner-node');
    expect(engineer.model).toBe('openai:gpt-5.5');
    expect(engineer.reasoningEffort).toBe('high');
    expect(engineer.systemPromptAddendum).toContain('EngineerReport');
    expect(runRecords.map((record) => record.id)).toEqual([engineer.id]);
    expect(() => manager.spawn({
      mode: 'spawn',
      task: 'nested WRFC child work',
      template: 'engineer',
      parentAgentId: engineer.id,
      dangerously_disable_wrfc: true,
    })).toThrow('WRFC phase agents cannot spawn nested child agents');

    engineer.fullOutput = 'Implementation complete.';
    emitAgentCompleted(bus, engineer.id);
    await flushMicrotasks(20);

    const reviewer = manager.list().find((record) => record.wrfcRole === 'reviewer')!;
    expect(reviewer).toBeDefined();
    expect(reviewer.parentAgentId).toBe(owner.id);
    expect(reviewer.orchestrationGraphId).toBe('wrfc-owner-graph');
    expect(reviewer.parentNodeId).toBe('owner-node');
    expect(reviewer.model).toBe('openai:gpt-5.3-codex-spark');
    expect(reviewer.provider).toBe('openai');
    expect(reviewer.reasoningEffort).toBe('low');
    expect(runRecords.map((record) => record.id)).toEqual([engineer.id, reviewer.id]);

    const passed = waitForWorkflowEvent(bus, 'WORKFLOW_CHAIN_PASSED');
    reviewer.fullOutput = 'Review passed. Score: 10/10';
    emitAgentCompleted(bus, reviewer.id);
    await passed;
    await flushMicrotasks(20);

    expect(chain.state).toBe('passed');
    expect(owner.status).toBe('completed');
    expect(owner.fullOutput).toContain('WRFC chain');
    expect(owner.fullOutput).toContain('passed');
    expect(chain.ownerDecisions.map((decision) => decision.action)).toEqual(expect.arrayContaining([
      'chain_created',
      'spawn_engineer',
      'spawn_reviewer',
      'review_passed',
      'gate_passed',
      'chain_passed',
    ]));
    expect(chain.ownerDecisions.some((decision) => decision.reason.includes('cheaper full-scope review'))).toBe(true);

    controller.dispose();
  });

  test('resumeChain is idempotent when an owner child is already active', () => {
    const bus = new RuntimeEventBus();
    const runRecords: AgentRecord[] = [];
    const messageBus = { registerAgent: () => {} };
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
            gates: [],
          };
        }
        return undefined;
      },
    };

    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus,
      configManager,
      executor: {
        async runAgent(record) {
          record.status = 'running';
          runRecords.push(record);
        },
      },
    });
    manager.setRuntimeBus(bus);
    const controller = new WrfcController(bus, messageBus, {
      agentManager: manager,
      configManager,
      projectRoot: '/tmp/wrfc-owner-agent-resume-test',
      createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
    });
    manager.setWrfcController(controller);

    const owner = manager.spawn({
      mode: 'spawn',
      task: 'resume without duplicate children',
      template: 'engineer',
    });
    const chain = controller.listChains()[0]!;
    expect(runRecords).toHaveLength(1);

    expect(controller.resumeChain(chain.id)).toBe(true);
    expect(controller.resumeAllActiveChains()).toBe(1);
    expect(runRecords).toHaveLength(1);
    expect(manager.getStatus(owner.id)?.status).toBe('running');
    expect(chain.ownerDecisions.filter((decision) => decision.action === 'resume_skipped').length).toBeGreaterThanOrEqual(1);

    controller.dispose();
  });

  test('cancelling the owner terminates the WRFC chain and cancels owner children', async () => {
    const bus = new RuntimeEventBus();
    const runRecords: AgentRecord[] = [];
    const messageBus = { registerAgent: () => {} };
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
            gates: [],
          };
        }
        return undefined;
      },
    };

    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus,
      configManager,
      executor: {
        async runAgent(record) {
          record.status = 'running';
          runRecords.push(record);
        },
      },
    });
    manager.setRuntimeBus(bus);
    const controller = new WrfcController(bus, messageBus, {
      agentManager: manager,
      configManager,
      projectRoot: '/tmp/wrfc-owner-agent-cancel-test',
      createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
    });
    manager.setWrfcController(controller);

    const owner = manager.spawn({
      mode: 'spawn',
      task: 'cancel owner-controlled WRFC work',
      template: 'engineer',
    });
    const chain = controller.listChains()[0]!;
    const engineer = manager.getStatus(chain.engineerAgentId!)!;
    expect(engineer.status).toBe('running');

    const failed = waitForWorkflowEvent(bus, 'WORKFLOW_CHAIN_FAILED');
    expect(manager.cancel(owner.id)).toBe(true);
    await failed;
    await flushMicrotasks(20);

    expect(chain.state).toBe('failed');
    expect(chain.error).toBe('operator cancellation');
    expect(owner.status).toBe('cancelled');
    expect(engineer.status).toBe('cancelled');

    controller.dispose();
  });

  test('unexpected owner completion fails the WRFC chain instead of orphaning children', async () => {
    const bus = new RuntimeEventBus();
    const messageBus = { registerAgent: () => {} };
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
            gates: [],
          };
        }
        return undefined;
      },
    };
    const manager = new AgentManager({
      archetypeLoader: { loadArchetype: () => null },
      messageBus,
      configManager,
      executor: {
        async runAgent(record) {
          record.status = 'running';
        },
      },
    });
    manager.setRuntimeBus(bus);
    const controller = new WrfcController(bus, messageBus, {
      agentManager: manager,
      configManager,
      projectRoot: '/tmp/wrfc-owner-agent-unexpected-complete-test',
      createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
    });
    manager.setWrfcController(controller);

    const owner = manager.spawn({
      mode: 'spawn',
      task: 'unexpected owner completion',
      template: 'engineer',
    });
    const chain = controller.listChains()[0]!;
    const engineer = manager.getStatus(chain.engineerAgentId!)!;

    const failed = waitForWorkflowEvent(bus, 'WORKFLOW_CHAIN_FAILED');
    emitAgentCompleted(bus, owner.id);
    await failed;
    await flushMicrotasks(20);

    expect(chain.state).toBe('failed');
    expect(chain.error).toBe('WRFC owner agent completed before the chain reached a terminal state');
    expect(owner.status).toBe('failed');
    expect(engineer.status).toBe('cancelled');

    controller.dispose();
  });

  test('review and fix prompts keep the original WRFC ask as full-scope authority', () => {
    const originalAsk = 'Refactor the runtime and update every affected public API, not just the file touched in the last patch.';
    const reviewTask = buildReviewTask('wrfc-test', originalAsk, {
      version: 1,
      archetype: 'engineer',
      summary: 'Changed one file',
      gatheredContext: [],
      plannedActions: [],
      appliedChanges: [],
      filesCreated: [],
      filesModified: ['src/runtime.ts'],
      filesDeleted: [],
      decisions: [],
      issues: [],
      uncertainties: [],
    }, 9.9);

    expect(reviewTask).toContain('Original WRFC ask (authoritative full review scope)');
    expect(reviewTask).toContain(originalAsk);
    expect(reviewTask).toContain('Do not narrow the review to the latest fix');

    const fixTask = buildFixTask('wrfc-test', originalAsk, {
      version: 1,
      archetype: 'reviewer',
      summary: 'Only checked one touched file.',
      score: 7,
      passed: false,
      dimensions: [],
      issues: [{ severity: 'major', description: 'Missed public API updates', pointValue: 2 }],
    }, 9.9, 1);

    expect(fixTask).toContain('Original WRFC ask (authoritative scope for every fix loop)');
    expect(fixTask).toContain(originalAsk);
    expect(fixTask).toContain('Do not limit the fix to only the files/functions named by the latest review');
  });

  test('external work bridge delegates through the generic WRFC adapter seam', async () => {
    const calls: string[] = [];
    const adapter: WrfcExternalWorkAdapter = {
      async dispatch(request) {
        calls.push(`dispatch:${request.task}`);
        return { externalTaskId: 'external-1', status: 'queued' };
      },
      async status(externalTaskId) {
        calls.push(`status:${externalTaskId}`);
        return { externalTaskId, status: 'running', progress: 'working' };
      },
      async cancel(externalTaskId, reason) {
        calls.push(`cancel:${externalTaskId}:${reason ?? ''}`);
      },
      async result(externalTaskId) {
        calls.push(`result:${externalTaskId}`);
        return { externalTaskId, status: 'completed', summary: 'done' };
      },
    };
    const bridge = new WrfcExternalWorkBridge(adapter);

    await expect(bridge.dispatch({ task: 'partner app task', wrfcId: 'wrfc-1' })).resolves.toEqual({
      externalTaskId: 'external-1',
      status: 'queued',
    });
    await expect(bridge.status('external-1')).resolves.toMatchObject({ status: 'running' });
    await bridge.cancel('external-1', 'user cancelled');
    await expect(bridge.result('external-1')).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toEqual([
      'dispatch:partner app task',
      'status:external-1',
      'cancel:external-1:user cancelled',
      'result:external-1',
    ]);
  });
});
