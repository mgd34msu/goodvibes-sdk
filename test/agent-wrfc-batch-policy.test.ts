import { describe, expect, test } from 'bun:test';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createAgentTool, AgentManager, type AgentRecord } from '../packages/sdk/src/platform/tools/agent/index.js';

function createConfigManager() {
  return {
    get: (key: string): unknown => {
      if (key === 'wrfc.scoreThreshold') return 9.9;
      if (key === 'wrfc.maxFixAttempts') return 3;
      if (key === 'wrfc.autoCommit') return false;
      if (key === 'agents.maxActive') return 20;
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
}

function createHarness() {
  const runRecords: AgentRecord[] = [];
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const configManager = createConfigManager();
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
    projectRoot: '/tmp/agent-wrfc-batch-policy-test',
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  manager.setWrfcController(controller);
  const tool = createAgentTool({
    manager,
    messageBus,
    wrfcController: controller,
    archetypeLoader: { loadArchetype: () => null },
    configManager,
  });
  return { controller, manager, runRecords, tool };
}

describe('agent batch-spawn WRFC topology policy', () => {
  test('preserves the original user ask as authoritative WRFC scope when collapse sees a narrowed no-write child task', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      authoritativeTask: 'make a token bucket rate limiter',
      dangerously_disable_wrfc: true,
      tasks: [
        {
          task: 'Independently design a minimal, robust token bucket rate limiter API for a new empty repository. Do not write files. Return recommended language-neutral behavior, edge cases, and tests.',
          template: 'engineer',
          tools: ['find', 'read'],
          restrictTools: true,
          reviewMode: 'none',
          dangerously_disable_wrfc: true,
        },
        {
          task: 'Independently review expected correctness properties for a token bucket rate limiter. Do not write files. Return concise validation checklist.',
          template: 'reviewer',
          tools: ['find', 'read'],
          restrictTools: true,
          reviewMode: 'none',
          dangerously_disable_wrfc: true,
        },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as {
      collapsedToWrfc?: boolean;
      scopeMutation?: { action: string; proposedTask: string; authoritativeTask: string; warnings: string[] } | null;
      agents: Array<{ id: string }>;
    };
    expect(output.collapsedToWrfc).toBe(true);
    expect(output.scopeMutation?.action).toBe('used-authoritative-task');
    expect(output.scopeMutation?.authoritativeTask).toBe('make a token bucket rate limiter');
    expect(output.scopeMutation?.proposedTask).toContain('Do not write files');

    const owner = manager.getStatus(output.agents[0]!.id)!;
    expect(owner.task).toBe('make a token bucket rate limiter');
    expect(owner.context).toContain('Authoritative original ask');
    expect(owner.context).toContain('Model-proposed child scope');
    expect(owner.context).toContain('ignored restrictive child tool settings');
    expect(owner.tools).toContain('write');
    expect(owner.tools).toContain('exec');

    const chain = controller.listChains()[0]!;
    expect(chain.task).toBe('make a token bucket rate limiter');
    const engineer = manager.getStatus(chain.engineerAgentId!)!;
    expect(engineer.task).toBe('make a token bucket rate limiter');
    expect(engineer.task).not.toContain('Do not write files');
    expect(engineer.tools).toContain('write');
    expect(engineer.tools).toContain('exec');
  });

  test('normalizes a narrowed design-only collapse task when no original ask was supplied', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      dangerously_disable_wrfc: true,
      tasks: [
        {
          task: 'Independently design a minimal, robust token bucket rate limiter API for a new empty repository. Do not write files.',
          template: 'engineer',
        },
        {
          task: 'Review the implementation for correctness.',
          template: 'reviewer',
        },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as {
      scopeMutation?: { action: string; authoritativeTask: string } | null;
      agents: Array<{ id: string }>;
    };
    expect(output.scopeMutation?.action).toBe('normalized-narrowed-task');
    const owner = manager.getStatus(output.agents[0]!.id)!;
    expect(owner.task).toContain('Implement');
    expect(owner.task).toContain('token bucket rate limiter');
    expect(owner.task).not.toContain('Do not write files');
    expect(controller.listChains()[0]!.task).toBe(owner.task);
  });

  test('uses authoritative task for direct reviewer root normalization', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      authoritativeTask: 'make a token bucket rate limiter',
      task: 'Review the implementation for correctness. Do not write files.',
      template: 'reviewer',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { agentId: string; wrfcRole?: string };
    expect(output.wrfcRole).toBe('owner');
    const owner = manager.getStatus(output.agentId)!;
    expect(owner.task).toBe('make a token bucket rate limiter');
    expect(owner.task).not.toContain('Do not write files');
    expect(controller.listChains()[0]!.task).toBe('make a token bucket rate limiter');
  });

  test('prevents direct engineer root spawns from narrowing an implementation ask to design-only no-write work', async () => {
    const { manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      authoritativeTask: 'make a token bucket rate limiter',
      task: 'Independently design a minimal, robust token bucket rate limiter API for a new empty repository. Do not write files.',
      template: 'engineer',
      tools: ['find', 'read'],
      restrictTools: true,
      reviewMode: 'none',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { agentId: string };
    const agent = manager.getStatus(output.agentId)!;
    expect(agent.task).toBe('make a token bucket rate limiter');
    expect(agent.task).not.toContain('Do not write files');
    expect(agent.context).toContain('Scope mutation warning');
    expect(agent.context).toContain('removed write or execution capability');
    expect(agent.successCriteria).toContain('Satisfy the authoritative original ask exactly: make a token bucket rate limiter');
    expect(agent.tools).toContain('write');
    expect(agent.tools).toContain('exec');
  });

  test('preserves restrictive read-only tools when the authoritative ask is explicitly no-write', async () => {
    const { manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      authoritativeTask: 'Design a token bucket rate limiter API. Do not write files.',
      task: 'Design a token bucket rate limiter API. Do not write files.',
      template: 'engineer',
      tools: ['find', 'read'],
      restrictTools: true,
      reviewMode: 'none',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { agentId: string };
    const agent = manager.getStatus(output.agentId)!;
    expect(agent.task).toBe('Design a token bucket rate limiter API. Do not write files.');
    expect(agent.tools).toEqual(['find', 'read']);
  });

  test('preserves restrictive read-only tools for non-implementation inspection tasks', async () => {
    const { manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      authoritativeTask: 'Inspect CI configuration.',
      task: 'Inspect CI configuration.',
      template: 'researcher',
      tools: ['find', 'read'],
      restrictTools: true,
      reviewMode: 'none',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { agentId: string };
    const agent = manager.getStatus(output.agentId)!;
    expect(agent.task).toBe('Inspect CI configuration.');
    expect(agent.tools).toEqual(['find', 'read']);
  });

  test('collapses natural engineer plus tester fanout into one WRFC owner chain even when caller disables WRFC', async () => {
    const { controller, manager, runRecords, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      dangerously_disable_wrfc: true,
      tasks: [
        { task: 'Build a simple rate limiter.', template: 'engineer' },
        { task: 'Test the implementation and verify rate limit behavior.', template: 'tester' },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as {
      collapsedToWrfc?: boolean;
      authoritativeWrfcChain?: boolean;
      continueRootSpawning?: boolean;
      orchestrationStopSignal?: string | null;
      count: number;
      skipped: number;
      collapsedTaskCount: number;
      roleTaskIndexes: number[];
      agents: Array<{ id: string; wrfcRole?: string; wrfcId?: string; wrfcPhaseOrder?: number; continueRootSpawning?: boolean }>;
    };
    expect(output.collapsedToWrfc).toBe(true);
    expect(output.authoritativeWrfcChain).toBe(true);
    expect(output.continueRootSpawning).toBe(false);
    expect(output.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(output.count).toBe(1);
    expect(output.skipped).toBe(0);
    expect(output.collapsedTaskCount).toBe(2);
    expect(output.roleTaskIndexes).toEqual([1]);

    const owner = manager.getStatus(output.agents[0]!.id)!;
    expect(owner.parentAgentId).toBeUndefined();
    expect(owner.wrfcRole).toBe('owner');
    expect(owner.wrfcPhaseOrder).toBe(0);
    expect(output.agents[0]!.wrfcRole).toBe('owner');
    expect(output.agents[0]!.wrfcPhaseOrder).toBe(0);
    expect(output.agents[0]!.continueRootSpawning).toBe(false);
    expect(owner.dangerously_disable_wrfc).toBe(false);

    const chains = controller.listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]!.ownerAgentId).toBe(owner.id);
    expect(chains[0]!.engineerAgentId).toBeDefined();

    const rootAgents = manager.list().filter((agent) => !agent.parentAgentId);
    expect(rootAgents.map((agent) => agent.id)).toEqual([owner.id]);
    expect(rootAgents.some((agent) => agent.template === 'tester' || agent.template === 'reviewer')).toBe(false);

    const engineer = manager.getStatus(chains[0]!.engineerAgentId!)!;
    expect(engineer.parentAgentId).toBe(owner.id);
    expect(engineer.wrfcRole).toBe('engineer');
    expect(engineer.wrfcPhaseOrder).toBe(1);
    expect(runRecords.map((record) => record.id)).toEqual([engineer.id]);
  });

  test('collapses text-only review/test role fanout without relying on explicit WRFC markers', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      dangerously_disable_wrfc: true,
      tasks: [
        { task: 'Engineer: build a simple rate limiter.', template: 'general' },
        { task: 'Reviewer: review the implementation for correctness.', template: 'general' },
        { task: 'Tester: test the implementation edge cases.', template: 'general' },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { collapsedToWrfc?: boolean; continueRootSpawning?: boolean; agents: Array<{ id: string }> };
    expect(output.collapsedToWrfc).toBe(true);
    expect(output.continueRootSpawning).toBe(false);
    expect(controller.listChains()).toHaveLength(1);
    expect(manager.list().filter((agent) => !agent.parentAgentId)).toHaveLength(1);
    expect(manager.getStatus(output.agents[0]!.id)?.wrfcRole).toBe('owner');
  });

  test('keeps genuinely independent sidecar batches as separate non-WRFC roots', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      dangerously_disable_wrfc: true,
      tasks: [
        { task: 'Inspect package manager configuration.', template: 'researcher' },
        { task: 'Inspect CI configuration.', template: 'researcher' },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { collapsedToWrfc?: boolean; count: number; agents: Array<{ continueRootSpawning?: boolean }> };
    expect(output.collapsedToWrfc).toBeUndefined();
    expect(output.count).toBe(2);
    expect(output.agents.every((agent) => agent.continueRootSpawning === true)).toBe(true);
    expect(controller.listChains()).toHaveLength(0);
    const rootAgents = manager.list().filter((agent) => !agent.parentAgentId);
    expect(rootAgents).toHaveLength(2);
    expect(rootAgents.every((agent) => agent.wrfcRole === undefined && agent.reviewMode === 'none')).toBe(true);
  });

  test('normalizes direct disabled reviewer/tester root spawns into one WRFC owner chain', async () => {
    const { controller, manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      task: 'Review the implementation for correctness.',
      template: 'reviewer',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as {
      agentId: string;
      wrfcRole?: string;
      wrfcPhaseOrder?: number;
      wrfcRouteReason?: string | null;
      authoritativeWrfcChain?: boolean;
      continueRootSpawning?: boolean;
      orchestrationStopSignal?: string | null;
    };
    expect(output.wrfcRole).toBe('owner');
    expect(output.wrfcPhaseOrder).toBe(0);
    expect(output.wrfcRouteReason).toBe('root-review-role-normalized');
    expect(output.authoritativeWrfcChain).toBe(true);
    expect(output.continueRootSpawning).toBe(false);
    expect(output.orchestrationStopSignal).toBe('wrfc_owner_chain_started');
    expect(controller.listChains()).toHaveLength(1);
    const owner = manager.getStatus(output.agentId)!;
    expect(owner.template).toBe('engineer');
    expect(owner.reviewMode).toBe('wrfc');
    expect(owner.dangerously_disable_wrfc).toBe(false);
    expect(manager.list().filter((agent) => !agent.parentAgentId)).toHaveLength(1);
  });

  test('normalizes direct reviewer/tester root spawns even when WRFC is not explicitly disabled', async () => {
    const { manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'spawn',
      task: 'Tester: test the implementation for correctness.',
      template: 'tester',
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { agentId: string; wrfcRole?: string; continueRootSpawning?: boolean };
    const owner = manager.getStatus(output.agentId)!;
    expect(owner.wrfcRole).toBe('owner');
    expect(output.continueRootSpawning).toBe(false);
    expect(owner.template).toBe('engineer');
    expect(owner.reviewMode).toBe('wrfc');
    expect(manager.list().filter((agent) => !agent.parentAgentId)).toHaveLength(1);
  });

  test('normalizes one-task batch-spawn through the spawn path', async () => {
    const { manager, tool } = createHarness();

    const result = await tool.execute({
      mode: 'batch-spawn',
      dangerously_disable_wrfc: true,
      tasks: [
        { task: 'Inspect one independent subsystem.', template: 'researcher' },
      ],
    });

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output!) as { normalizedToSpawn?: boolean; count: number; agents: Array<{ id: string; continueRootSpawning?: boolean }> };
    expect(output.normalizedToSpawn).toBe(true);
    expect(output.count).toBe(1);
    expect(output.agents[0]!.continueRootSpawning).toBe(true);
    expect(manager.getStatus(output.agents[0]!.id)?.task).toBe('Inspect one independent subsystem.');
  });
});
