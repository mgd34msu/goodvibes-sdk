/**
 * Observed external coding-agent sessions (1.4.3 rider): read-only detection of
 * Claude Code / Codex processes goodvibes did NOT spawn, folded into the fleet
 * as 'observed-external' rows that
 *   - carry an honest external kind + pid + cwd + start time + CPU liveness,
 *   - are steerable ONLY over a genuine channel (a tmux pane) and honestly say
 *     so when there is none,
 *   - never offer stop (observing is not owning the lifecycle),
 *   - and NEVER count against fleet.maxSize (fleet-count.ts accepts only owned
 *     sources by construction).
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyExternalKind,
  classifyObservedProcesses,
  paneForTty,
  type ObservedRawProcess,
  type ProcessTableReader,
  type TmuxPaneReader,
} from '../packages/sdk/src/platform/runtime/fleet/observed/detect.js';
import {
  ObservedAgentSource,
  type ObservedAgentRow,
  type TmuxCommandRunner,
} from '../packages/sdk/src/platform/runtime/fleet/observed/source.js';
import {
  adaptObservedAgent,
  observedNodeId,
  steerObservedNode,
} from '../packages/sdk/src/platform/runtime/fleet/adapters/observed.js';
import { createProcessRegistry } from '../packages/sdk/src/platform/runtime/fleet/index.js';
import type { ProcessRegistryDeps, RegistryTimers } from '../packages/sdk/src/platform/runtime/fleet/registry.js';
import {
  fleetCapacityProbeFrom,
  makeRuntimeFleetProbe,
} from '../packages/sdk/src/platform/runtime/orchestration/fleet-count.js';
import { createFleetObservedSteerHandler } from '../packages/sdk/src/platform/control-plane/routes/fleet.js';
import type { AgentManager, AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { WrfcController } from '../packages/sdk/src/platform/agents/wrfc-controller.js';
import type { ProcessManager } from '../packages/sdk/src/platform/tools/shared/process-manager.js';
import type { WatcherRegistry } from '../packages/sdk/src/platform/watchers/registry.js';
import type {
  ScheduleManager,
  TriggerManager,
  WorkflowManager,
} from '../packages/sdk/src/platform/tools/workflow/index.js';

const T0 = 1_750_000_000_000;

// Real argv shapes taken from the live fixtures on the host at authoring time.
const CLAUDE_ARGS = 'claude --dangerously-skip-permissions';
const CODEX_NODE_LAUNCHER = 'node /home/u/.local/share/mise/installs/node/26.1.0/bin/codex --dangerously-bypass-approvals-and-sandbox';
const CODEX_BINARY = '/home/u/.local/share/mise/installs/node/26.1.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --dangerously-bypass-approvals-and-sandbox';
const PLUGIN_MCP_NODE = 'node /home/u/.claude/plugins/cache/goodvibes-market/goodvibes/2.3.3/server/intel/index.cjs';

describe('detect — classifyExternalKind (argv shapes)', () => {
  test('claude CLI basename', () => expect(classifyExternalKind(CLAUDE_ARGS)).toBe('claude-code'));
  test('claude.exe basename', () => expect(classifyExternalKind('claude.exe --resume x')).toBe('claude-code'));
  test('claude npm package path', () => expect(classifyExternalKind('node /x/@anthropic-ai/claude-code/bin/x')).toBe('claude-code'));
  test('codex CLI basename', () => expect(classifyExternalKind('codex --foo')).toBe('codex'));
  test('codex vendored binary basename (codex-linux...)', () => expect(classifyExternalKind(CODEX_BINARY)).toBe('codex'));
  test('codex via node launcher path (@openai/codex not in argv0, path token matches)', () => {
    // The launcher's argv0 is `node`; the package path token names it codex.
    expect(classifyExternalKind(CODEX_NODE_LAUNCHER)).toBe('codex');
  });
  test('opencode CLI', () => expect(classifyExternalKind('opencode run')).toBe('opencode'));
  test('goodvibes plugin MCP node process is NOT an agent', () => expect(classifyExternalKind(PLUGIN_MCP_NODE)).toBeNull());
  test('a plain shell is not an agent', () => expect(classifyExternalKind('-bash')).toBeNull());
  test('empty argv', () => expect(classifyExternalKind('')).toBeNull());
});

function raw(pid: number, ppid: number, args: string, extra: Partial<ObservedRawProcess> = {}): ObservedRawProcess {
  return { pid, ppid, args, cpuSeconds: 0, ...extra };
}

describe('detect — classifyObservedProcesses (dedup + one row per session)', () => {
  test('a same-kind child under its matched parent is dropped (codex binary under node launcher)', () => {
    const rows = classifyObservedProcesses([
      raw(100, 1, '-bash'),
      raw(101, 100, CODEX_NODE_LAUNCHER, { cwd: '/w/codex' }), // root launcher
      raw(102, 101, CODEX_BINARY, { cwd: '/w/codex' }), // child helper — dropped
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(101);
    expect(rows[0]!.externalKind).toBe('codex');
  });

  test('two distinct sessions of different kinds both surface', () => {
    const rows = classifyObservedProcesses([
      raw(200, 1, CLAUDE_ARGS, { cwd: '/w/claude' }),
      raw(201, 1, CODEX_NODE_LAUNCHER, { cwd: '/w/codex' }),
    ]);
    expect(rows.map((r) => r.externalKind).sort()).toEqual(['claude-code', 'codex']);
  });

  test('non-agent processes never surface (quiet empty set)', () => {
    expect(classifyObservedProcesses([raw(1, 0, '-bash'), raw(2, 1, PLUGIN_MCP_NODE)])).toHaveLength(0);
  });
});

describe('detect — paneForTty', () => {
  test('maps a tty to its pane', () => {
    const panes = [{ paneId: '%90', tty: '/dev/pts/11' }, { paneId: '%87', tty: '/dev/pts/14' }];
    expect(paneForTty(panes, '/dev/pts/14')?.paneId).toBe('%87');
    expect(paneForTty(panes, '/dev/pts/99')).toBeUndefined();
    expect(paneForTty(panes, undefined)).toBeUndefined();
  });
});

// ── Source: TTL cache, CPU-delta liveness, tmux three-send steer ─────────────

function stubReaders(processes: ObservedRawProcess[], panes: { paneId: string; tty: string }[] = []): {
  processReader: ProcessTableReader;
  paneReader: TmuxPaneReader;
} {
  return {
    processReader: { read: () => processes },
    paneReader: { listPanes: () => panes },
  };
}

describe('ObservedAgentSource — discovery, liveness, TTL', () => {
  test('list() surfaces rows with correct kind/cwd/pid and a tmux steer channel when a pane maps', () => {
    const procs = [raw(300, 1, CLAUDE_ARGS, { cwd: '/w/claude', tty: '/dev/pts/11', startedAt: T0 - 1000 })];
    const source = new ObservedAgentSource({
      ...stubReaders(procs, [{ paneId: '%90', tty: '/dev/pts/11' }]),
      now: () => T0,
    });
    const rows = source.list();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.externalKind).toBe('claude-code');
    expect(row.cwd).toBe('/w/claude');
    expect(row.pid).toBe(300);
    expect(row.steer).toEqual({ kind: 'tmux', paneId: '%90', tty: '/dev/pts/11' });
  });

  test('no pane for the tty → honest no-channel steer state (never a dead action)', () => {
    const procs = [raw(301, 1, CLAUDE_ARGS, { cwd: '/w/claude', tty: '/dev/pts/11' })];
    const source = new ObservedAgentSource({ ...stubReaders(procs, []), now: () => T0 });
    const row = source.list()[0]!;
    expect(row.steer.kind).toBe('none');
    if (row.steer.kind === 'none') expect(row.steer.reason).toContain('/dev/pts/11');
  });

  test('no controlling terminal at all → honest no-channel reason', () => {
    const procs = [raw(302, 1, CLAUDE_ARGS, {})]; // no tty
    const source = new ObservedAgentSource({ ...stubReaders(procs, []), now: () => T0 });
    const row = source.list()[0]!;
    expect(row.steer.kind).toBe('none');
    if (row.steer.kind === 'none') expect(row.steer.reason).toContain('no controlling terminal');
  });

  test('liveness transitions track real CPU advance across refresh boundaries', () => {
    let cpu = 5;
    let clock = T0;
    // The reader re-reads the mutable `cpu` each scan; `clock` advances the TTL.
    const processReader: ProcessTableReader = {
      read: () => [{ pid: 303, ppid: 1, args: CLAUDE_ARGS, cwd: '/w/claude', tty: '/dev/pts/11', cpuSeconds: cpu }],
    };
    const source = new ObservedAgentSource({
      processReader,
      paneReader: { listPanes: () => [] },
      now: () => clock,
      refreshIntervalMs: 1000,
    });
    // First sighting: quiet (no prior sample to compare).
    expect(source.list()[0]!.liveness.state).toBe('quiet');
    // Advance CPU and cross the refresh boundary → active.
    cpu = 9; clock = T0 + 1500;
    expect(source.list()[0]!.liveness.state).toBe('active');
    // CPU static across the next boundary → quiet again, honestly.
    clock = T0 + 3000;
    const quiet = source.list()[0]!;
    expect(quiet.liveness.state).toBe('quiet');
    expect(quiet.liveness.detail).toContain('not proof');
  });

  test('TTL: repeated list() inside the refresh interval does not re-scan', () => {
    let scans = 0;
    const processReader: ProcessTableReader = { read: () => { scans++; return []; } };
    const source = new ObservedAgentSource({ processReader, paneReader: { listPanes: () => [] }, now: () => T0, refreshIntervalMs: 1000 });
    source.list();
    source.list();
    source.list();
    expect(scans).toBe(1);
  });
});

describe('ObservedAgentSource — steer (tmux three-send recipe)', () => {
  function makeSource(runner: TmuxCommandRunner): ObservedAgentSource {
    return new ObservedAgentSource({ steerRunner: runner, now: () => T0 });
  }
  const row = (steer: ObservedAgentRow['steer']): ObservedAgentRow => ({
    externalKind: 'claude-code', pid: 400, ppid: 1, args: CLAUDE_ARGS,
    liveness: { state: 'quiet', cpuSeconds: 0, detail: 'x' }, steer,
  });

  test('a tmux row round-trips exactly three sends: literal message, Enter, Enter', () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = { run: (args) => { calls.push([...args]); return { status: 0, stderr: '' }; } };
    const source = makeSource(runner);
    const result = source.steer(row({ kind: 'tmux', paneId: '%90', tty: '/dev/pts/11' }), 'hello there');
    expect(result.queued).toBe(true);
    expect(calls).toEqual([
      ['send-keys', '-t', '%90', '-l', '--', 'hello there'],
      ['send-keys', '-t', '%90', 'Enter'],
      ['send-keys', '-t', '%90', 'Enter'],
    ]);
  });

  test('a no-channel row is honestly refused; no send is attempted', () => {
    let called = false;
    const runner: TmuxCommandRunner = { run: () => { called = true; return { status: 0, stderr: '' }; } };
    const source = makeSource(runner);
    const result = source.steer(row({ kind: 'none', reason: 'no pane' }), 'hi');
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toContain('no pane');
    expect(called).toBe(false);
  });

  test('a failing send-keys surfaces an honest refusal', () => {
    const runner: TmuxCommandRunner = { run: () => ({ status: 1, stderr: "can't find pane" }) };
    const source = makeSource(runner);
    const result = source.steer(row({ kind: 'tmux', paneId: '%90', tty: '/dev/pts/11' }), 'hi');
    expect(result.queued).toBe(false);
    if (!result.queued) expect(result.reason).toContain("can't find pane");
  });
});

// ── Adapter: node shape ──────────────────────────────────────────────────────

function observedRow(overrides: Partial<ObservedAgentRow> = {}): ObservedAgentRow {
  return {
    externalKind: 'codex', pid: 500, ppid: 1, args: CODEX_BINARY, cwd: '/w/codex', startedAt: T0 - 2000,
    liveness: { state: 'active', cpuSeconds: 12, detail: 'CPU advanced' },
    steer: { kind: 'tmux', paneId: '%87', tty: '/dev/pts/14' },
    ...overrides,
  };
}

describe('adaptObservedAgent — node shape', () => {
  test('kind, ids, cwd, elapsed, and the observed drill-in facts', () => {
    const node = adaptObservedAgent(observedRow(), T0);
    expect(node.id).toBe(observedNodeId(500));
    expect(node.kind).toBe('observed-external');
    expect(node.task).toBe('/w/codex');
    expect(node.elapsedMs).toBe(2000);
    expect(node.observed).toEqual({
      externalKind: 'codex', pid: 500, cwd: '/w/codex',
      liveness: { state: 'active', cpuSeconds: 12, detail: 'CPU advanced' },
      steer: { kind: 'tmux', paneId: '%87', tty: '/dev/pts/14' },
      steerDrillInOnly: true,
    });
  });

  test('stop is NEVER offered; steerable only when a channel exists', () => {
    const withChannel = adaptObservedAgent(observedRow(), T0);
    expect(withChannel.capabilities).toEqual({ interruptible: false, killable: false, pausable: false, resumable: false, steerable: true });
    const noChannel = adaptObservedAgent(observedRow({ steer: { kind: 'none', reason: 'no pane' } }), T0);
    expect(noChannel.capabilities.steerable).toBe(false);
    expect(noChannel.capabilities.killable).toBe(false);
  });

  test('coarse state projects liveness only: active→executing-tool, quiet→idle', () => {
    expect(adaptObservedAgent(observedRow({ liveness: { state: 'active', cpuSeconds: 1, detail: 'x' } }), T0).state).toBe('executing-tool');
    expect(adaptObservedAgent(observedRow({ liveness: { state: 'quiet', cpuSeconds: 1, detail: 'x' } }), T0).state).toBe('idle');
  });

  test('foreign agents report no usage/cost — honest absence', () => {
    const node = adaptObservedAgent(observedRow(), T0);
    expect(node.usage).toBeUndefined();
    expect(node.costUsd).toBeNull();
    expect(node.costState).toBe('unpriced');
  });
});

// ── Registry integration: fold, count-exclusion, steer/stop dispatch ─────────

function makeDeps(overrides: Partial<ProcessRegistryDeps> = {}): ProcessRegistryDeps {
  const timers: RegistryTimers = { setInterval: () => 0, clearInterval: () => {} };
  return {
    agentManager: { list: (): AgentRecord[] => [], cancel: () => false } as unknown as Pick<AgentManager, 'list' | 'cancel'>,
    wrfcController: { listChains: () => [] } as unknown as Pick<WrfcController, 'listChains'>,
    processManager: { list: () => [], stop: () => false, getStatus: () => null } as unknown as Pick<ProcessManager, 'list' | 'stop' | 'getStatus'>,
    watcherRegistry: { list: () => [], stopWatcher: () => null } as unknown as Pick<WatcherRegistry, 'list' | 'stopWatcher'>,
    workflow: {
      workflowManager: { list: () => [], cancel: () => false } as unknown as Pick<WorkflowManager, 'list' | 'cancel'>,
      triggerManager: { list: () => [], remove: () => false, disable: () => false } as unknown as Pick<TriggerManager, 'list' | 'remove' | 'disable'>,
      scheduleManager: { list: () => [], remove: () => false, disable: () => false } as unknown as Pick<ScheduleManager, 'list' | 'remove' | 'disable'>,
    },
    timers,
    now: () => T0,
    ...overrides,
  };
}

function tmuxRowSource(): Pick<ObservedAgentSource, 'list' | 'steer'> {
  return {
    list: () => [observedRow()],
    steer: () => ({ queued: true, messageId: 'm1' }),
  };
}

describe('registry — observed rows fold in but never own a lifecycle', () => {
  test('absent observedAgents dep yields zero observed rows (degrade-to-today)', () => {
    const registry = createProcessRegistry(makeDeps());
    expect(registry.query().nodes.filter((n) => n.kind === 'observed-external')).toHaveLength(0);
    registry.dispose();
  });

  test('present dep surfaces the observed row', () => {
    const registry = createProcessRegistry(makeDeps({ observedAgents: tmuxRowSource() }));
    const observed = registry.query().nodes.filter((n) => n.kind === 'observed-external');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.id).toBe(observedNodeId(500));
    registry.dispose();
  });

  test('steer dispatches to the source; kill/interrupt are refused (stop never owned)', () => {
    let steered: { id: string; text: string } | null = null;
    const source: Pick<ObservedAgentSource, 'list' | 'steer'> = {
      list: () => [observedRow()],
      steer: (row, text) => { steered = { id: observedNodeId(row.pid), text }; return { queued: true, messageId: 'm1' }; },
    };
    const registry = createProcessRegistry(makeDeps({ observedAgents: source }));
    const id = observedNodeId(500);
    const result = registry.steer(id, 'please rebase');
    expect(result.queued).toBe(true);
    expect(steered).toEqual({ id, text: 'please rebase' });
    // Stop is never offered on a foreign row.
    expect(registry.kill(id)).toEqual([]);
    expect(registry.interrupt(id)).toBe(false);
    registry.dispose();
  });

  test('steerObservedNode refuses honestly when no source is configured', () => {
    const node = adaptObservedAgent(observedRow(), T0);
    const result = steerObservedNode(undefined, node, 'hi');
    expect(result.queued).toBe(false);
  });
});

describe('fleet-count — observed rows CANNOT enter the cap (structural)', () => {
  test('the responsibility probe counts only owned sources; observed rows are not a source', () => {
    // One native running agent + zero ACP hosted = active 1. There is no
    // observed-source parameter on the probe AT ALL — observed rows are
    // excluded by construction, not by a filter.
    const probe = fleetCapacityProbeFrom({
      readConfig: (key) => (key === 'fleet.maxSize' ? 8 : undefined),
      sources: { countNativeActive: () => 1, countAcpHosted: () => 0 },
    });
    expect(probe.active).toBe(1);
    expect(probe.maxSize).toBe(8);
  });

  test('with observed rows in the live snapshot, the runtime probe active count is unchanged', () => {
    const agentRecord = { id: 'a1', template: 'engineer', task: 't', status: 'running', startedAt: T0 - 100 };
    const agentManager = { list: () => [{ status: 'running' }] } as unknown as Parameters<typeof makeRuntimeFleetProbe>[0]['agentManager'];
    const acpHost = { list: () => [] };
    const probe = makeRuntimeFleetProbe({ readConfig: () => 8, agentManager, acpHost });
    const before = probe().active;
    // The observed source exists and lists rows, but makeRuntimeFleetProbe has
    // no channel to it — so the count cannot change.
    const registry = createProcessRegistry(makeDeps({
      agentManager: { list: () => [agentRecord], cancel: () => false } as unknown as Pick<AgentManager, 'list' | 'cancel'>,
      observedAgents: tmuxRowSource(),
    }));
    const snapshot = registry.query();
    expect(snapshot.nodes.some((n) => n.kind === 'observed-external')).toBe(true);
    expect(probe().active).toBe(before); // cap math unchanged by the observed row
    registry.dispose();
  });
});

// ── Wire verb: fleet.observed.steer handler ──────────────────────────────────

function invoke(body: Record<string, unknown>): Parameters<ReturnType<typeof createFleetObservedSteerHandler>>[0] {
  return { body } as unknown as Parameters<ReturnType<typeof createFleetObservedSteerHandler>>[0];
}

describe('routes/fleet — fleet.observed.steer handler', () => {
  const observedNode = adaptObservedAgent(observedRow(), T0);
  const registry = {
    getNode: (id: string) => (id === observedNode.id ? observedNode : null),
    steer: (_id: string, text: string) => (text ? { queued: true as const, messageId: 'mm' } : { queued: false as const, reason: 'empty' }),
  };

  test('steers an observed row', () => {
    const handler = createFleetObservedSteerHandler(registry);
    expect(handler(invoke({ id: observedNode.id, text: 'go' }))).toEqual({ queued: true, messageId: 'mm' });
  });

  test('unknown id is a 404', () => {
    const handler = createFleetObservedSteerHandler(registry);
    expect(() => handler(invoke({ id: 'observed:999', text: 'go' }))).toThrow(/No fleet node/);
  });

  test('a non-observed kind is refused (400) — never a back door to a native agent', () => {
    const nativeReg = {
      getNode: () => ({ id: 'a1', kind: 'agent' as const, label: 'x', state: 'thinking' as const, elapsedMs: 0, costState: 'unpriced' as const, capabilities: { interruptible: true, killable: true, pausable: false, resumable: false, steerable: true } }),
      steer: () => ({ queued: true as const, messageId: 'x' }),
    };
    const handler = createFleetObservedSteerHandler(nativeReg);
    expect(() => handler(invoke({ id: 'a1', text: 'go' }))).toThrow(/observed-external/);
  });

  test('missing id/text are rejected', () => {
    const handler = createFleetObservedSteerHandler(registry);
    expect(() => handler(invoke({ text: 'go' }))).toThrow(/id is required/);
    expect(() => handler(invoke({ id: observedNode.id }))).toThrow(/text is required/);
  });
});
