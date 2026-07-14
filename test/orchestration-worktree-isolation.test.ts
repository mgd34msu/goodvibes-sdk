/**
 * Worktree isolation (wo/worktree-isolation) — stage (a): the REAL
 * IsolatedWorktree lifecycle + the engine's sequential integration lane,
 * driven end to end through createOrchestrationEngine with a FAKE agentManager
 * whose "agent" writes real files into item.worktreePath. No AgentOrchestrator
 * involved (that's stage (b) — see orchestration-agent-cwd.test.ts) — this
 * file proves the engine's own worktree-mode wiring (claim-time creation,
 * merge-lane integration with conflict-keep-and-continue, fail/kill cleanup
 * rules, orphan reconciliation, per-worktree dirty-guard) against a REAL git
 * repository.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { emitAgentCompleted, emitAgentFailed } from '../packages/sdk/src/platform/runtime/emitters/agents.js';
import { createOrchestrationEngine, type OrchestrationEngineDeps } from '../packages/sdk/src/platform/orchestration/engine.js';
import { snapshotDirtyTree } from '../packages/sdk/src/platform/orchestration/dirty-guard.js';
import type { PhaseRunnerAgentManagerLike } from '../packages/sdk/src/platform/orchestration/phase-runner.js';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/manager.js';
import type { OrchestrationEvent, PhaseSpec, WorkItemSpec } from '../packages/sdk/src/platform/orchestration/types.js';
import { engineerReportOutput, makeFakeConfigManager, makeRecord } from './_helpers/orchestration-harness.js';

const ctx = { sessionId: 'test', traceId: 'test', source: 'test' } as const;

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
  return Buffer.from(result.stdout).toString('utf8');
}

function initRepo(root: string): void {
  runGit(root, ['init']);
  runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'seed']);
}

/** Real-clock polling — worktree creation/merge/commit go through real `git` subprocesses, which resolve on macrotask boundaries, not microtasks (same reasoning as dirty-guard.ts's snapshotDirtyTree doc comment). */
async function waitUntil(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface WtHarness {
  readonly bus: RuntimeEventBus;
  readonly agentManager: PhaseRunnerAgentManagerLike;
  readonly agentStore: Map<string, AgentRecord>;
  readonly workingDirByAgent: Map<string, string | undefined>;
  readonly spawnedIds: string[];
  completeAgent(agentId: string, output: string): void;
  failAgent(agentId: string, error: string): void;
}

function makeWtHarness(): WtHarness {
  const bus = new RuntimeEventBus();
  const agentStore = new Map<string, AgentRecord>();
  const workingDirByAgent = new Map<string, string | undefined>();
  const spawnedIds: string[] = [];
  let counter = 0;

  const agentManager: PhaseRunnerAgentManagerLike = {
    spawn: (input) => {
      counter += 1;
      const id = `agent-${counter}`;
      const rawInput = input as unknown as { task?: string; template?: string; workingDirectory?: string };
      const record = makeRecord({ id, task: rawInput.task ?? 'task', template: rawInput.template ?? 'engineer' });
      agentStore.set(id, record);
      workingDirByAgent.set(id, rawInput.workingDirectory);
      spawnedIds.push(id);
      return record;
    },
    getStatus: (id) => agentStore.get(id) ?? null,
    cancel: (id) => {
      const record = agentStore.get(id);
      if (record) record.status = 'cancelled';
      return true;
    },
    registerCancellationSignal: () => undefined,
    releaseCancellationSignal: () => undefined,
  };

  function completeAgent(agentId: string, output: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'completed';
    record.fullOutput = output;
    record.usage = { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 };
    emitAgentCompleted(bus, ctx, { agentId, durationMs: 1 });
  }

  function failAgent(agentId: string, error: string): void {
    const record = agentStore.get(agentId)!;
    record.status = 'failed';
    record.error = error;
    emitAgentFailed(bus, ctx, { agentId, error, durationMs: 1 });
  }

  return { bus, agentManager, agentStore, workingDirByAgent, spawnedIds, completeAgent, failAgent };
}

function enginePhase(capacity = 1): PhaseSpec {
  return { role: 'engineer', capacity, kind: 'engineer', gate: { scope: 'scoped', gates: [] } };
}

function makeEngine(root: string, h: WtHarness, overrides: Partial<OrchestrationEngineDeps> = {}) {
  return createOrchestrationEngine({
    agentManager: h.agentManager,
    configManager: makeFakeConfigManager(),
    runtimeBus: h.bus,
    projectRoot: root,
    persist: false,
    skipClaimVerification: true,
    ...overrides,
  });
}

let root: string;

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-isolation-'));
  initRepo(dir);
  return dir;
}

describe('WorktreeIsolationManager — claim-time creation + concurrent non-conflicting edits', () => {
  test('two items editing the SAME file on different lines both pass, integrate sequentially, and both hunks land', async () => {
    root = freshRoot();
    writeFileSync(join(root, 'shared.txt'), 'line1\nline2\nline3\n');
    runGit(root, ['add', 'shared.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed shared.txt']);

    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [
      { id: 'item-top', title: 'top', task: 'edit top' },
      { id: 'item-bottom', title: 'bottom', task: 'edit bottom' },
    ];
    const ws = engine.createWorkstream({
      id: 'ws-concurrent', title: 'concurrent edit', phases: [enginePhase(2)], items, isolation: 'worktree',
    });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 2);
    const top = ws.items.find((i) => i.id === 'item-top')!;
    const bottom = ws.items.find((i) => i.id === 'item-bottom')!;
    expect(top.worktreePath).toBeDefined();
    expect(bottom.worktreePath).toBeDefined();
    expect(top.worktreePath).not.toBe(bottom.worktreePath);
    expect(existsSync(top.worktreePath!)).toBe(true);
    expect(existsSync(bottom.worktreePath!)).toBe(true);

    // Each item's worktree is a fresh checkout of the SAME base file.
    expect(readFileSync(join(top.worktreePath!, 'shared.txt'), 'utf-8')).toBe('line1\nline2\nline3\n');

    // Non-conflicting hunks: top prepends, bottom appends.
    writeFileSync(join(top.worktreePath!, 'shared.txt'), 'TOP\nline1\nline2\nline3\n');
    writeFileSync(join(bottom.worktreePath!, 'shared.txt'), 'line1\nline2\nline3\nBOTTOM\n');

    const topAgentId = h.spawnedIds.find((id) => h.workingDirByAgent.get(id) === top.worktreePath)!;
    const bottomAgentId = h.spawnedIds.find((id) => h.workingDirByAgent.get(id) === bottom.worktreePath)!;
    h.completeAgent(topAgentId, engineerReportOutput({ filesModified: ['shared.txt'] }));
    h.completeAgent(bottomAgentId, engineerReportOutput({ filesModified: ['shared.txt'] }));

    // Wait for the terminal worktree-lifecycle event (removed/kept), not just
    // item-merged/item-merge-conflict — the lane emits the merge-outcome
    // event BEFORE awaiting the (real, async) worktree removal, so the
    // removal/keep bookkeeping can still be in flight right after the merge
    // event lands.
    await waitUntil(
      () => events.filter((e) => e.type === 'item-worktree-removed' || e.type === 'item-worktree-kept').length === 2,
      { timeoutMs: 20_000 },
    );

    const mergedEvents = events.filter((e): e is Extract<OrchestrationEvent, { type: 'item-merged' }> => e.type === 'item-merged');
    expect(mergedEvents).toHaveLength(2);
    expect(top.mergeState).toBe('merged');
    expect(bottom.mergeState).toBe('merged');
    expect(top.mergeHash).toBeDefined();
    expect(bottom.mergeHash).toBeDefined();
    // Cleanly merged worktrees are reclaimed.
    expect(top.worktreePath).toBeUndefined();
    expect(bottom.worktreePath).toBeUndefined();
    expect(top.worktreeKept).toBeFalsy();
    expect(bottom.worktreeKept).toBeFalsy();

    // BOTH hunks landed in the base tree's file — the whole point of the test.
    const finalContent = readFileSync(join(root, 'shared.txt'), 'utf-8');
    expect(finalContent).toContain('TOP');
    expect(finalContent).toContain('BOTTOM');
    expect(finalContent.split('\n')[0]).toBe('TOP');
    expect(finalContent.trim().split('\n').at(-1)).toBe('BOTTOM');

    // Branches are cleaned up on the root repo.
    const branches = runGit(root, ['branch', '--list', 'ws/*']);
    expect(branches.trim()).toBe('');

    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test('a genuine conflict keeps the losing worktree + branch, records blockedReason, and lets the lane continue', async () => {
    root = freshRoot();
    writeFileSync(join(root, 'shared.txt'), 'original\n');
    runGit(root, ['add', 'shared.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed shared.txt']);

    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [
      { id: 'item-first', title: 'first', task: 'edit line' },
      { id: 'item-second', title: 'second', task: 'edit same line' },
    ];
    const ws = engine.createWorkstream({
      id: 'ws-conflict', title: 'conflict', phases: [enginePhase(2)], items, isolation: 'worktree',
    });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 2);
    const first = ws.items.find((i) => i.id === 'item-first')!;
    const second = ws.items.find((i) => i.id === 'item-second')!;

    writeFileSync(join(first.worktreePath!, 'shared.txt'), 'first-wins\n');
    writeFileSync(join(second.worktreePath!, 'shared.txt'), 'second-wins\n');

    // Complete + let the FIRST item's phase run to completion (and its merge
    // land) BEFORE the second completes, so the conflict is deterministic:
    // the lane merges in completion order, and 'first' unambiguously lands
    // first.
    const firstAgentId = h.spawnedIds.find((id) => h.workingDirByAgent.get(id) === first.worktreePath)!;
    const secondAgentId = h.spawnedIds.find((id) => h.workingDirByAgent.get(id) === second.worktreePath)!;
    h.completeAgent(firstAgentId, engineerReportOutput({ filesModified: ['shared.txt'] }));
    await waitUntil(() => events.some((e) => e.type === 'item-merged' && e.itemId === 'item-first'), { timeoutMs: 20_000 });

    h.completeAgent(secondAgentId, engineerReportOutput({ filesModified: ['shared.txt'] }));
    await waitUntil(() => events.some((e) => e.type === 'item-merge-conflict' && e.itemId === 'item-second'), { timeoutMs: 20_000 });

    expect(first.mergeState).toBe('merged');
    expect(readFileSync(join(root, 'shared.txt'), 'utf-8')).toBe('first-wins\n');

    expect(second.mergeState).toBe('conflict');
    expect(second.blockedReason).toMatch(/^merge-conflict:/);
    expect(second.worktreeKept).toBe(true);
    // The worktree + branch are KEPT — never silently dropped.
    expect(second.worktreePath).toBeDefined();
    expect(existsSync(second.worktreePath!)).toBe(true);
    const branches = runGit(root, ['branch', '--list', 'ws/*']);
    expect(branches).toContain(second.worktreeBranch!);

    const keptEvent = events.find((e) => e.type === 'item-worktree-kept' && e.itemId === 'item-second');
    expect(keptEvent).toBeDefined();

    // The item itself is still terminally 'passed' — mergeState is orthogonal
    // to the pipeline verdict (see ItemMergeState's doc, types.ts).
    expect(second.state).toBe('passed');

    // The conflict list is STRUCTURED data on the item (a resolution session
    // seeds from it), not just blockedReason prose.
    expect(second.conflictFiles).toEqual(['shared.txt']);

    // The real-session-id stamp: only a conflicted item accepts it.
    expect(engine.stampConflictSession('item-second', 'sess-resolve-1')).toBe(true);
    expect(second.conflictSessionId).toBe('sess-resolve-1');
    expect(engine.stampConflictSession('item-first', 'sess-x')).toBe(false);

    // RESOLUTION inside the kept tree: resolve the conflict against base and
    // commit onto the item branch (exactly what the seeded session does)…
    writeFileSync(join(second.worktreePath!, 'shared.txt'), 'first-wins\nsecond-wins\n');
    runGit(second.worktreePath!, ['add', 'shared.txt']);
    // Fold base in so the branch merges cleanly (the resolution commit).
    runGit(second.worktreePath!, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'resolve conflict']);
    const baseBranch = runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    runGit(second.worktreePath!, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'merge', '-X', 'ours', baseBranch]);

    // …then SUCCESS RECLAIMS: the re-merge lands and the kept tree comes off disk.
    const keptPath = second.worktreePath!;
    const outcome = await engine.retryItemIntegration('item-second');
    expect(outcome).toBe('merged');
    expect(second.mergeState).toBe('merged');
    expect(second.conflictFiles).toBeUndefined();
    expect(existsSync(keptPath)).toBe(false);
    // Honest refusal on a non-conflicted item.
    expect(await engine.retryItemIntegration('item-first')).toBe('not-conflicted');

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe('WorktreeIsolationManager — shared isolation (default) stays fully untouched', () => {
  test('no worktree/branch is ever created when isolation is omitted, even with concurrent items touching the same file', async () => {
    root = freshRoot();
    writeFileSync(join(root, 'shared.txt'), 'original\n');
    runGit(root, ['add', 'shared.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);

    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [{ id: 'item-a', title: 'a', task: 'edit' }, { id: 'item-b', title: 'b', task: 'edit' }];
    const ws = engine.createWorkstream({ id: 'ws-shared', title: 'shared', phases: [enginePhase(2)], items });
    expect(ws.isolation).toBeUndefined();
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 2);
    expect(h.workingDirByAgent.get(h.spawnedIds[0]!)).toBeUndefined();
    expect(h.workingDirByAgent.get(h.spawnedIds[1]!)).toBeUndefined();
    expect(ws.items[0]!.worktreePath).toBeUndefined();
    expect(ws.items[1]!.worktreePath).toBeUndefined();

    h.completeAgent(h.spawnedIds[0]!, engineerReportOutput({ filesModified: ['shared.txt'] }));
    h.completeAgent(h.spawnedIds[1]!, engineerReportOutput({ filesModified: ['shared.txt'] }));
    await waitUntil(() => ws.items.every((i) => i.state === 'passed' || i.state === 'failed'), { timeoutMs: 20_000 });

    expect(existsSync(join(root, '.goodvibes', '.worktrees'))).toBe(false);
    expect(events.some((e) => e.type.startsWith('item-worktree') || e.type === 'item-merged' || e.type === 'item-merge-conflict')).toBe(false);

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe('WorktreeIsolationManager — fail/kill cleanup rules', () => {
  test('kill on a DIRTY worktree keeps it; kill on a CLEAN worktree removes it', async () => {
    root = freshRoot();
    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [{ id: 'item-dirty', title: 'dirty', task: 't' }, { id: 'item-clean', title: 'clean', task: 't' }];
    const ws = engine.createWorkstream({ id: 'ws-kill', title: 'kill', phases: [enginePhase(2)], items, isolation: 'worktree' });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 2);
    const dirty = ws.items.find((i) => i.id === 'item-dirty')!;
    const clean = ws.items.find((i) => i.id === 'item-clean')!;
    expect(existsSync(dirty.worktreePath!)).toBe(true);
    expect(existsSync(clean.worktreePath!)).toBe(true);

    // Leave the "dirty" item's worktree with an uncommitted edit before killing it.
    writeFileSync(join(dirty.worktreePath!, 'wip.txt'), 'uncommitted work\n');

    engine.kill('item-dirty');
    engine.kill('item-clean');

    await waitUntil(
      () => events.some((e) => e.type === 'item-worktree-kept' && e.itemId === 'item-dirty')
        && events.some((e) => e.type === 'item-worktree-removed' && e.itemId === 'item-clean'),
      { timeoutMs: 20_000 },
    );

    expect(dirty.state).toBe('failed');
    expect(dirty.worktreeKept).toBe(true);
    expect(dirty.worktreePath).toBeDefined();
    expect(existsSync(dirty.worktreePath!)).toBe(true);
    expect(existsSync(join(dirty.worktreePath!, 'wip.txt'))).toBe(true);

    expect(clean.state).toBe('failed');
    expect(clean.worktreeKept).toBeFalsy();
    expect(clean.worktreePath).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test('a failed agent (not killed) triggers the same clean-worktree removal rule', async () => {
    root = freshRoot();
    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [{ id: 'item-x', title: 'x', task: 't' }];
    const ws = engine.createWorkstream({ id: 'ws-agentfail', title: 'agentfail', phases: [enginePhase(1)], items, isolation: 'worktree' });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 1);
    const item = ws.items[0]!;
    expect(existsSync(item.worktreePath!)).toBe(true);

    h.failAgent(h.spawnedIds[0]!, 'boom');
    await waitUntil(() => item.state === 'failed', { timeoutMs: 20_000 });
    await waitUntil(() => events.some((e) => e.type === 'item-worktree-removed' && e.itemId === 'item-x'), { timeoutMs: 20_000 });

    expect(item.worktreePath).toBeUndefined();
    expect(item.worktreeKept).toBeFalsy();

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe('WorktreeIsolationManager — orphan reconciliation (adopt-or-report)', () => {
  test('an unrecorded ws/* worktree matching a known non-terminal item is ADOPTED; an unrecorded one matching no item is REPORTED, never deleted', async () => {
    root = freshRoot();
    const engineA = makeEngine(root, makeWtHarness());
    const ws = engineA.createWorkstream({
      id: 'ws-orphan', title: 'orphan', phases: [enginePhase(1)],
      items: [{ id: 'item-x', title: 'X', task: 't' }],
      isolation: 'worktree',
    });

    // Simulate a crash: a worktree/branch exists on disk for item-x's
    // CANONICAL path/branch, but the snapshot never recorded it (the process
    // died between `git worktree add` and the debounced write).
    const canonicalPath = join(root, '.goodvibes', '.worktrees', 'ws', 'orphan', 'x');
    runGit(root, ['worktree', 'add', canonicalPath, '-b', 'ws/orphan/x']);
    // A second orphan with NO matching item at all (a stale/foreign worktree).
    const ghostPath = join(root, '.goodvibes', '.worktrees', 'ws', 'orphan', 'ghost');
    runGit(root, ['worktree', 'add', ghostPath, '-b', 'ws/orphan/ghost']);

    expect(ws.items[0]!.worktreePath).toBeUndefined(); // not recorded — matches the crash scenario

    const snapshotJson = engineA.serializeWorkstream(ws.id)!;

    const engineB = makeEngine(root, makeWtHarness());
    const events: OrchestrationEvent[] = [];
    engineB.on((e) => events.push(e));

    const imported = engineB.importWorkstream(snapshotJson, true);
    expect(imported).toBe(true);

    const reconciled = events.filter((e): e is Extract<OrchestrationEvent, { type: 'orphan-worktree-reconciled' }> => e.type === 'orphan-worktree-reconciled');
    expect(reconciled).toHaveLength(2);
    const adopted = reconciled.find((e) => e.branch === 'ws/orphan/x');
    const reported = reconciled.find((e) => e.branch === 'ws/orphan/ghost');
    expect(adopted?.disposition).toBe('adopted');
    expect(reported?.disposition).toBe('reported');

    const importedWs = engineB.getWorkstream('ws-orphan')!;
    const itemX = importedWs.items.find((i) => i.id === 'item-x')!;
    expect(itemX.worktreePath).toBe(canonicalPath);
    expect(itemX.worktreeBranch).toBe('ws/orphan/x');

    // Reported (unmatched) worktree is left exactly in place — never deleted on sight.
    expect(existsSync(ghostPath)).toBe(true);

    // Reusing the adopted worktree at claim time must not attempt to re-create
    // it (which would throw — the path already exists).
    engineB.start(importedWs.id);
    await waitUntil(() => existsSync(join(canonicalPath, '.git')), { timeoutMs: 5000 }).catch(() => undefined);
    expect(existsSync(canonicalPath)).toBe(true);

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe('WorktreeIsolationManager — empty integration (no commits beyond base)', () => {
  test('an item whose phase never committed anything integrates as an honest no-op: mergeState "merged", no hash, worktree reclaimed', async () => {
    root = freshRoot();
    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    // gate scope 'off' disables the scoped commit entirely (see
    // phase-runner.ts commitPhaseWork) — the item branch never gets a commit.
    const offPhase: PhaseSpec = { role: 'engineer', capacity: 1, kind: 'engineer', gate: { scope: 'off', gates: [] } };
    const engine = makeEngine(root, h);
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [{ id: 'item-noop', title: 'noop', task: 't' }];
    const ws = engine.createWorkstream({ id: 'ws-empty', title: 'empty', phases: [offPhase], items, isolation: 'worktree' });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 1);
    const item = ws.items[0]!;
    h.completeAgent(h.spawnedIds[0]!, engineerReportOutput({}));

    await waitUntil(() => events.some((e) => e.type === 'item-worktree-removed' && e.itemId === 'item-noop'), { timeoutMs: 20_000 });

    expect(item.state).toBe('passed');
    expect(item.mergeState).toBe('merged');
    expect(item.mergeHash).toBeUndefined();
    expect(item.worktreePath).toBeUndefined();
    // No item-merged event — there is no merge commit to report for a true no-op.
    expect(events.some((e) => e.type === 'item-merged' && e.itemId === 'item-noop')).toBe(false);

    rmSync(root, { recursive: true, force: true });
  }, 20_000);
});

describe('WorktreeIsolationManager — per-worktree dirty-guard', () => {
  test('a freshly created item worktree has an EMPTY launch-dirty snapshot', async () => {
    root = freshRoot();
    const h = makeWtHarness();
    const engine = makeEngine(root, h);
    const items: WorkItemSpec[] = [{ id: 'item-fresh', title: 'fresh', task: 't' }];
    const ws = engine.createWorkstream({ id: 'ws-fresh', title: 'fresh', phases: [enginePhase(1)], items, isolation: 'worktree' });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 1);
    const item = ws.items[0]!;
    expect(existsSync(item.worktreePath!)).toBe(true);

    const snapshot = snapshotDirtyTree(item.worktreePath!);
    expect(snapshot.size).toBe(0);

    rmSync(root, { recursive: true, force: true });
  }, 15_000);
});

describe('WorktreeIsolationManager — bounded kept-worktree cap, oldest-first eviction', () => {
  test('a third dirty kill evicts the OLDEST kept worktree once the cap (1) is exceeded', async () => {
    root = freshRoot();
    const h = makeWtHarness();
    const events: OrchestrationEvent[] = [];
    const engine = makeEngine(root, h, { keptWorktreeCap: 1 });
    engine.on((e) => events.push(e));

    const items: WorkItemSpec[] = [
      { id: 'item-one', title: 'one', task: 't' },
      { id: 'item-two', title: 'two', task: 't' },
    ];
    const ws = engine.createWorkstream({ id: 'ws-cap', title: 'cap', phases: [enginePhase(2)], items, isolation: 'worktree' });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 2);
    const one = ws.items.find((i) => i.id === 'item-one')!;
    const two = ws.items.find((i) => i.id === 'item-two')!;

    // Leave BOTH dirty so both kills produce a KEPT worktree.
    writeFileSync(join(one.worktreePath!, 'wip.txt'), 'wip-one\n');
    writeFileSync(join(two.worktreePath!, 'wip.txt'), 'wip-two\n');
    const onePath = one.worktreePath!;
    const twoPath = two.worktreePath!;

    // Kill 'one' first (it becomes the OLDEST kept entry), then 'two' — the
    // cap of 1 means adding the second KEPT worktree must evict the first.
    engine.kill('item-one');
    await waitUntil(() => events.some((e) => e.type === 'item-worktree-kept' && e.itemId === 'item-one'), { timeoutMs: 20_000 });

    engine.kill('item-two');
    await waitUntil(
      () => events.some((e) => e.type === 'item-worktree-evicted' && e.itemId === 'item-one')
        && events.some((e) => e.type === 'item-worktree-kept' && e.itemId === 'item-two'),
      { timeoutMs: 20_000 },
    );

    // 'one' was evicted — its worktree DIRECTORY is gone and bookkeeping cleared.
    expect(existsSync(onePath)).toBe(false);
    expect(one.worktreePath).toBeUndefined();
    expect(one.worktreeKept).toBeFalsy();

    // ZERO DATA LOSS: eviction bounds disk usage, never work. The dirty state
    // was committed onto the item branch BEFORE the directory was removed, the
    // branch was KEPT (no `branch -D` on the eviction path), and the event
    // names the branch + preservation commit so the work is discoverable.
    const evictedEvent = events.find(
      (e): e is Extract<OrchestrationEvent, { type: 'item-worktree-evicted' }> =>
        e.type === 'item-worktree-evicted' && e.itemId === 'item-one',
    )!;
    expect(evictedEvent.branch).toBe(one.worktreeBranch!);
    expect(evictedEvent.preservedCommit).toBeTruthy();
    // The branch survives eviction …
    expect(runGit(root, ['branch', '--list', evictedEvent.branch]).trim()).not.toBe('');
    // … its tip is the preservation commit …
    expect(runGit(root, ['rev-parse', evictedEvent.branch]).trim()).toBe(evictedEvent.preservedCommit!);
    // … and the uncommitted work is byte-for-byte recoverable from it.
    expect(runGit(root, ['show', `${evictedEvent.branch}:wip.txt`])).toBe('wip-one\n');
    const recovered = join(root, 'recovered-after-eviction');
    runGit(root, ['worktree', 'add', recovered, evictedEvent.branch]);
    expect(readFileSync(join(recovered, 'wip.txt'), 'utf8')).toBe('wip-one\n');

    // 'two' is still kept — under the cap now that 'one' was evicted.
    expect(existsSync(twoPath)).toBe(true);
    expect(two.worktreeKept).toBe(true);
    expect(two.worktreePath).toBe(twoPath);

    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test('evicting a CONFLICTED kept worktree preserves both its commits and its dirty state on the kept branch', async () => {
    // Direct IsolatedWorktree-level proof (no engine): a branch with a real
    // commit AND uncommitted follow-up edits goes past the cap; after evict()
    // the directory is gone but every byte is on the branch.
    root = freshRoot();
    const { IsolatedWorktree } = await import('../packages/sdk/src/platform/agents/worktree.js');
    const wtPath = join(root, '.goodvibes', '.worktrees', 'ws', 'x', 'y');
    const wt = new IsolatedWorktree(root, wtPath, 'ws/x/y', 'main');
    await wt.create();
    writeFileSync(join(wtPath, 'committed.txt'), 'committed-work\n');
    runGit(wtPath, ['add', '-A']);
    runGit(wtPath, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'item work']);
    // Dirty follow-up: one modified tracked file, one untracked file.
    writeFileSync(join(wtPath, 'committed.txt'), 'committed-work EDITED\n');
    writeFileSync(join(wtPath, 'untracked.txt'), 'untracked-work\n');

    const { preservedCommit } = await wt.evict();

    expect(preservedCommit).toBeTruthy();
    expect(existsSync(wtPath)).toBe(false);
    // Branch kept; tip is the preservation commit on top of the item commit.
    expect(runGit(root, ['branch', '--list', 'ws/x/y']).trim()).not.toBe('');
    expect(runGit(root, ['rev-parse', 'ws/x/y']).trim()).toBe(preservedCommit!);
    expect(runGit(root, ['show', 'ws/x/y:committed.txt'])).toBe('committed-work EDITED\n');
    expect(runGit(root, ['show', 'ws/x/y:untracked.txt'])).toBe('untracked-work\n');
    expect(runGit(root, ['show', 'ws/x/y~1:committed.txt'])).toBe('committed-work\n');

    rmSync(root, { recursive: true, force: true });
  }, 15_000);

  test('evict() on an already-clean kept worktree removes only the directory and keeps the branch', async () => {
    root = freshRoot();
    const { IsolatedWorktree } = await import('../packages/sdk/src/platform/agents/worktree.js');
    const wtPath = join(root, '.goodvibes', '.worktrees', 'ws', 'c', 'd');
    const wt = new IsolatedWorktree(root, wtPath, 'ws/c/d', 'main');
    await wt.create();

    const { preservedCommit } = await wt.evict();

    expect(preservedCommit).toBeNull();
    expect(existsSync(wtPath)).toBe(false);
    expect(runGit(root, ['branch', '--list', 'ws/c/d']).trim()).not.toBe('');
    rmSync(root, { recursive: true, force: true });
  }, 15_000);
});

describe('WorktreeIsolationManager — cold-start setup hook', () => {
  test('runWorktreeSetup fires once per created item worktree, with that worktree path', async () => {
    root = freshRoot();
    writeFileSync(join(root, 'seed.txt'), 'seed\n');
    runGit(root, ['add', 'seed.txt']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);

    const h = makeWtHarness();
    const setupPaths: string[] = [];
    const engine = makeEngine(root, h, {
      runWorktreeSetup: async (worktreePath: string) => { setupPaths.push(worktreePath); },
    });

    const items: WorkItemSpec[] = [{ id: 'item-solo', title: 'solo', task: 'do it' }];
    const ws = engine.createWorkstream({
      id: 'ws-setup', title: 'setup hook', phases: [enginePhase(1)], items, isolation: 'worktree',
    });
    engine.start(ws.id);

    await waitUntil(() => h.spawnedIds.length === 1);
    const solo = ws.items.find((i) => i.id === 'item-solo')!;
    expect(solo.worktreePath).toBeDefined();
    await waitUntil(() => setupPaths.length === 1);
    expect(setupPaths[0]).toBe(solo.worktreePath);

    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});
