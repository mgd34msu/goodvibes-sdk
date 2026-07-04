/**
 * W4.1 (wo701) — orchestration-engine fleet adapters: Workstream/Phase/
 * WorkItem -> ProcessNode shape, parentId nesting, per-kind capabilities,
 * and registry-level kill/steer dispatch (kill routes through
 * orchestrationEngine.kill, not a raw AgentManager.cancel cascade).
 */
import { describe, expect, test } from 'bun:test';
import {
  activeWorkItemAgentId,
  adaptPhase,
  adaptWorkItem,
  adaptWorkstream,
  phaseNodeId,
  workItemNodeId,
  workstreamNodeId,
} from '../packages/sdk/src/platform/runtime/fleet/adapters/orchestration.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { Phase, WorkItem, Workstream } from '../packages/sdk/src/platform/orchestration/types.js';
import { emptyWorkItemUsage } from '../packages/sdk/src/platform/orchestration/types.js';

const T0 = 1_750_000_000_000;

function makePhase(overrides: Partial<Phase> & { id: string; ordinal: number }): Phase {
  return { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'scoped', gates: [] }, ...overrides };
}

function makeItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: 'item',
    task: 'do work',
    currentPhaseId: null,
    state: 'pending',
    allAgentIds: [],
    visits: new Map(),
    touchedPaths: [],
    usage: emptyWorkItemUsage(),
    transportRetryCount: 0,
    createdAt: T0,
    ...overrides,
  };
}

function makeWorkstream(overrides: Partial<Workstream> & { id: string }): Workstream {
  return {
    title: 'ws',
    schemaVersion: 1,
    phases: [],
    items: [],
    createdAt: T0,
    ...overrides,
  };
}

describe('adapters/orchestration — node id namespacing', () => {
  test('ids never collide with agent/process/chain ids', () => {
    expect(workstreamNodeId('a')).toBe('workstream:a');
    expect(phaseNodeId('a', 'b')).toBe('phase:a:b');
    expect(workItemNodeId('a')).toBe('work-item:a');
  });
});

describe('adaptWorkItem', () => {
  test('delegates interruptible/killable/steerable to its currently-active agent', () => {
    const pending = makeItem({ id: 'i1', state: 'pending' });
    const pendingNode = adaptWorkItem(pending, 'ws1', 'phase:ws1:p1', { steerable: true });
    expect(pendingNode.capabilities).toEqual({ interruptible: false, killable: true, pausable: false, steerable: false });

    const running = makeItem({ id: 'i2', state: 'in-phase', agentId: 'agent-1' });
    const runningNode = adaptWorkItem(running, 'ws1', 'phase:ws1:p1', { steerable: true });
    expect(runningNode.capabilities).toEqual({ interruptible: true, killable: true, pausable: false, steerable: true });
    expect(runningNode.sessionRef).toEqual({ agentId: 'agent-1' });

    const passed = makeItem({ id: 'i3', state: 'passed', completedAt: T0 + 10 });
    const passedNode = adaptWorkItem(passed, 'ws1', 'workstream:ws1', { steerable: true });
    expect(passedNode.capabilities.killable).toBe(false);
    expect(passedNode.state).toBe('done');
  });

  test('blocked-budget maps to the honest "stalled" state, distinct from queued', () => {
    const item = makeItem({ id: 'i1', state: 'blocked-budget' });
    const node = adaptWorkItem(item, 'ws1', 'workstream:ws1', { steerable: false });
    expect(node.state).toBe('stalled');
  });
});

describe('adaptPhase — pure grouping node', () => {
  test('reports zero usage/cost even when its work items have real usage (no double count)', () => {
    const phase = makePhase({ id: 'p1', ordinal: 1 });
    const item = makeItem({
      id: 'i1',
      currentPhaseId: 'p1',
      usage: { ...emptyWorkItemUsage(), inputTokens: 100, costUsd: 1.5, costState: 'priced' },
    });
    const workstream = makeWorkstream({ id: 'ws1', phases: [phase], items: [item] });
    const node = adaptPhase(phase, workstream);
    expect(node.usage).toBeUndefined();
    expect(node.costUsd).toBeNull();
    expect(node.costState).toBe('unpriced');
    expect(node.capabilities).toEqual({ interruptible: false, killable: false, pausable: false, steerable: false });
  });
});

describe('adaptWorkstream — sums every item exactly once', () => {
  test('cost/usage totals come from items directly, never via phase (adaptPhase reports nothing)', () => {
    const phase = makePhase({ id: 'p1', ordinal: 1 });
    const itemA = makeItem({ id: 'i1', currentPhaseId: 'p1', usage: { ...emptyWorkItemUsage(), inputTokens: 100, outputTokens: 50, costUsd: 1, costState: 'priced' } });
    const itemB = makeItem({ id: 'i2', currentPhaseId: 'p1', usage: { ...emptyWorkItemUsage(), inputTokens: 20, outputTokens: 10, costUsd: 0.5, costState: 'priced' } });
    const workstream = makeWorkstream({ id: 'ws1', phases: [phase], items: [itemA, itemB] });
    const node = adaptWorkstream(workstream, T0 + 100);
    expect(node.usage?.inputTokens).toBe(120);
    expect(node.usage?.outputTokens).toBe(60);
    expect(node.costUsd).toBe(1.5);
    expect(node.costState).toBe('priced');
    expect(node.parentId).toBeUndefined();
  });

  test('done only once every item is terminal', () => {
    const phase = makePhase({ id: 'p1', ordinal: 1 });
    const items = [makeItem({ id: 'i1', state: 'passed' }), makeItem({ id: 'i2', state: 'in-phase' })];
    const workstream = makeWorkstream({ id: 'ws1', phases: [phase], items });
    expect(adaptWorkstream(workstream, T0).state).toBe('executing-tool');
    items[1]!.state = 'passed';
    expect(adaptWorkstream(workstream, T0).state).toBe('done');
  });
});

describe('registry integration — nesting + kill/steer dispatch', () => {
  function makeRegistryHarness() {
    const killCalls: string[] = [];
    const cancelCalls: string[] = [];
    const phase = makePhase({ id: 'p1', ordinal: 1 });
    const item = makeItem({ id: 'i1', currentPhaseId: 'p1', state: 'in-phase', agentId: 'agent-1', allAgentIds: ['agent-1'] });
    const workstream = makeWorkstream({ id: 'ws1', phases: [phase], items: [item] });

    const registry = createProcessRegistry({
      agentManager: { list: () => [], cancel: (id: string) => { cancelCalls.push(id); return true; } },
      wrfcController: { listChains: () => [] },
      orchestrationEngine: {
        listWorkstreams: () => [workstream],
        // Idempotent, mirroring the real engine.kill(): a second call on an
        // already-terminal item (e.g. reached via a cascade's descendant
        // pass, then again via the workstream's own item roster) is a no-op
        // refusal, not a double-kill.
        kill: (itemId: string) => {
          if (item.state === 'failed') return false;
          killCalls.push(itemId);
          item.state = 'failed';
          return true;
        },
      },
      processManager: { list: () => [], stop: () => false, getStatus: () => null },
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [], remove: () => false, disable: () => false },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false },
      },
      messageBus: { send: () => true },
    });

    return { registry, workstream, phase, item, killCalls, cancelCalls };
  }

  test('workstream -> phase -> work-item nests via parentId with zero new tree code', () => {
    const { registry, workstream, phase, item } = makeRegistryHarness();
    const snapshot = registry.query();
    const wsNode = snapshot.nodes.find((n) => n.id === workstreamNodeId(workstream.id))!;
    const phaseNode = snapshot.nodes.find((n) => n.id === phaseNodeId(workstream.id, phase.id))!;
    const itemNode = snapshot.nodes.find((n) => n.id === workItemNodeId(item.id))!;
    expect(wsNode.parentId).toBeUndefined();
    expect(phaseNode.parentId).toBe(wsNode.id);
    expect(itemNode.parentId).toBe(phaseNode.id);
  });

  test('kill on a work-item node routes through orchestrationEngine.kill, not a raw agent cascade', () => {
    const { registry, item, killCalls, cancelCalls } = makeRegistryHarness();
    const affected = registry.kill(workItemNodeId(item.id));
    expect(killCalls).toEqual([item.id]);
    expect(cancelCalls).toEqual([]); // the registry did not call agentManager.cancel directly
    expect(affected).toContain(workItemNodeId(item.id));
  });

  test('cascade kill on the workstream kills every one of its items through the engine', () => {
    const { registry, workstream, killCalls } = makeRegistryHarness();
    registry.kill(workstreamNodeId(workstream.id), { cascade: true });
    expect(killCalls).toEqual(['i1']);
  });

  test('steer on a live work-item routes to its active agent via the message bus', () => {
    const sent: Array<{ to: string; text: string }> = [];
    const phase = makePhase({ id: 'p1', ordinal: 1 });
    const item = makeItem({ id: 'i1', currentPhaseId: 'p1', state: 'in-phase', agentId: 'agent-1' });
    const workstream = makeWorkstream({ id: 'ws1', phases: [phase], items: [item] });
    const liveAgent = {
      id: 'agent-1',
      task: 'do work',
      template: 'engineer',
      tools: [],
      status: 'running' as const,
      startedAt: Date.now(),
      toolCallCount: 0,
      orchestrationDepth: 0,
      executionProtocol: 'direct' as const,
      reviewMode: 'none' as const,
      communicationLane: 'parent-only' as const,
    };
    const registry = createProcessRegistry({
      // adaptWorkItem's `steerable` requires the active agent to actually be
      // present (and non-terminal) in this snapshot — mirrors how a
      // wrfc-subtask's steerable is gated on its live member agent.
      agentManager: { list: () => [liveAgent], cancel: () => true },
      wrfcController: { listChains: () => [] },
      orchestrationEngine: { listWorkstreams: () => [workstream], kill: () => true },
      processManager: { list: () => [], stop: () => false, getStatus: () => null },
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: { list: () => [], cancel: () => false },
        triggerManager: { list: () => [], remove: () => false, disable: () => false },
        scheduleManager: { list: () => [], remove: () => false, disable: () => false },
      },
      messageBus: {
        send: (from: string, to: string, text: string) => {
          sent.push({ to, text });
          return true;
        },
      },
    });
    const result = registry.steer(workItemNodeId(item.id), 'please slow down');
    expect(result.queued).toBe(true);
    expect(sent).toEqual([{ to: 'agent-1', text: 'please slow down' }]);
  });

  test('an aggregate node (workstream/phase) honestly refuses steer', () => {
    const { registry, workstream, phase } = makeRegistryHarness();
    expect(registry.steer(workstreamNodeId(workstream.id), 'hi').queued).toBe(false);
    expect(registry.steer(phaseNodeId(workstream.id, phase.id), 'hi').queued).toBe(false);
  });
});

describe('activeWorkItemAgentId', () => {
  test('only defined while the item is actually in-phase', () => {
    expect(activeWorkItemAgentId(makeItem({ id: 'i1', state: 'in-phase', agentId: 'a1' }))).toBe('a1');
    expect(activeWorkItemAgentId(makeItem({ id: 'i1', state: 'awaiting-capacity', agentId: 'a1' }))).toBeUndefined();
    expect(activeWorkItemAgentId(makeItem({ id: 'i1', state: 'passed', agentId: 'a1' }))).toBeUndefined();
  });
});
