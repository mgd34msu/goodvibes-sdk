/**
 * W2.1 — Live process registry (packages/sdk/src/platform/runtime/fleet/).
 *
 * Covers the brief's test matrix with stub managers:
 *  1. Per-kind adapter mapping (agent/chain/subtask/workflow/trigger/schedule/watcher/background-process).
 *  2. Fine-grained agent state via REAL runtime-bus emitters (no synthetic event shapes).
 *  3. Stalled derivation with an injected now().
 *  4. awaiting-approval cross-reference via approvalBroker.listApprovals().
 *  5. Cost honesty (unknown model → costUsd null + 'unpriced'; never throws).
 *  6. chain → subtask → agent edge/nesting integrity (no dangling parentIds).
 *  7. subscribe/tick coalescing, unref, dispose.
 *  8. Control dispatch (interrupt/kill routing incl. derived chain-kill cascade).
 * 10. Empty fleet → empty snapshot, no throw.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type {
  ProcessNode,
  ProcessRegistry,
} from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps, RegistryTimers } from '../packages/sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { WrfcChain, WrfcSubtask } from '../packages/sdk/src/platform/agents/wrfc-types.js';
import type { BackgroundProcess } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import type { WatcherRecord } from '../packages/sdk/src/platform/runtime/store/domains/watchers.js';
import type {
  ScheduleEntry,
  TriggerDefinition,
  WorkflowInstance,
} from '../packages/sdk/src/platform/tools/workflow/index.js';
import type { SharedApprovalRecord } from '../packages/sdk/src/platform/control-plane/approval-broker.js';
import type { SharedSessionRecord } from '../packages/sdk/src/platform/control-plane/session-types.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import {
  emitAgentAwaitingMessage,
  emitAgentAwaitingTool,
  emitAgentCompleted,
  emitAgentFailed,
  emitAgentProgress,
  emitAgentStreamDelta,
} from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import { emitStreamRetry } from '../packages/sdk/src/platform/runtime/emitters/turn.js';
import type { EmitterContext } from '../packages/sdk/src/platform/runtime/emitters/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T0 = 1_750_000_000_000;

function makeAgent(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'do work',
    template: 'engineer',
    tools: [],
    status: 'running',
    startedAt: T0,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

function makeChain(overrides: Partial<WrfcChain> & { id: string }): WrfcChain {
  return {
    state: 'engineering',
    task: 'chain task',
    ownerAgentId: 'owner-1',
    allAgentIds: [],
    fixAttempts: 0,
    reviewCycles: 0,
    createdAt: T0,
    reviewScores: [],
    ownerDecisions: [],
    ...overrides,
  };
}

function makeSubtask(overrides: Partial<WrfcSubtask> & { id: string }): WrfcSubtask {
  return {
    title: 'subtask',
    task: 'subtask work',
    state: 'engineering',
    fixAttempts: 0,
    reviewCycles: 0,
    reviewScores: [],
    constraints: [],
    constraintsEnumerated: false,
    ...overrides,
  };
}

function makeWatcher(overrides: Partial<WatcherRecord> & { id: string }): WatcherRecord {
  return {
    kind: 'polling',
    label: 'my watcher',
    state: 'running',
    source: {
      id: 'src-1',
      kind: 'watcher',
      label: 'src',
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
      metadata: {},
    },
    metadata: {},
    ...overrides,
  };
}

function makeBackgroundProcess(overrides: Partial<BackgroundProcess> & { id: string }): BackgroundProcess {
  return {
    pid: 4242,
    cmd: 'sleep 999',
    startTime: T0,
    stdout: [],
    stderr: [],
    exitCode: null,
    done: false,
    killDeadline: null,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<SharedApprovalRecord> & { id: string }): SharedApprovalRecord {
  return {
    callId: 'call-1',
    status: 'pending',
    request: {
      callId: 'call-1',
      tool: 'exec',
      args: {},
      category: 'execute',
      analysis: { classification: 'shell', riskLevel: 'medium', summary: 'run command', reasons: [] },
    },
    createdAt: T0,
    updatedAt: T0,
    metadata: {},
    audit: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<SharedSessionRecord> & { id: string }): SharedSessionRecord {
  return {
    kind: 'tui',
    title: 'session',
    status: 'active',
    createdAt: T0,
    updatedAt: T0,
    lastActivityAt: T0,
    messageCount: 0,
    pendingInputCount: 0,
    routeIds: [],
    surfaceKinds: [],
    participants: [],
    metadata: {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  return {
    agentManager: { list: () => [], cancel: () => false },
    wrfcController: { listChains: () => [] },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false },
    },
    now: () => T0 + 5_000,
    ...overrides,
  };
}

function nodeById(registry: ProcessRegistry, id: string): ProcessNode {
  const node = registry.getNode(id);
  if (!node) throw new Error(`node not found: ${id}`);
  return node;
}

const emitterCtx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

/** RuntimeEventBus dispatches listeners via queueMicrotask — flush before asserting. */
function flushBus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── 10. Empty fleet ───────────────────────────────────────────────────────────

describe('fleet registry — empty fleet', () => {
  test('query() over empty managers returns an empty snapshot, no throw', () => {
    const registry = createProcessRegistry(makeDeps());
    const snapshot = registry.query();
    expect(snapshot.nodes).toEqual([]);
    expect(snapshot.capturedAt).toBe(T0 + 5_000);
    expect(registry.getNode('nope')).toBeNull();
    registry.dispose();
  });
});

// ── 1. Adapter mapping ────────────────────────────────────────────────────────

describe('fleet registry — adapter mapping', () => {
  test('agent node: usage passthrough, coarse status mapping, capabilities', () => {
    const agent = makeAgent({
      id: 'ag-1',
      status: 'completed',
      completedAt: T0 + 2_000,
      model: 'claude-fable-5',
      provider: 'anthropic',
      toolCallCount: 7,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        llmCallCount: 3,
        turnCount: 2,
      },
    });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    const node = nodeById(registry, 'ag-1');
    expect(node.kind).toBe('agent');
    expect(node.state).toBe('done');
    expect(node.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: undefined,
      llmCallCount: 3,
      turnCount: 2,
      toolCallCount: 7,
    });
    expect(node.model).toBe('claude-fable-5');
    expect(node.provider).toBe('anthropic');
    expect(node.elapsedMs).toBe(2_000);
    expect(node.capabilities).toEqual({ interruptible: false, killable: false, pausable: false });
    expect(node.sessionRef?.agentId).toBe('ag-1');
    registry.dispose();
  });

  test('agent coarse statuses: pending→queued, cancelled→killed, failed→failed; live agents are killable', () => {
    const agents = [
      makeAgent({ id: 'a-pending', status: 'pending' }),
      makeAgent({ id: 'a-cancelled', status: 'cancelled' }),
      makeAgent({ id: 'a-failed', status: 'failed' }),
      makeAgent({ id: 'a-running', status: 'running' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
    }));
    expect(nodeById(registry, 'a-pending').state).toBe('queued');
    expect(nodeById(registry, 'a-cancelled').state).toBe('killed');
    expect(nodeById(registry, 'a-failed').state).toBe('failed');
    // No runtimeBus → coarse fallback for running (never crash, never stalled).
    expect(nodeById(registry, 'a-running').state).toBe('executing-tool');
    expect(nodeById(registry, 'a-running').capabilities.killable).toBe(true);
    expect(nodeById(registry, 'a-pending').capabilities.interruptible).toBe(true);
    registry.dispose();
  });

  // W3.1 Part A2: terminationKind splits the single 'cancelled' status into
  // two display states without touching `status` itself.
  test('cancelled agent: terminationKind splits killed vs interrupted; missing/unknown kind defaults to killed', () => {
    const agents = [
      makeAgent({ id: 'a-kill', status: 'cancelled', terminationKind: 'kill' }),
      makeAgent({ id: 'a-interrupt', status: 'cancelled', terminationKind: 'interrupt' }),
      // Records cancelled before terminationKind existed (or via the
      // single-arg cancel(id) call, which defaults to 'kill') have no field.
      makeAgent({ id: 'a-legacy', status: 'cancelled' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
    }));
    expect(nodeById(registry, 'a-kill').state).toBe('killed');
    expect(nodeById(registry, 'a-interrupt').state).toBe('interrupted');
    expect(nodeById(registry, 'a-legacy').state).toBe('killed');
    registry.dispose();
  });

  test('parentId precedence: wrfcSubtaskId > wrfcId > parentNodeId(resolved) > parentAgentId', () => {
    const chain = makeChain({
      id: 'ch-1',
      ownerAgentId: 'owner-1',
      allAgentIds: ['owner-1', 'a-sub', 'a-chain'],
      subtasks: [makeSubtask({ id: 'st-1' })],
    });
    const agents = [
      makeAgent({ id: 'owner-1', wrfcId: 'ch-1', wrfcRole: 'owner' }),
      makeAgent({ id: 'a-sub', wrfcSubtaskId: 'st-1', wrfcId: 'ch-1' }),
      makeAgent({ id: 'a-chain', wrfcId: 'ch-1' }),
      makeAgent({ id: 'a-orch-parent', orchestrationNodeId: 'node-9' }),
      makeAgent({ id: 'a-orch-child', parentNodeId: 'node-9' }),
      makeAgent({ id: 'a-plain-child', parentAgentId: 'a-orch-parent' }),
      makeAgent({ id: 'a-dangling', wrfcId: 'missing-chain', parentAgentId: 'a-orch-parent' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
    }));
    expect(nodeById(registry, 'a-sub').parentId).toBe('subtask:st-1');
    expect(nodeById(registry, 'a-chain').parentId).toBe('chain:ch-1');
    expect(nodeById(registry, 'owner-1').parentId).toBe('chain:ch-1');
    expect(nodeById(registry, 'a-orch-child').parentId).toBe('a-orch-parent');
    expect(nodeById(registry, 'a-plain-child').parentId).toBe('a-orch-parent');
    // Dangling wrfcId falls through to the next resolvable edge.
    expect(nodeById(registry, 'a-dangling').parentId).toBe('a-orch-parent');
    registry.dispose();
  });

  test('chain node: state map, subtask children, usage/cost aggregation excludes owner', () => {
    const chain = makeChain({
      id: 'ch-2',
      state: 'reviewing',
      ownerAgentId: 'owner-2',
      allAgentIds: ['owner-2', 'eng-1'],
      subtasks: [makeSubtask({ id: 'st-a', state: 'passed' }), makeSubtask({ id: 'st-b', state: 'pending' })],
    });
    const usage = {
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmCallCount: 1, turnCount: 1,
    };
    const agents = [
      // Owner usage mirrors children at completion — must NOT be double-counted.
      makeAgent({ id: 'owner-2', wrfcId: 'ch-2', usage: { ...usage }, toolCallCount: 5 }),
      makeAgent({ id: 'eng-1', wrfcId: 'ch-2', usage: { ...usage }, toolCallCount: 5, model: 'm1' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
      priceUsage: () => 0.5,
    }));
    const chainNode = nodeById(registry, 'chain:ch-2');
    expect(chainNode.kind).toBe('wrfc-chain');
    expect(chainNode.state).toBe('executing-tool');
    expect(chainNode.currentActivity?.text).toBe('reviewing');
    expect(chainNode.usage?.inputTokens).toBe(1000); // eng-1 only, owner excluded
    expect(chainNode.costUsd).toBe(0.5);
    expect(chainNode.costState).toBe('priced');
    const stA = nodeById(registry, 'subtask:st-a');
    expect(stA.kind).toBe('wrfc-subtask');
    expect(stA.parentId).toBe('chain:ch-2');
    expect(stA.state).toBe('done');
    expect(nodeById(registry, 'subtask:st-b').state).toBe('queued');
    registry.dispose();
  });

  test('chain terminal + retrying states', () => {
    const chains = [
      makeChain({ id: 'ch-passed', state: 'passed', completedAt: T0 + 100 }),
      makeChain({ id: 'ch-failed', state: 'failed' }),
      makeChain({ id: 'ch-pending', state: 'pending' }),
      // transport retry recorded, no live member → the respawn window.
      makeChain({ id: 'ch-retry', state: 'engineering', transportRetryCount: 1, allAgentIds: ['gone-1'] }),
    ];
    const registry = createProcessRegistry(makeDeps({
      wrfcController: { listChains: () => [...chains] },
    }));
    expect(nodeById(registry, 'chain:ch-passed').state).toBe('done');
    expect(nodeById(registry, 'chain:ch-failed').state).toBe('failed');
    expect(nodeById(registry, 'chain:ch-pending').state).toBe('queued');
    expect(nodeById(registry, 'chain:ch-retry').state).toBe('retrying');
    registry.dispose();
  });

  // W3.1 Part A4: chain terminal truth. WrfcController has no cancel/abort of
  // its own, so a cascade kill (registry.ts kill('chain:<id>')) only cancels
  // the member agents — chain.state never leaves whatever active phase it was
  // in when killed. Before the fix this rendered 'executing-tool' forever
  // with elapsedMs climbing on every query() (the replay-found leak).
  // Regression: two registries at very different `now` values over the SAME
  // killed-chain snapshot must report the identical, frozen elapsedMs.
  test('chain killed via cascade: chain.state stuck in an active phase, every member terminal → derived killed + elapsedMs frozen at max(member.completedAt), owner excluded', () => {
    const chain = makeChain({
      id: 'ch-cascade-killed',
      state: 'engineering', // WrfcController never moved this off the active phase
      ownerAgentId: 'own-z',
      allAgentIds: ['own-z', 'm1-z', 'm2-z'],
      createdAt: T0,
    });
    const agents = [
      // Owner's completedAt is deliberately the LATEST of the three so that,
      // if aggregateCost's owner-exclusion rule were ever violated here too,
      // this assertion would catch it (expected elapsedMs comes from m2-z).
      makeAgent({ id: 'own-z', wrfcId: 'ch-cascade-killed', status: 'cancelled', terminationKind: 'kill', startedAt: T0, completedAt: T0 + 9_000 }),
      makeAgent({ id: 'm1-z', wrfcId: 'ch-cascade-killed', status: 'cancelled', terminationKind: 'kill', startedAt: T0, completedAt: T0 + 3_000 }),
      makeAgent({ id: 'm2-z', wrfcId: 'ch-cascade-killed', status: 'cancelled', terminationKind: 'interrupt', startedAt: T0, completedAt: T0 + 5_000 }),
    ];
    const registryEarly = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
      now: () => T0 + 6_000,
    }));
    const registryLater = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
      now: () => T0 + 60_000, // a full minute later — elapsed must NOT have climbed
    }));
    const nodeEarly = nodeById(registryEarly, 'chain:ch-cascade-killed');
    const nodeLater = nodeById(registryLater, 'chain:ch-cascade-killed');
    expect(nodeEarly.state).toBe('killed');
    expect(nodeLater.state).toBe('killed');
    expect(nodeEarly.completedAt).toBe(T0 + 5_000);
    expect(nodeEarly.elapsedMs).toBe(5_000);
    expect(nodeLater.elapsedMs).toBe(5_000); // frozen, not climbing with `now`
    expect(nodeEarly.capabilities.killable).toBe(false); // already terminal
    registryEarly.dispose();
    registryLater.dispose();
  });

  test('chain retrying takes precedence over the killed-derivation during an in-flight transport respawn', () => {
    const chain = makeChain({
      id: 'ch-retry-real',
      state: 'engineering',
      ownerAgentId: 'own-r',
      allAgentIds: ['own-r', 'm1-r'],
      transportRetryCount: 1,
    });
    const agents = [
      makeAgent({ id: 'own-r', wrfcId: 'ch-retry-real', status: 'running' }),
      // The failed transport attempt is terminal, but this is the respawn
      // window (retryCount > 0), not an operator kill.
      makeAgent({ id: 'm1-r', wrfcId: 'ch-retry-real', status: 'failed', completedAt: T0 + 1_000 }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
    }));
    expect(nodeById(registry, 'chain:ch-retry-real').state).toBe('retrying');
    registry.dispose();
  });

  test('workflow / trigger / schedule nodes', () => {
    const workflow: WorkflowInstance = {
      id: 'wf-1', definition: 'review-cycle', currentState: 'reviewing', task: 'wf task',
      startedAt: T0, transitions: 2, context: {},
    };
    const cancelled: WorkflowInstance = { ...workflow, id: 'wf-2', cancelled: true, completedAt: T0 + 50 };
    const trigger: TriggerDefinition = { id: 'trg-1', event: 'push', action: 'run tests', enabled: true };
    const schedule: ScheduleEntry = {
      name: 'nightly', interval: '1h', command: 'make build', enabled: false, lastRun: T0,
    };
    const registry = createProcessRegistry(makeDeps({
      workflow: {
        workflowManager: { list: () => [workflow, cancelled], cancel: () => false },
        triggerManager: { list: () => [trigger], remove: () => false, disable: () => false },
        scheduleManager: { list: () => [schedule], remove: () => false, disable: () => false },
      },
    }));
    const wfNode = nodeById(registry, 'wf-1');
    expect(wfNode.kind).toBe('workflow');
    expect(wfNode.state).toBe('executing-tool');
    expect(wfNode.currentActivity?.text).toBe('reviewing');
    expect(nodeById(registry, 'wf-2').state).toBe('killed');
    const trgNode = nodeById(registry, 'trg-1');
    expect(trgNode.kind).toBe('trigger');
    expect(trgNode.state).toBe('idle');
    expect(trgNode.capabilities.pausable).toBe(true);
    const schNode = nodeById(registry, 'schedule:nightly');
    expect(schNode.kind).toBe('schedule');
    expect(schNode.state).toBe('killed'); // disabled
    expect(schNode.startedAt).toBe(T0);
    registry.dispose();
  });

  test('watcher nodes: running→idle, degraded→stalled, failed→failed, stopped→killed', () => {
    const watchers = [
      makeWatcher({ id: 'w-run', state: 'running' }),
      makeWatcher({ id: 'w-deg', state: 'degraded', degradedReason: 'heartbeat stale by 99999ms' }),
      makeWatcher({ id: 'w-fail', state: 'failed', lastError: 'boom' }),
      makeWatcher({ id: 'w-stop', state: 'stopped' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      watcherRegistry: { list: () => [...watchers], stopWatcher: () => null },
    }));
    expect(nodeById(registry, 'w-run').state).toBe('idle');
    const degraded = nodeById(registry, 'w-deg');
    expect(degraded.state).toBe('stalled');
    expect(degraded.currentActivity?.text).toBe('heartbeat stale by 99999ms');
    expect(nodeById(registry, 'w-fail').state).toBe('failed');
    expect(nodeById(registry, 'w-stop').state).toBe('killed');
    expect(nodeById(registry, 'w-run').capabilities.killable).toBe(true);
    expect(nodeById(registry, 'w-stop').capabilities.killable).toBe(false);
    registry.dispose();
  });

  test('background-process nodes: running / done / failed, last stdout line as activity', () => {
    const records: BackgroundProcess[] = [
      makeBackgroundProcess({ id: 'bg-run', stdout: ['building...\ncompiling foo\n', 'linking bar\n'] }),
      makeBackgroundProcess({ id: 'bg-done', done: true, exitCode: 0, completedAt: T0 + 500 }),
      makeBackgroundProcess({ id: 'bg-fail', done: true, exitCode: 3, completedAt: T0 + 500 }),
    ];
    const byId = new Map(records.map((record) => [record.id, record]));
    const registry = createProcessRegistry(makeDeps({
      processManager: {
        list: () => records.map((record) => ({ id: record.id, pid: record.pid, cmd: record.cmd, status: 'x' })),
        stop: () => false,
        getStatus: (id: string) => byId.get(id),
      },
    }));
    const running = nodeById(registry, 'bg-run');
    expect(running.kind).toBe('background-process');
    expect(running.state).toBe('executing-tool');
    expect(running.currentActivity).toEqual({ kind: 'output-line', text: 'linking bar', at: T0 });
    expect(running.capabilities.killable).toBe(true);
    expect(nodeById(registry, 'bg-done').state).toBe('done');
    expect(nodeById(registry, 'bg-fail').state).toBe('failed');
    registry.dispose();
  });

  test('query filter narrows by kind and state', () => {
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [makeAgent({ id: 'a1', status: 'completed', completedAt: T0 })],
        cancel: () => false,
      },
      wrfcController: { listChains: () => [makeChain({ id: 'c1', state: 'engineering' })] },
    }));
    expect(registry.query({ kinds: ['agent'] }).nodes.map((node) => node.id)).toEqual(['a1']);
    expect(registry.query({ states: ['done'] }).nodes.map((node) => node.id)).toEqual(['a1']);
    expect(registry.query({ kinds: ['wrfc-chain'], states: ['done'] }).nodes).toEqual([]);
    registry.dispose();
  });
});

// ── 2. Fine-grained states from REAL bus emitters ─────────────────────────────

describe('fleet registry — activity side-table via runtime bus', () => {
  function busSetup(agent: AgentRecord): { registry: ProcessRegistry; bus: RuntimeEventBus } {
    const bus = new RuntimeEventBus();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000, // within stalled threshold of every event stamp
    }));
    return { registry, bus };
  }

  test('event sequence drives thinking → executing-tool(+tool) → streaming → done', async () => {
    const agent = makeAgent({ id: 'ag-live' });
    const { registry, bus } = busSetup(agent);

    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-live' });
    await flushBus();
    expect(nodeById(registry, 'ag-live').state).toBe('thinking');

    emitAgentAwaitingTool(bus, emitterCtx, { agentId: 'ag-live', callId: 'c1', tool: 'exec' });
    await flushBus();
    const toolNode = nodeById(registry, 'ag-live');
    expect(toolNode.state).toBe('executing-tool');
    expect(toolNode.currentActivity).toMatchObject({ kind: 'tool', text: 'exec', toolName: 'exec' });

    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-live', content: 'x', accumulated: 'x' });
    await flushBus();
    const streamingNode = nodeById(registry, 'ag-live');
    expect(streamingNode.state).toBe('streaming');
    // Prior activity carries forward through non-activity events.
    expect(streamingNode.currentActivity?.toolName).toBe('exec');

    emitAgentProgress(bus, emitterCtx, { agentId: 'ag-live', progress: 'Turn 3 · edit' });
    await flushBus();
    const progressNode = nodeById(registry, 'ag-live');
    expect(progressNode.state).toBe('executing-tool');
    expect(progressNode.currentActivity).toMatchObject({ kind: 'phase', text: 'Turn 3 · edit' });

    // Terminal state comes from the record, not the side-table.
    agent.status = 'completed';
    agent.completedAt = T0 + 900;
    emitAgentCompleted(bus, emitterCtx, { agentId: 'ag-live', durationMs: 900 });
    await flushBus();
    expect(nodeById(registry, 'ag-live').state).toBe('done');
    registry.dispose();
  });

  test('AGENT_FAILED + record failure → failed', async () => {
    const agent = makeAgent({ id: 'ag-fail' });
    const { registry, bus } = busSetup(agent);
    agent.status = 'failed';
    emitAgentFailed(bus, emitterCtx, { agentId: 'ag-fail', error: 'x', durationMs: 10 });
    await flushBus();
    expect(nodeById(registry, 'ag-fail').state).toBe('failed');
    registry.dispose();
  });

  test('STREAM_RETRY with an agent-scoped envelope marks the agent retrying', async () => {
    const agent = makeAgent({ id: 'ag-retry' });
    const bus = new RuntimeEventBus();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000,
    }));
    emitStreamRetry(bus, { ...emitterCtx, agentId: 'ag-retry' }, {
      turnId: 't1', provider: 'anthropic', attempt: 1, maxAttempts: 3, delayMs: 100, reason: 'overloaded',
    });
    await flushBus();
    expect(nodeById(registry, 'ag-retry').state).toBe('retrying');
    // Next agent event flips it back to a live state.
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-retry' });
    await flushBus();
    expect(nodeById(registry, 'ag-retry').state).toBe('thinking');
    registry.dispose();
  });

  test('dispose() detaches the bus tap (later events no longer affect state)', async () => {
    const agent = makeAgent({ id: 'ag-tap' });
    const bus = new RuntimeEventBus();
    const deps = makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => T0 + 1_000,
    });
    const registry = createProcessRegistry(deps);
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-tap' });
    await flushBus();
    expect(nodeById(registry, 'ag-tap').state).toBe('thinking');
    registry.dispose();
    // A fresh registry subscribes BEFORE the next emit; the disposed one's tap
    // is gone, so only the fresh registry may observe the delta.
    const fresh = createProcessRegistry(deps);
    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-tap', content: 'x', accumulated: 'x' });
    await flushBus();
    expect(nodeById(fresh, 'ag-tap').state).toBe('streaming');
    fresh.dispose();
  });
});

// ── 3. Stalled derivation ─────────────────────────────────────────────────────

describe('fleet registry — stalled derivation', () => {
  test('running agent with stale activity flips to stalled, and back on the next event', async () => {
    const agent = makeAgent({ id: 'ag-stall', startedAt: T0 });
    const bus = new RuntimeEventBus();
    let clock = T0 + 1_000;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => clock,
      stalledThresholdMs: 20_000,
    }));
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-stall' }); // at = T0+1000
    await flushBus();
    expect(nodeById(registry, 'ag-stall').state).toBe('thinking');

    clock = T0 + 30_000; // 29s since last event > 20s threshold
    expect(nodeById(registry, 'ag-stall').state).toBe('stalled');

    emitAgentStreamDelta(bus, emitterCtx, { agentId: 'ag-stall', content: 'x', accumulated: 'x' });
    await flushBus();
    expect(nodeById(registry, 'ag-stall').state).toBe('streaming');
    registry.dispose();
  });

  test('executing-tool is exempt from the stalled check: a long tool call never falsely stalls', async () => {
    const agent = makeAgent({ id: 'ag-tool-stall', startedAt: T0 });
    const bus = new RuntimeEventBus();
    let clock = T0 + 1_000;
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: bus,
      now: () => clock,
      stalledThresholdMs: 20_000,
    }));
    // AGENT_AWAITING_TOOL stamps activity.at once at tool start; no further
    // 'agents' event fires until the tool returns (builds, test suites, bash
    // routinely exceed the 20s threshold).
    emitAgentAwaitingTool(bus, emitterCtx, { agentId: 'ag-tool-stall', callId: 'c1', tool: 'bash' });
    await flushBus();
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('executing-tool');

    clock = T0 + 90_000; // 89s since tool start, far past the 20s threshold
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('executing-tool');

    // Once the tool returns and a new thinking/streaming event lands with no
    // further activity, honest stalling still applies.
    emitAgentAwaitingMessage(bus, emitterCtx, { agentId: 'ag-tool-stall' }); // at = T0+90_000
    await flushBus();
    clock = T0 + 120_000; // 30s of silence since the thinking event > 20s threshold
    expect(nodeById(registry, 'ag-tool-stall').state).toBe('stalled');
    registry.dispose();
  });

  test('bus present but no events yet: stalled baseline is startedAt', () => {
    const agent = makeAgent({ id: 'ag-old', startedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      runtimeBus: new RuntimeEventBus(),
      now: () => T0 + 60_000,
    }));
    expect(nodeById(registry, 'ag-old').state).toBe('stalled');
    registry.dispose();
  });

  test('no bus → no stalled derivation (honest coarse degradation)', () => {
    const agent = makeAgent({ id: 'ag-nobus', startedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      now: () => T0 + 999_000,
      agentManager: { list: () => [agent], cancel: () => false },
    }));
    expect(nodeById(registry, 'ag-nobus').state).toBe('executing-tool');
    registry.dispose();
  });
});

// ── 4. awaiting-approval cross-reference ──────────────────────────────────────

describe('fleet registry — awaiting-approval', () => {
  test('pending approval with metadata.agentId flips that agent to awaiting-approval', () => {
    const agent = makeAgent({ id: 'ag-appr' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-1', metadata: { agentId: 'ag-appr' } })],
      },
    }));
    expect(nodeById(registry, 'ag-appr').state).toBe('awaiting-approval');
    registry.dispose();
  });

  test('pending approval matches through the session binding; resolved approvals do not', () => {
    const agent = makeAgent({ id: 'ag-sess' });
    const session = makeSession({ id: 'sess-9', activeAgentId: 'ag-sess' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      sessionBroker: { listSessions: () => [session] },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-2', sessionId: 'sess-9' })],
      },
    }));
    const node = nodeById(registry, 'ag-sess');
    expect(node.state).toBe('awaiting-approval');
    expect(node.sessionRef?.sessionId).toBe('sess-9');
    registry.dispose();

    const resolvedRegistry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      sessionBroker: { listSessions: () => [session] },
      approvalBroker: {
        listApprovals: () => [makeApproval({ id: 'ap-3', sessionId: 'sess-9', status: 'approved' })],
      },
    }));
    expect(nodeById(resolvedRegistry, 'ag-sess').state).not.toBe('awaiting-approval');
    resolvedRegistry.dispose();
  });
});

// ── 5. Cost honesty ───────────────────────────────────────────────────────────

describe('fleet registry — cost honesty', () => {
  const usage = {
    inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    llmCallCount: 1, turnCount: 1,
  };

  test('unknown model → costUsd null + unpriced; known → priced; thrower → unpriced (never throws)', () => {
    const agents = [
      makeAgent({ id: 'ag-known', model: 'priced-model', usage: { ...usage } }),
      makeAgent({ id: 'ag-unknown', model: 'mystery-model', usage: { ...usage } }),
      makeAgent({ id: 'ag-nomodel', usage: { ...usage } }),
      makeAgent({ id: 'ag-nousage', model: 'priced-model' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      priceUsage: (model) => {
        if (model === 'priced-model') return 12.5;
        if (model === 'mystery-model') return null;
        throw new Error('must be swallowed');
      },
    }));
    const known = nodeById(registry, 'ag-known');
    expect(known.costUsd).toBe(12.5);
    expect(known.costState).toBe('priced');
    const unknown = nodeById(registry, 'ag-unknown');
    expect(unknown.costUsd).toBeNull();
    expect(unknown.costState).toBe('unpriced');
    const noModel = nodeById(registry, 'ag-nomodel');
    expect(noModel.costUsd).toBeNull(); // priceUsage threw — swallowed, honest null
    expect(noModel.costState).toBe('unpriced');
    expect(nodeById(registry, 'ag-nousage').costUsd).toBeNull();
    registry.dispose();
  });

  test('chain aggregation: mixed priced/unpriced members → estimated with priced subset only', () => {
    const chain = makeChain({ id: 'ch-cost', ownerAgentId: 'own', allAgentIds: ['own', 'm1', 'm2'] });
    const agents = [
      makeAgent({ id: 'own', wrfcId: 'ch-cost', usage: { ...usage } }),
      makeAgent({ id: 'm1', wrfcId: 'ch-cost', model: 'priced-model', usage: { ...usage } }),
      makeAgent({ id: 'm2', wrfcId: 'ch-cost', model: 'mystery-model', usage: { ...usage } }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
      priceUsage: (model) => (model === 'priced-model' ? 3 : null),
    }));
    const chainNode = nodeById(registry, 'chain:ch-cost');
    expect(chainNode.costUsd).toBe(3);
    expect(chainNode.costState).toBe('estimated');
    registry.dispose();
  });
});

// ── 6. Edge/nesting integrity ─────────────────────────────────────────────────

describe('fleet registry — edge integrity', () => {
  test('chain with 2 subtasks and 3 agents forms a connected tree (no dangling parentIds)', () => {
    const chain = makeChain({
      id: 'ch-tree',
      ownerAgentId: 'owner-t',
      allAgentIds: ['owner-t', 'eng-a', 'rev-a'],
      subtasks: [
        makeSubtask({ id: 'st-1', engineerAgentId: 'eng-a' }),
        makeSubtask({ id: 'st-2', reviewerAgentId: 'rev-a' }),
      ],
    });
    const agents = [
      makeAgent({ id: 'owner-t', wrfcId: 'ch-tree', wrfcRole: 'owner' }),
      makeAgent({ id: 'eng-a', wrfcId: 'ch-tree', wrfcSubtaskId: 'st-1', wrfcRole: 'engineer' }),
      makeAgent({ id: 'rev-a', wrfcId: 'ch-tree', wrfcSubtaskId: 'st-2', wrfcRole: 'reviewer' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [...agents], cancel: () => false },
      wrfcController: { listChains: () => [chain] },
    }));
    const snapshot = registry.query();
    const ids = new Set(snapshot.nodes.map((node) => node.id));
    expect(ids.size).toBe(6); // 1 chain + 2 subtasks + 3 agents
    for (const node of snapshot.nodes) {
      if (node.parentId !== undefined) {
        expect(ids.has(node.parentId)).toBe(true);
      }
    }
    // chain→subtask→agent nesting.
    expect(nodeById(registry, 'subtask:st-1').parentId).toBe('chain:ch-tree');
    expect(nodeById(registry, 'eng-a').parentId).toBe('subtask:st-1');
    expect(nodeById(registry, 'rev-a').parentId).toBe('subtask:st-2');
    expect(nodeById(registry, 'chain:ch-tree').parentId).toBeUndefined();
    registry.dispose();
  });
});

// ── 7. subscribe / tick / dispose ─────────────────────────────────────────────

interface FakeTimerHarness {
  timers: RegistryTimers;
  fire: () => void;
  unrefCalls: number;
  setCalls: number;
  clearCalls: number;
}

function makeFakeTimers(): FakeTimerHarness {
  const harness: FakeTimerHarness = {
    unrefCalls: 0,
    setCalls: 0,
    clearCalls: 0,
    fire: () => undefined,
    timers: {
      setInterval: (callback: () => void) => {
        harness.setCalls += 1;
        harness.fire = callback;
        return {
          unref: () => {
            harness.unrefCalls += 1;
          },
        };
      },
      clearInterval: () => {
        harness.clearCalls += 1;
        harness.fire = () => undefined;
      },
    },
  };
  return harness;
}

describe('fleet registry — subscribe/tick/dispose', () => {
  test('tick notifies on change, stays silent when unchanged, and dispose stops everything', () => {
    const agent = makeAgent({ id: 'ag-sub' });
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      timers: harness.timers,
    }));

    const seen: number[] = [];
    registry.subscribe((snapshot) => seen.push(snapshot.nodes.length));
    expect(harness.setCalls).toBe(1);
    expect(harness.unrefCalls).toBe(1); // timer.unref path exercised

    harness.fire(); // first tick: initial delivery
    expect(seen).toEqual([1]);

    harness.fire(); // nothing changed → coalesced silence
    harness.fire();
    expect(seen).toEqual([1]);

    agent.status = 'completed'; // material change
    agent.completedAt = T0 + 100;
    harness.fire();
    expect(seen).toEqual([1, 1]);

    registry.dispose();
    expect(harness.clearCalls).toBe(1);
    agent.status = 'running';
    harness.fire(); // cleared fake timer no longer reaches the registry
    expect(seen).toEqual([1, 1]);
  });

  test('elapsedMs drift alone never wakes subscribers', () => {
    let clock = T0 + 1_000;
    const agent = makeAgent({ id: 'ag-drift' });
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agent], cancel: () => false },
      timers: harness.timers,
      now: () => clock,
    }));
    let calls = 0;
    registry.subscribe(() => {
      calls += 1;
    });
    harness.fire();
    expect(calls).toBe(1);
    clock += 5_000; // elapsedMs changes, nothing material does
    harness.fire();
    expect(calls).toBe(1);
    registry.dispose();
  });

  test('unsubscribing the last listener stops the timer; resubscribe restarts it', () => {
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({ timers: harness.timers }));
    const unsubscribe = registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(1);
    unsubscribe();
    expect(harness.clearCalls).toBe(1);
    registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(2);
    registry.dispose();
    expect(harness.clearCalls).toBe(2);
  });

  test('subscribe after dispose is a no-op', () => {
    const harness = makeFakeTimers();
    const registry = createProcessRegistry(makeDeps({ timers: harness.timers }));
    registry.dispose();
    const unsubscribe = registry.subscribe(() => undefined);
    expect(harness.setCalls).toBe(0);
    unsubscribe(); // must not throw
  });
});

// ── 8. Control dispatch ───────────────────────────────────────────────────────

describe('fleet registry — control dispatch', () => {
  // W3.1 Part A3: registry routing must pass the termination intent through
  // to AgentManager.cancel(id, kind) — kill() always 'kill' (direct agent
  // kill, and chain/subtask cascade via cancelAgents), interrupt() always
  // 'interrupt'. Spy on the exact args cancel() receives.
  test('agent kill passes cancel(id, "kill"); agent interrupt passes cancel(id, "interrupt")', () => {
    const calls: Array<{ id: string; kind: 'interrupt' | 'kill' | undefined }> = [];
    const agent = makeAgent({ id: 'ag-verb' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [agent],
        cancel: (id: string, kind?: 'interrupt' | 'kill') => {
          calls.push({ id, kind });
          return true;
        },
      },
    }));
    expect(registry.kill('ag-verb')).toEqual(['ag-verb']);
    expect(registry.interrupt('ag-verb')).toBe(true);
    expect(calls).toEqual([
      { id: 'ag-verb', kind: 'kill' },
      { id: 'ag-verb', kind: 'interrupt' },
    ]);
    registry.dispose();
  });

  test('chain cascade kill always passes cancel(id, "kill") over member agents, never "interrupt"', () => {
    const calls: Array<{ id: string; kind: 'interrupt' | 'kill' | undefined }> = [];
    const chain = makeChain({
      id: 'ch-verb',
      ownerAgentId: 'own-verb',
      allAgentIds: ['own-verb', 'm1-verb'],
    });
    const agents = [
      makeAgent({ id: 'own-verb', wrfcId: 'ch-verb' }),
      makeAgent({ id: 'm1-verb', wrfcId: 'ch-verb' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string, kind?: 'interrupt' | 'kill') => {
          calls.push({ id, kind });
          return true;
        },
      },
      wrfcController: { listChains: () => [chain] },
    }));
    registry.kill('chain:ch-verb');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.kind).toBe('kill');
    registry.dispose();
  });

  test('kill routes to the owning manager per kind', () => {
    const calls: string[] = [];
    const agent = makeAgent({ id: 'ag-k' });
    const workflow: WorkflowInstance = {
      id: 'wf-k', definition: 'd', currentState: 's', task: 't', startedAt: T0, transitions: 0, context: {},
    };
    const trigger: TriggerDefinition = { id: 'trg-k', event: 'e', action: 'a', enabled: true };
    const schedule: ScheduleEntry = { name: 'sch-k', interval: '5m', command: 'c', enabled: true };
    const watcher = makeWatcher({ id: 'w-k' });
    const bg = makeBackgroundProcess({ id: 'bg-k' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [agent],
        cancel: (id: string) => {
          calls.push(`agent.cancel:${id}`);
          return true;
        },
      },
      processManager: {
        list: () => [{ id: bg.id, pid: bg.pid, cmd: bg.cmd, status: 'running' }],
        getStatus: () => bg,
        stop: (id: string) => {
          calls.push(`process.stop:${id}`);
          return true;
        },
      },
      watcherRegistry: {
        list: () => [watcher],
        stopWatcher: (id: string) => {
          calls.push(`watcher.stop:${id}`);
          return watcher;
        },
      },
      workflow: {
        workflowManager: {
          list: () => [workflow],
          cancel: (id: string) => {
            calls.push(`workflow.cancel:${id}`);
            return true;
          },
        },
        triggerManager: {
          list: () => [trigger],
          remove: (id: string) => {
            calls.push(`trigger.remove:${id}`);
            return true;
          },
          disable: (id: string) => {
            calls.push(`trigger.disable:${id}`);
            return true;
          },
        },
        scheduleManager: {
          list: () => [schedule],
          remove: (name: string) => {
            calls.push(`schedule.remove:${name}`);
            return true;
          },
          disable: (name: string) => {
            calls.push(`schedule.disable:${name}`);
            return true;
          },
        },
      },
    }));

    expect(registry.kill('ag-k')).toEqual(['ag-k']);
    expect(registry.kill('bg-k')).toEqual(['bg-k']);
    expect(registry.kill('w-k')).toEqual(['w-k']);
    expect(registry.kill('wf-k')).toEqual(['wf-k']);
    expect(registry.kill('trg-k')).toEqual(['trg-k']);
    expect(registry.kill('schedule:sch-k')).toEqual(['schedule:sch-k']);
    expect(registry.kill('missing')).toEqual([]);

    expect(registry.interrupt('ag-k')).toBe(true);
    expect(registry.interrupt('trg-k')).toBe(true);
    expect(registry.interrupt('schedule:sch-k')).toBe(true);
    expect(registry.interrupt('bg-k')).toBe(false);

    expect(calls).toEqual([
      'agent.cancel:ag-k',
      'process.stop:bg-k',
      'watcher.stop:w-k',
      'workflow.cancel:wf-k',
      'trigger.remove:trg-k',
      'schedule.remove:sch-k',
      'agent.cancel:ag-k',
      'trigger.disable:trg-k',
      'schedule.disable:sch-k',
    ]);
    registry.dispose();
  });

  test('chain kill is derived: cascades AgentManager.cancel over live member agents', () => {
    const cancelled: string[] = [];
    const chain = makeChain({
      id: 'ch-kill',
      ownerAgentId: 'own-k',
      allAgentIds: ['own-k', 'm1-k', 'm2-k'],
    });
    const agents = [
      makeAgent({ id: 'own-k', wrfcId: 'ch-kill' }),
      makeAgent({ id: 'm1-k', wrfcId: 'ch-kill' }),
      makeAgent({ id: 'm2-k', wrfcId: 'ch-kill', status: 'completed', completedAt: T0 }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string) => {
          const record = agents.find((candidate) => candidate.id === id);
          if (!record || record.status !== 'running') return false;
          cancelled.push(id);
          return true;
        },
      },
      wrfcController: { listChains: () => [chain] },
    }));
    const affected = registry.kill('chain:ch-kill');
    expect(cancelled.sort()).toEqual(['m1-k', 'own-k']); // completed member not resurrected
    expect([...affected].sort()).toEqual(['chain:ch-kill', 'm1-k', 'own-k']);
    registry.dispose();
  });

  test('chain kill with cascade: chain id is included even though cascade already cancelled every member', () => {
    // A real AgentManager.cancel() is NOT idempotent-true: once an agent is
    // cancelled, a second cancel() call on it returns false. Model that here
    // (unlike the mock above, which never actually transitions status) so the
    // cascade path's ordering bug — descendants cancelled first, then the
    // chain's own cancelAgents() finds them all already-cancelled — surfaces.
    const cancelledOnce = new Set<string>();
    const chain = makeChain({
      id: 'ch-casc',
      ownerAgentId: 'own-c',
      allAgentIds: ['own-c', 'm1-c'],
    });
    const agents = [
      makeAgent({ id: 'own-c', wrfcId: 'ch-casc' }),
      makeAgent({ id: 'm1-c', wrfcId: 'ch-casc' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string) => {
          if (cancelledOnce.has(id)) return false;
          cancelledOnce.add(id);
          return true;
        },
      },
      wrfcController: { listChains: () => [chain] },
    }));
    const affected = registry.kill('chain:ch-casc', { cascade: true });
    expect([...affected].sort()).toEqual(['chain:ch-casc', 'm1-c', 'own-c']);
    registry.dispose();
  });

  test('chain kill (non-cascade) matches cascade: chain id included both ways for the same chain', () => {
    const cancelledOnce = new Set<string>();
    const chain = makeChain({
      id: 'ch-eq',
      ownerAgentId: 'own-e',
      allAgentIds: ['own-e', 'm1-e'],
    });
    const agents = [
      makeAgent({ id: 'own-e', wrfcId: 'ch-eq' }),
      makeAgent({ id: 'm1-e', wrfcId: 'ch-eq' }),
    ];
    const registry = createProcessRegistry(makeDeps({
      agentManager: {
        list: () => [...agents],
        cancel: (id: string) => {
          if (cancelledOnce.has(id)) return false;
          cancelledOnce.add(id);
          return true;
        },
      },
      wrfcController: { listChains: () => [chain] },
    }));
    const affected = registry.kill('chain:ch-eq');
    expect([...affected].sort()).toEqual(['chain:ch-eq', 'm1-e', 'own-e']);
    registry.dispose();
  });
});
