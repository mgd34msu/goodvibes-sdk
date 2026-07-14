/**
 * fleet-pick-conflict-lifecycle-verbs.test.ts
 *
 * The fleet package's "nobody transcribes a path or id" verbs:
 *  - fleet.attempts.pick completes winner choice → confirm → applied in ONE
 *    verb (the confirm preview returns the group's candidates + diffs; confirm
 *    applies), round-tripped through a REAL workstream via the attempts
 *    coordinator.
 *  - fleet.conflicts.list / .resolve: a conflict row's one action spawns the
 *    seeded resolution session (tree path + structured conflict list in the
 *    seed) and stamps the real session id back.
 *  - worktrees.discard actually discards (directory removed, branch KEPT,
 *    dirty state preserved as a commit, honest receipt) over a REAL git repo.
 *  - approveAndLaunchProposal is one confirmed act (proposal → running
 *    workstream), refusing without confirm.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import {
  createFleetAttemptsListHandler,
  createFleetAttemptsPickHandler,
  createFleetConflictsListHandler,
  createFleetConflictsResolveHandler,
  type FleetAttemptsController,
  type FleetConflictsDeps,
} from '../packages/sdk/src/platform/control-plane/routes/fleet.ts';
import { registerWorktreeSetupGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/worktree-setup.ts';
import { WorktreeRegistry } from '../packages/sdk/src/platform/runtime/worktree/registry.ts';
import {
  createAttemptsCoordinator,
  approveAndLaunchProposal,
  emptyWorkItemUsage,
} from '../packages/sdk/src/platform/orchestration/index.ts';
import type { WorkItem, WorkItemSpec, Workstream } from '../packages/sdk/src/platform/orchestration/types.ts';
import type { PlanProposal } from '../packages/sdk/src/platform/core/plan-proposal.ts';

const ctx = { context: { principalId: 'op', admin: true } } as const;

function makeItem(spec: WorkItemSpec): WorkItem {
  return {
    id: spec.id ?? `item-${Math.random().toString(36).slice(2, 8)}`,
    title: spec.title, task: spec.task, dependsOn: [], currentPhaseId: 'phase-1',
    state: 'pending', allAgentIds: [], visits: new Map(), touchedPaths: [],
    usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0,
  };
}

describe('fleet.attempts.pick — one act: choice → confirm → applied', () => {
  function pickHarness(): { catalog: GatewayMethodCatalog; ws: Workstream; enqueued: string[]; cleaned: string[] } {
    const enqueued: string[] = [];
    const cleaned: string[] = [];
    let ws: Workstream = { id: 'ws-1', title: 'ws', schemaVersion: 1, phases: [], items: [], isolation: 'worktree', createdAt: 0 };
    const coordinator = createAttemptsCoordinator({
      emit: () => {},
      getWorkstream: () => ws,
      enqueueIntegration: (_w, item) => { enqueued.push(item.id); },
      cleanupWorktree: async (_w, item) => { cleaned.push(item.id); },
      diffItem: async (item) => ({ files: [`${item.id}.ts`], unifiedDiff: `diff ${item.id}`, stat: '1 file' }),
    });
    // A REAL workstream: expand attempts:2 and drive both to terminal.
    const items = coordinator.expandItems('ws-1', 'worktree', [{ id: 'feat', title: 'Feature', task: 'build', attempts: 2 }], makeItem);
    ws = { ...ws, items };
    for (const item of items) {
      item.state = 'passed';
      coordinator.onItemPassedTerminal(ws, item); // parks each as held-merge
    }
    const controller: FleetAttemptsController = {
      listHeldMergeGroups: (id) => coordinator.listGroups(id),
      pickAttemptWinner: (g, w) => coordinator.pickWinner(g, w),
      proposeAttemptWinner: (g) => coordinator.proposeWinner(g),
    };
    const catalog = new GatewayMethodCatalog();
    const attach = (id: string, handler: ReturnType<typeof createFleetAttemptsListHandler>): void => {
      const d = catalog.get(id);
      if (d) catalog.register(d, handler, { replace: true });
    };
    attach('fleet.attempts.list', createFleetAttemptsListHandler(controller));
    attach('fleet.attempts.pick', createFleetAttemptsPickHandler(controller));
    return { catalog, ws, enqueued, cleaned };
  }

  test('without confirm: a structured preview carrying the group (candidates + diffs), nothing applied', async () => {
    const h = pickHarness();
    const groupId = h.ws.items[0]!.attemptGroupId!;
    const winner = h.ws.items[0]!.id;
    const preview = await h.catalog.invoke('fleet.attempts.pick', { ...ctx, body: { groupId, winnerItemId: winner } }) as {
      applied: boolean; requiresConfirm?: boolean; group?: { ready: boolean; candidates: Array<{ itemId: string; diff: { unifiedDiff: string } | null }> };
    };
    expect(preview.applied).toBe(false);
    expect(preview.requiresConfirm).toBe(true);
    expect(preview.group?.ready).toBe(true);
    expect(preview.group?.candidates).toHaveLength(2);
    expect(preview.group?.candidates[0]?.diff?.unifiedDiff).toContain('diff ');
    expect(h.enqueued).toHaveLength(0);
    expect(h.cleaned).toHaveLength(0);
  });

  test('with confirm: applied — winner merged through the lane, losers cleaned', async () => {
    const h = pickHarness();
    const groupId = h.ws.items[0]!.attemptGroupId!;
    const winner = h.ws.items[0]!.id;
    const loser = h.ws.items[1]!.id;
    const applied = await h.catalog.invoke('fleet.attempts.pick', { ...ctx, body: { groupId, winnerItemId: winner, confirm: true } }) as {
      applied: boolean; winnerItemId: string; loserItemIds: string[];
    };
    expect(applied.applied).toBe(true);
    expect(applied.winnerItemId).toBe(winner);
    expect(applied.loserItemIds).toEqual([loser]);
    expect(h.enqueued).toEqual([winner]);
    expect(h.cleaned).toEqual([loser]);
  });

  test('preview of an unknown group / non-held winner is an honest 409', async () => {
    const h = pickHarness();
    await expect(h.catalog.invoke('fleet.attempts.pick', { ...ctx, body: { groupId: 'nope', winnerItemId: 'x' } })).rejects.toThrow(/Unknown attempt group/);
  });
});

describe('fleet.conflicts.* — the conflict row acts on data, never transcription', () => {
  function conflictHarness(): {
    catalog: GatewayMethodCatalog; stamped: Array<[string, string]>; seeds: unknown[];
  } {
    const stamped: Array<[string, string]> = [];
    const seeds: unknown[] = [];
    const deps: FleetConflictsDeps = {
      listWorkstreams: () => [{
        id: 'ws-1',
        items: [
          { id: 'item-ok', title: 'clean', mergeState: 'merged' },
          {
            id: 'item-conf', title: 'payments', mergeState: 'conflict',
            worktreePath: '/tmp/kept-tree', worktreeBranch: 'ws/x/item-conf',
            conflictFiles: ['src/pay.ts', 'src/tax.ts'],
          },
        ],
      }],
      stampConflictSession: (itemId, sessionId) => { stamped.push([itemId, sessionId]); return true; },
      startResolutionSession: async (seed) => { seeds.push(seed); return { sessionId: 'sess-real-1' }; },
    };
    const catalog = new GatewayMethodCatalog();
    const listDesc = catalog.get('fleet.conflicts.list');
    const resolveDesc = catalog.get('fleet.conflicts.resolve');
    if (listDesc) catalog.register(listDesc, createFleetConflictsListHandler(deps), { replace: true });
    if (resolveDesc) catalog.register(resolveDesc, createFleetConflictsResolveHandler(deps), { replace: true });
    return { catalog, stamped, seeds };
  }

  test('list serves only conflicted items, with the structured file list and tree path', async () => {
    const h = conflictHarness();
    const out = await h.catalog.invoke('fleet.conflicts.list', { ...ctx, body: {} }) as {
      conflicts: Array<{ itemId: string; worktreePath: string; files: string[] }>;
    };
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toMatchObject({ itemId: 'item-conf', worktreePath: '/tmp/kept-tree', files: ['src/pay.ts', 'src/tax.ts'] });
  });

  test('resolve spawns the seeded session (path + conflict list in the seed) and stamps the REAL id', async () => {
    const h = conflictHarness();
    const out = await h.catalog.invoke('fleet.conflicts.resolve', { ...ctx, body: { itemId: 'item-conf' } }) as {
      itemId: string; sessionId: string; worktreePath: string; files: string[];
    };
    expect(out).toMatchObject({ itemId: 'item-conf', sessionId: 'sess-real-1', worktreePath: '/tmp/kept-tree', files: ['src/pay.ts', 'src/tax.ts'] });
    // The seed carried the kept-tree path, branch, and STRUCTURED files.
    expect(h.seeds[0]).toMatchObject({ worktreePath: '/tmp/kept-tree', branch: 'ws/x/item-conf', files: ['src/pay.ts', 'src/tax.ts'] });
    // The real session id was stamped back onto the item.
    expect(h.stamped).toEqual([['item-conf', 'sess-real-1']]);
  });

  test('resolve on a non-conflicted item is an honest 409', async () => {
    const h = conflictHarness();
    await expect(h.catalog.invoke('fleet.conflicts.resolve', { ...ctx, body: { itemId: 'item-ok' } })).rejects.toThrow(/no unresolved merge conflict/);
  });
});

describe('worktrees.discard — discard performs its meaning', () => {
  function runGit(cwd: string, args: string[]): string {
    const result = Bun.spawnSync(['git', ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString('utf8'));
    return Buffer.from(result.stdout).toString('utf8');
  }

  test('dirty worktree: preservation commit on the KEPT branch, directory removed, honest receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'discard-root-'));
    try {
      runGit(root, ['init']);
      runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'seed']);
      const wtPath = join(root, '.goodvibes', '.worktrees', 'agent-x1');
      mkdirSync(join(root, '.goodvibes', '.worktrees'), { recursive: true });
      runGit(root, ['worktree', 'add', '-b', 'wt/x1', wtPath]);
      // Dirty the tree with unsaved work.
      writeFileSync(join(wtPath, 'wip.txt'), 'unsaved work\n');

      const registry = new WorktreeRegistry(root);
      const receipt = await registry.discard(wtPath);
      expect(receipt.ok).toBe(true);
      expect(receipt.branch).toBe('wt/x1');
      expect(receipt.preservedCommit).toBeDefined();
      // The directory is GONE…
      expect(existsSync(wtPath)).toBe(false);
      // …the branch is KEPT, and the preservation commit is on it.
      expect(runGit(root, ['branch', '--list', 'wt/x1'])).toContain('wt/x1');
      const preserved = runGit(root, ['show', '--stat', receipt.preservedCommit!]);
      expect(preserved).toContain('wip.txt');
      // Receipt names what happened in plain language.
      expect(receipt.detail).toContain('preserved');

      // The verb serves the same receipt.
      const catalog = new GatewayMethodCatalog();
      registerWorktreeSetupGatewayMethods(catalog, {
        registry,
        sourceRoot: root,
        resolveConfig: () => ({ commands: [], carryOverGlobs: [] }),
      });
      expect(catalog.hasHandler('worktrees.discard')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('a clean worktree discards without a preservation commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'discard-clean-'));
    try {
      runGit(root, ['init']);
      runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'seed']);
      const wtPath = join(root, '.goodvibes', '.worktrees', 'agent-x2');
      mkdirSync(join(root, '.goodvibes', '.worktrees'), { recursive: true });
      runGit(root, ['worktree', 'add', '-b', 'wt/x2', wtPath]);
      const registry = new WorktreeRegistry(root);
      const receipt = await registry.discard(wtPath);
      expect(receipt.ok).toBe(true);
      expect(receipt.preservedCommit).toBeUndefined();
      expect(existsSync(wtPath)).toBe(false);
      expect(runGit(root, ['branch', '--list', 'wt/x2'])).toContain('wt/x2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('approveAndLaunchProposal — one confirmed act', () => {
  const proposal: PlanProposal = {
    id: 'prop-1', task: 'ship the thing', strategy: 'single', rationale: 'one item',
    phases: [{ id: 'ph-1', title: 'Execute', order: 0 }],
    workItems: [{ id: 'wi-1', title: 'Ship it', brief: 'do the shipping', phaseId: 'ph-1', dependsOn: [] }],
    createdAt: 0, source: 'single-item-fallback',
  } as PlanProposal;
  const config = { get: () => undefined, getCategory: () => ({}) } as never;

  test('without confirm: structured refusal, nothing created or started', () => {
    const created: string[] = [];
    const engine = {
      createWorkstream: (input: { title: string }) => { created.push(input.title); return { id: 'ws-x' } as Workstream; },
      start: () => { created.push('started'); },
    };
    const refusal = approveAndLaunchProposal(engine as never, proposal, config, {});
    expect(refusal).toEqual({ launched: false, requiresConfirm: true });
    expect(created).toHaveLength(0);
  });

  test('with confirm: assembled, created, and STARTED in one call', () => {
    const calls: string[] = [];
    const engine = {
      createWorkstream: (input: { title: string; items: readonly unknown[] }) => {
        calls.push(`create:${input.items.length}`);
        return { id: 'ws-launched' } as Workstream;
      },
      start: (id: string) => { calls.push(`start:${id}`); },
    };
    const launched = approveAndLaunchProposal(engine as never, proposal, config, { confirm: true });
    expect(launched).toEqual({ launched: true, workstreamId: 'ws-launched' });
    expect(calls).toEqual(['create:1', 'start:ws-launched']);
  });
});
