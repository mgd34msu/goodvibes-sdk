/**
 * A WRFC chain's fix phase must be runnable in every composition that can run
 * a chain, and a read-only review ask must never become a chain at all.
 *
 * Live run 7: a TUI chain failed at its fix phase with "planned-fix execution
 * is not wired in this composition (setFixWorkstreamRunner was never called)"
 * because only createRuntimeServices set the runner after construction; the
 * TUI, the agent, and the operations-level createAgentGraph built controllers
 * that never received one. The runner is now a required constructor
 * dependency, so a composition without one fails when it is built.
 *
 * The same run's chain existed only because a read-only ask ("Spawn one
 * reviewer agent to review and verify ... Do not modify files.") was promoted
 * into a write-review-fix chain whose engineer was handed the delegation
 * instruction itself as its task, and could only fail.
 */
import { describe, expect, test } from 'bun:test';
import { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import { createFailingFixRunnerForTest } from '../packages/sdk/src/platform/agents/wrfc-controller-test-support.js';
import { AgentMessageBus } from '../packages/sdk/src/platform/agents/message-bus.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createAgentGraph } from '../packages/sdk/src/platform/runtime/agent-graph-composition.js';
import { createFixWorkstreamRunner } from '../packages/sdk/src/platform/orchestration/fix-workstream-runner.js';
import { AgentManager, type AgentRecord } from '../packages/sdk/src/platform/tools/agent/index.js';
import { askDelegatesToAgent, askForbidsWrites } from '../packages/sdk/src/platform/tools/index.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/index.js';

const INCIDENT_ASK = 'Spawn one reviewer agent to review and verify the backoff logic in src/net/retry.ts against test/retry.test.ts. Do not wait for it; just tell me it started. Do not modify files.';
const INCIDENT_TASK = 'Review and verify the backoff logic in src/net/retry.ts against test/retry.test.ts. Do not modify files; report findings only. Do not wait for further instructions.';

function createConfigManager(): Pick<ConfigManager, 'get' | 'getCategory'> {
  const get = ((key: string): unknown => {
    if (key === 'wrfc.scoreThreshold') return 9.9;
    if (key === 'wrfc.maxFixAttempts') return 3;
    if (key === 'wrfc.autoCommit') return false;
    if (key === 'agents.maxActive') return 20;
    return undefined;
  }) as ConfigManager['get'];
  const getCategory = ((category: string): unknown => (category === 'wrfc'
    ? { scoreThreshold: 9.9, maxFixAttempts: 3, autoCommit: false, gates: [] }
    : undefined)) as ConfigManager['getCategory'];
  return { get, getCategory };
}

function createHarness() {
  const bus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const configManager = createConfigManager();
  const manager = new AgentManager({
    archetypeLoader: { loadArchetype: () => null },
    messageBus,
    configManager,
    executor: { async runAgent(record: AgentRecord) { record.status = 'running'; } },
  });
  manager.setRuntimeBus(bus);
  const controller = new WrfcController(bus, messageBus, {
    fixWorkstreamRunner: createFailingFixRunnerForTest(),
    agentManager: manager,
    configManager,
    projectRoot: '/tmp/wrfc-fix-runner-composition-test',
    createWorktree: () => ({ merge: async () => true, cleanup: async () => {} }),
  });
  manager.setWrfcController(controller);
  return { controller, manager };
}

describe('WRFC fix runner is wired at composition', () => {
  test('a controller built without a fix runner throws at construction, not mid-chain', () => {
    const bus = new RuntimeEventBus();
    const messageBus = new AgentMessageBus();
    const construct = () => Reflect.construct(WrfcController, [bus, messageBus, {
      agentManager: {} as never,
      configManager: createConfigManager(),
      projectRoot: '/tmp/wrfc-fix-runner-composition-test',
    }]);
    expect(construct).toThrow(/requires deps\.fixWorkstreamRunner/);
  });

  test('the operations-level createAgentGraph returns a controller whose fix phase runs on its engine', () => {
    const graph = createAgentGraph({
      runtimeBus: new RuntimeEventBus(),
      workingDirectory: '/tmp/wrfc-fix-runner-composition-test',
      configManager: createConfigManager() as ConfigManager,
      providerRegistry: { listModels: () => [] } as unknown as ProviderRegistry,
    });
    expect(typeof graph.orchestrationEngine.createWorkstream).toBe('function');
    const runner = (graph.wrfcController as unknown as { fixWorkstreamRunner: { run: unknown } | null }).fixWorkstreamRunner;
    expect(runner).not.toBeNull();
    expect(typeof runner?.run).toBe('function');
    graph.orchestrationEngine.dispose();
  });

  test('a late-bound engine is read when a fix cycle starts, not when the runner is built', async () => {
    let reads = 0;
    let engine: Parameters<typeof createFixWorkstreamRunner>[0]['engine'] | null = null;
    const runner = createFixWorkstreamRunner({
      engine: () => {
        reads += 1;
        if (!engine || typeof engine === 'function') throw new Error('engine not composed yet');
        return engine;
      },
    });
    expect(reads).toBe(0);
    engine = {
      createWorkstream: () => { throw new Error('unused'); },
      start: () => {},
      getWorkstream: () => null,
      on: () => () => {},
    };
    // A review with no parseable findings resolves nothing-to-fix before any
    // workstream is created, but the engine is still resolved for the cycle.
    const outcome = await runner.run({
      chainId: 'wrfc-late', originalTask: 'x', attempt: 1, commitScope: 'scoped',
      review: { version: 1, archetype: 'reviewer', summary: 's', score: 2, passed: false, dimensions: [], issues: [] } as never,
    });
    expect(reads).toBe(1);
    expect(outcome.status).toBe('failed');
  });
});

describe('read-only and delegation-phrased root asks', () => {
  test('the live-run-7 ask is read-only and a delegation instruction', () => {
    expect(askForbidsWrites(INCIDENT_ASK)).toBe(true);
    expect(askDelegatesToAgent(INCIDENT_ASK)).toBe(true);
    expect(askDelegatesToAgent('Spawn exactly one background agent whose task is: read src/net/retry.ts')).toBe(true);
  });

  test('implementation asks that fence writes are not read-only', () => {
    expect(askForbidsWrites('Fix the retry backoff in src/net/retry.ts. Do not modify files outside src/net.')).toBe(false);
    expect(askForbidsWrites('Build a token bucket limiter')).toBe(false);
    expect(askForbidsWrites('Run a WRFC review of retry.ts. Do not modify files.')).toBe(false);
    expect(askDelegatesToAgent('Fix the retry backoff')).toBe(false);
  });

  test('a read-only review ask spawns a plain agent with the delegated task, even with reviewMode wrfc and an engineer template', () => {
    const { controller, manager } = createHarness();
    const record = manager.spawn({
      mode: 'spawn',
      template: 'engineer',
      reviewMode: 'wrfc',
      task: INCIDENT_TASK,
      authoritativeTask: INCIDENT_ASK,
      tools: ['read', 'find'],
      restrictTools: true,
    });
    expect(record.task).toBe(INCIDENT_TASK);
    expect(record.reviewMode).toBe('none');
    expect(record.wrfcId ?? null).toBeNull();
    expect(record.wrfcRouteReason).toBe('root-read-only-ask');
    expect(controller.listChains()).toHaveLength(0);
  });

  test('a read-only ask with a reviewer template is not normalized into an owner chain', () => {
    const { controller, manager } = createHarness();
    const record = manager.spawn({
      mode: 'spawn',
      template: 'reviewer',
      task: INCIDENT_TASK,
      authoritativeTask: INCIDENT_ASK,
    });
    expect(record.template).toBe('reviewer');
    expect(record.task).toBe(INCIDENT_TASK);
    expect(controller.listChains()).toHaveLength(0);
  });

  test('a delegation-phrased implementation ask gives the chain the delegated task, not the delegation instruction', () => {
    const { controller, manager } = createHarness();
    const ask = 'Spawn one agent to review and fix the retry backoff in src/net/retry.ts.';
    const delegated = 'Review and fix the retry backoff in src/net/retry.ts so the delay doubles per attempt.';
    const record = manager.spawn({ mode: 'spawn', template: 'engineer', task: delegated, authoritativeTask: ask });
    expect(record.task).toBe(delegated);
    const chains = controller.listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]!.task).toBe(delegated);
  });
});
