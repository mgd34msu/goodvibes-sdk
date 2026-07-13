/**
 * fleet-headlines.test.ts — per-node headlines + the stall tell
 * (runtime/fleet/headlines.ts and their registry integration).
 *
 * The owner's contract, enforced BOTH ways by these tests:
 *   "if it updates on new tasks that the agent is working on, that's fine.
 *    if it is constantly streaming in new text, that is not ok."
 *
 *   - transition side: a new task/phase regenerates the headline in place
 *   - anti-feed side: continuous per-token/per-turn activity (stream deltas,
 *     tool events, progress lines) leaves the headline byte-identical — a
 *     seeded continuous updater FAILS to move it
 *   - the cap is enforced at the read-model
 *   - the stall tell is a pure timestamp comparison exposed on the snapshot
 */
import { describe, expect, test } from 'bun:test';
import {
  createProcessRegistry,
  HEADLINE_MAX_CHARS,
  HeadlineTable,
  headlineSource,
  deriveStallTell,
} from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessNode } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps } from '../packages/sdk/src/platform/runtime/fleet/registry.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import {
  emitAgentAwaitingTool,
  emitAgentProgress,
  emitAgentStreamDelta,
} from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import type { EmitterContext } from '../packages/sdk/src/platform/runtime/emitters/index.js';

const T0 = 1_750_000_000_000;
const emitterCtx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

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

function node(overrides: Partial<ProcessNode> & { id: string }): ProcessNode {
  return {
    kind: 'agent',
    label: 'agent-x',
    state: 'thinking',
    elapsedMs: 0,
    costState: 'unpriced',
    capabilities: {},
    ...overrides,
  } as ProcessNode;
}

function flushBus(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── headlineSource: task/phase identity ONLY ─────────────────────────────────

describe('headlineSource', () => {
  test('agent node: the task is the identity; per-turn phase progress is EXCLUDED', () => {
    const base = node({ id: 'a', kind: 'agent', task: 'fix the parser' });
    const withProgress = node({
      id: 'a', kind: 'agent', task: 'fix the parser',
      currentActivity: { kind: 'phase', text: 'Turn 7 · exec', at: T0 },
    });
    expect(headlineSource(base)).toBe('fix the parser');
    expect(headlineSource(withProgress)).toBe('fix the parser'); // no churn from Turn N lines
  });

  test('tool/output-line activity never participates for any kind', () => {
    const withTool = node({
      id: 'w', kind: 'work-item', task: 'build feature',
      currentActivity: { kind: 'tool', text: 'exec', toolName: 'exec', at: T0 },
    });
    const withOutput = node({
      id: 'w', kind: 'work-item', task: 'build feature',
      currentActivity: { kind: 'output-line', text: 'compiling 3 of 7…', at: T0 },
    });
    expect(headlineSource(withTool)).toBe('build feature');
    expect(headlineSource(withOutput)).toBe('build feature');
  });

  test('non-agent nodes include their PHASE activity (changes exactly at phase transitions)', () => {
    const item = node({
      id: 'w', kind: 'work-item', task: 'build feature',
      currentActivity: { kind: 'phase', text: 'review', at: T0 },
    });
    expect(headlineSource(item)).toBe('build feature — review');
  });

  test('falls back to label; null when neither task nor label carries text', () => {
    expect(headlineSource(node({ id: 'x', label: 'watcher-7' }))).toBe('watcher-7');
    expect(headlineSource(node({ id: 'x', label: '  ' }))).toBeNull();
  });
});

// ── HeadlineTable: replaced in place, transitions only, capped ───────────────

describe('HeadlineTable', () => {
  test('same identity → the byte-identical headline object across derives', () => {
    const table = new HeadlineTable();
    const n = node({ id: 'a', task: 'analyze failures' });
    const first = table.derive(n, T0)!;
    const second = table.derive(n, T0 + 60_000)!;
    expect(second).toBe(first); // same object — updatedAt did NOT move
    expect(second.updatedAt).toBe(T0);
  });

  test('a task transition regenerates in place with a fresh timestamp', () => {
    const table = new HeadlineTable();
    const first = table.derive(node({ id: 'a', task: 'first task' }), T0)!;
    const second = table.derive(node({ id: 'a', task: 'second task' }), T0 + 1_000)!;
    expect(first.text).toBe('first task');
    expect(second.text).toBe('second task');
    expect(second.updatedAt).toBe(T0 + 1_000);
  });

  test('ANTI-FEED: a seeded continuous updater fails to move the headline', () => {
    const table = new HeadlineTable();
    const first = table.derive(node({ id: 'a', task: 'steady task' }), T0)!;
    // 500 snapshots of churning activity text — tool calls, output lines,
    // per-turn progress — while the task stays put.
    for (let i = 1; i <= 500; i++) {
      const churned = table.derive(node({
        id: 'a',
        task: 'steady task',
        currentActivity: {
          kind: (['tool', 'output-line', 'phase'] as const)[i % 3]!,
          text: `streamed text #${i}`,
          at: T0 + i,
        },
      }), T0 + i)!;
      expect(churned).toBe(first);
    }
  });

  test('the cap is enforced at the read-model', () => {
    const table = new HeadlineTable();
    const long = 'x'.repeat(HEADLINE_MAX_CHARS * 3);
    const headline = table.derive(node({ id: 'a', task: long }), T0)!;
    expect(headline.text.length).toBe(HEADLINE_MAX_CHARS);
    expect(headline.text.endsWith('…')).toBe(true);
  });

  test('prune drops entries for nodes no longer present', () => {
    const table = new HeadlineTable();
    const before = table.derive(node({ id: 'gone', task: 't' }), T0)!;
    table.prune(new Set(['still-here']));
    const after = table.derive(node({ id: 'gone', task: 't' }), T0 + 5)!;
    expect(after).not.toBe(before);
    expect(after.updatedAt).toBe(T0 + 5);
  });
});

// ── deriveStallTell: pure timestamp comparison ───────────────────────────────

describe('deriveStallTell', () => {
  const threshold = 5 * 60_000;

  test('a live node quiet past the threshold gains the marker — no generated text', () => {
    const quiet = node({
      id: 'a', state: 'thinking', startedAt: T0,
      currentActivity: { kind: 'tool', text: 'exec', at: T0 },
    });
    const tell = deriveStallTell(quiet, T0 + threshold + 1_000, threshold)!;
    expect(tell).toEqual({ since: T0, quietForMs: threshold + 1_000 });
    expect(Object.keys(tell)).toEqual(['since', 'quietForMs']); // timestamps only
  });

  test('recent activity → no marker; terminal/parked states → no marker; no timestamps → no marker', () => {
    const fresh = node({ id: 'a', state: 'thinking', currentActivity: { kind: 'tool', text: 'x', at: T0 + threshold } });
    expect(deriveStallTell(fresh, T0 + threshold + 1_000, threshold)).toBeUndefined();
    const done = node({ id: 'a', state: 'done', startedAt: T0 });
    expect(deriveStallTell(done, T0 + threshold * 2, threshold)).toBeUndefined();
    const queued = node({ id: 'a', state: 'queued', startedAt: T0 });
    expect(deriveStallTell(queued, T0 + threshold * 2, threshold)).toBeUndefined();
    const timeless = node({ id: 'a', state: 'thinking' });
    expect(deriveStallTell(timeless, T0 + threshold * 2, threshold)).toBeUndefined();
  });

  test('falls back to startedAt when no activity was ever observed', () => {
    const started = node({ id: 'a', state: 'thinking', startedAt: T0 });
    expect(deriveStallTell(started, T0 + threshold, threshold)).toEqual({ since: T0, quietForMs: threshold });
  });
});

// ── Registry integration: exposed on every surface's snapshot ────────────────

describe('fleet registry — headline + stall on the snapshot', () => {
  test('transition side: a NEW task regenerates the headline; the same task never does', () => {
    let currentNow = T0 + 1_000;
    const record = makeAgent({ id: 'agent-1', task: 'analyze the build failure' });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [record], cancel: () => false },
      now: () => currentNow,
    }));

    const first = registry.getNode('agent-1')!;
    expect(first.headline).toEqual({ text: 'analyze the build failure', updatedAt: T0 + 1_000 });

    // Same task, later snapshot — byte-identical headline (same updatedAt).
    currentNow = T0 + 90_000;
    const second = registry.getNode('agent-1')!;
    expect(second.headline).toBe(first.headline!);

    // A new task — the transition the owner blessed — replaces it in place.
    record.task = 'ship the fix';
    currentNow = T0 + 120_000;
    const third = registry.getNode('agent-1')!;
    expect(third.headline).toEqual({ text: 'ship the fix', updatedAt: T0 + 120_000 });
    registry.dispose();
  });

  test('ANTI-FEED side: continuous stream/tool/progress events leave the headline byte-identical', async () => {
    let currentNow = T0 + 1_000;
    const record = makeAgent({ id: 'agent-2', task: 'steady work' });
    const bus = new RuntimeEventBus();
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [record], cancel: () => false },
      runtimeBus: bus,
      now: () => currentNow,
    }));

    const before = registry.getNode('agent-2')!.headline!;
    expect(before.text).toBe('steady work');

    // A continuous updater: per-token deltas, tool events, per-turn progress.
    for (let turn = 1; turn <= 25; turn++) {
      emitAgentStreamDelta(bus, emitterCtx, { agentId: 'agent-2', delta: `token-${turn}` });
      emitAgentAwaitingTool(bus, emitterCtx, { agentId: 'agent-2', tool: `tool-${turn}` });
      emitAgentProgress(bus, emitterCtx, { agentId: 'agent-2', progress: `Turn ${turn} · exec` });
    }
    await flushBus();
    currentNow = T0 + 60_000;

    const after = registry.getNode('agent-2')!.headline!;
    expect(after).toBe(before); // the feed moved NOTHING
    expect(after.updatedAt).toBe(T0 + 1_000);
    registry.dispose();
  });

  test('stall tell: a running node quiet past the threshold carries the marker on the snapshot', () => {
    let currentNow = T0 + 1_000;
    const record = makeAgent({ id: 'agent-3', task: 'long think', startedAt: T0 });
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [record], cancel: () => false },
      now: () => currentNow,
      stallTellMs: 5 * 60_000,
    }));

    expect(registry.getNode('agent-3')!.stall).toBeUndefined(); // fresh — no tell

    currentNow = T0 + 6 * 60_000;
    const quiet = registry.getNode('agent-3')!;
    expect(quiet.stall).toEqual({ since: T0, quietForMs: 6 * 60_000 });
    registry.dispose();
  });
});
