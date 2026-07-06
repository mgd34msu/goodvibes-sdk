/**
 * Live-managers integration: the fleet registry over REAL manager
 * instances (AgentManager with a stub executor, ProcessManager spawning a
 * real shell command, createWorkflowServices(), a real RuntimeEventBus).
 * Proves the narrow structural deps match the real classes and that the
 * end-to-end flow (spawn → events → derived state → control dispatch) holds
 * without any stubbed read surface.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import { AgentManager } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import { createWorkflowServices } from '../packages/sdk/src/platform/tools/workflow/index.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeAgentManager(bus: RuntimeEventBus): AgentManager {
  const manager = new AgentManager({
    configManager: { get: () => null },
    messageBus: { registerAgent() { /* no-op */ } },
    archetypeLoader: { loadArchetype: () => null },
    executor: {
      async runAgent(record) {
        // Mirrors orchestrator-runner: mutate the exact AgentRecord in place.
        record.status = 'running';
        await new Promise((resolve) => setTimeout(resolve, 50));
        record.usage = {
          inputTokens: 500,
          outputTokens: 120,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          llmCallCount: 2,
          turnCount: 2,
          reasoningSummaryCount: 0,
        };
        record.toolCallCount = 3;
        record.status = 'completed';
        record.completedAt = Date.now();
      },
    },
  });
  manager.setRuntimeBus(bus);
  return manager;
}

describe('fleet registry — live managers integration', () => {
  test('real AgentManager + ProcessManager + workflow services flow through query/kill', async () => {
    const bus = new RuntimeEventBus();
    const agentManager = makeAgentManager(bus);
    const processManager = new ProcessManager();
    const workflow = createWorkflowServices();

    const registry = createProcessRegistry({
      agentManager,
      wrfcController: { listChains: () => [] },
      processManager,
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: workflow.workflowManager,
        triggerManager: workflow.triggerManager,
        scheduleManager: workflow.scheduleManager,
      },
      runtimeBus: bus,
    });

    try {
      // Agent: spawn through the real manager, observe the node lifecycle.
      const spawned = agentManager.spawn({
        mode: 'spawn',
        task: 'integration probe',
        dangerously_disable_wrfc: true,
      });
      const agentId = spawned.id;
      expect(registry.getNode(agentId)).not.toBeNull();
      await until(() => registry.getNode(agentId)?.state === 'done');
      const agentNode = registry.getNode(agentId);
      expect(agentNode?.usage?.inputTokens).toBe(500);
      expect(agentNode?.usage?.toolCallCount).toBe(3);
      expect(agentNode?.costUsd).toBeNull(); // no priceUsage injected → honest unpriced
      expect(agentNode?.costState).toBe('unpriced');

      // Background process: real spawn, real completion, real stdout tail.
      const bg = await processManager.spawn('echo fleet-hello', undefined, undefined);
      const bgId = bg.process_id;
      if (!bgId) throw new Error('spawn did not return a process_id');
      await until(() => registry.getNode(bgId)?.state === 'done');
      expect(registry.getNode(bgId)?.currentActivity?.text).toBe('fleet-hello');

      // Workflow FSM + trigger + schedule from the real managers.
      const instance = workflow.workflowManager.start('wrfc', 'ship it');
      const trigger = workflow.triggerManager.add({ event: 'push', action: 'test' });
      workflow.scheduleManager.add('fleet-nightly', '1h', 'true');

      expect(registry.getNode(instance.id)?.kind).toBe('workflow');
      expect(registry.getNode(trigger.id)?.state).toBe('idle');
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('idle');

      // Control dispatch end-to-end against the real managers.
      expect(registry.kill(instance.id)).toEqual([instance.id]);
      expect(workflow.workflowManager.getStatus(instance.id)?.cancelled).toBe(true);
      expect(registry.interrupt('schedule:fleet-nightly')).toBe(true);
      // Pause/resume through the registry: disabled is 'paused', NOT 'killed' — the entry
      // still exists and ScheduleManager.enable() can re-arm it.
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('paused');
      expect(registry.getNode('schedule:fleet-nightly')?.capabilities.resumable).toBe(true);
      // resume() round-trips against the REAL ScheduleManager.
      expect(registry.resume('schedule:fleet-nightly')).toBe(true);
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('idle');
      expect(registry.getNode('schedule:fleet-nightly')?.capabilities.resumable).toBe(false);
      // Already armed — resume() honestly refuses (nothing to resume).
      expect(registry.resume('schedule:fleet-nightly')).toBe(false);
      expect(registry.kill(trigger.id)).toEqual([trigger.id]);
      expect(registry.getNode(trigger.id)).toBeNull(); // removed

      // A snapshot over the live fleet keeps parent edges resolvable.
      const snapshot = registry.query();
      const ids = new Set(snapshot.nodes.map((node) => node.id));
      for (const node of snapshot.nodes) {
        if (node.parentId !== undefined) expect(ids.has(node.parentId)).toBe(true);
      }
    } finally {
      registry.dispose();
      workflow.scheduleManager.destroy();
    }
  });

  test('subscribe over live managers delivers a changed snapshot within a tick', async () => {
    const bus = new RuntimeEventBus();
    const agentManager = makeAgentManager(bus);
    const workflow = createWorkflowServices();
    const registry = createProcessRegistry({
      agentManager,
      wrfcController: { listChains: () => [] },
      processManager: new ProcessManager(),
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: workflow.workflowManager,
        triggerManager: workflow.triggerManager,
        scheduleManager: workflow.scheduleManager,
      },
      runtimeBus: bus,
      tickIntervalMs: 25,
    });
    try {
      const snapshots: number[] = [];
      registry.subscribe((snapshot) => snapshots.push(snapshot.nodes.length));
      agentManager.spawn({ mode: 'spawn', task: 'tick probe', dangerously_disable_wrfc: true });
      await until(() => snapshots.length > 0);
      expect(snapshots[snapshots.length - 1]).toBe(1);
    } finally {
      registry.dispose();
      workflow.scheduleManager.destroy();
    }
  });
});
