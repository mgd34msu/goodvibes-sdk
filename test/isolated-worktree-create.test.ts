/**
 * IsolatedWorktree.create(): the claim-time `git worktree add` behind the
 * engine's `worktree` isolation mode. The engine spawns an item's agent only
 * after create() settles, so a create that hangs leaves the item claimed and
 * unspawned forever, and a create that fails without cleaning up poisons every
 * later attempt for that item. Each case below forces one of those failure
 * modes for real, against a real git repository:
 *
 *   - a ref lock held by another git process on the first attempt,
 *   - an attempt that fails AFTER git already created the branch,
 *   - a git child that never finishes (a post-checkout hook that stalls),
 *   - a lock that is never released, seen through the engine: the item fails
 *     with a named reason and its sibling still spawns.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IsolatedWorktree } from '../packages/sdk/src/platform/agents/worktree.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createOrchestrationEngine } from '../packages/sdk/src/platform/orchestration/engine.js';
import type { PhaseRunnerAgentManagerLike } from '../packages/sdk/src/platform/orchestration/phase-runner.js';
import type { OrchestrationEvent } from '../packages/sdk/src/platform/orchestration/types.js';
import { makeFakeConfigManager, makeRecord } from './_helpers/orchestration-harness.js';

function git(cwd: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  return {
    code: result.exitCode ?? -1,
    out: Buffer.from(result.stdout).toString('utf8') + Buffer.from(result.stderr).toString('utf8'),
  };
}

function mustGit(cwd: string, args: string[]): string {
  const { code, out } = git(cwd, args);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${out}`);
  return out;
}

/** A repo with one commit, on the loose-file ref backend so a ref lock is a plain `<ref>.lock` file. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-create-'));
  mustGit(root, ['init', '--ref-format=files', '-b', 'main']);
  writeFileSync(join(root, 'shared.txt'), 'original\n');
  mustGit(root, ['add', 'shared.txt']);
  mustGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
  return root;
}

function branchExists(root: string, branch: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
}

function worktreeListed(root: string, path: string): boolean {
  return mustGit(root, ['worktree', 'list', '--porcelain']).includes(`worktree ${path}\n`);
}

/** Hold the ref lock git takes to create `branch`, exactly what a concurrent git process holding it looks like on disk. */
function holdRefLock(root: string, branch: string): string {
  const lockPath = join(root, '.git', 'refs', 'heads', `${branch}.lock`);
  mkdirSync(join(lockPath, '..'), { recursive: true });
  writeFileSync(lockPath, '');
  return lockPath;
}

describe('IsolatedWorktree.create: bounded, retried, self-cleaning', () => {
  test('a ref lock held by another git process on the first attempt is retried, and the worktree is created', async () => {
    const root = freshRepo();
    try {
      const path = join(root, '.goodvibes', '.worktrees', 'ws', 'conflict', 'second');
      const branch = 'ws/conflict/second';
      const lockPath = holdRefLock(root, branch);
      const failures: string[] = [];
      const wt = new IsolatedWorktree(root, path, branch, 'main');

      await wt.create({
        retryDelayMs: 0,
        onAttemptFailed: ({ error }) => {
          failures.push(error);
          rmSync(lockPath); // the other git process finishes and releases its lock
        },
      });

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/lock/i);
      expect(existsSync(join(path, 'shared.txt'))).toBe(true);
      expect(worktreeListed(root, path)).toBe(true);
      expect(branchExists(root, branch)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('an attempt that fails after git already created the branch is cleaned up, so the retry succeeds', async () => {
    const root = freshRepo();
    try {
      const parent = join(root, '.goodvibes', '.worktrees', 'ws', 'conflict');
      const path = join(parent, 'second');
      const branch = 'ws/conflict/second';
      // A FILE where the worktree's parent directory must go: `git worktree add
      // -b` creates the branch, then fails creating the directory, leaving the
      // branch behind.
      mkdirSync(join(parent, '..'), { recursive: true });
      writeFileSync(parent, 'not a directory');
      const failures: string[] = [];
      const branchLeftAfterFailure: boolean[] = [];
      const wt = new IsolatedWorktree(root, path, branch, 'main');

      await wt.create({
        retryDelayMs: 0,
        onAttemptFailed: ({ error }) => {
          failures.push(error);
          branchLeftAfterFailure.push(branchExists(root, branch));
          rmSync(parent); // the obstruction goes away
        },
      });

      expect(failures).toHaveLength(1);
      // The failed attempt's branch was removed before the retry, not left to
      // fail it with "a branch named ... already exists".
      expect(branchLeftAfterFailure).toEqual([false]);
      expect(existsSync(join(path, 'shared.txt'))).toBe(true);
      expect(worktreeListed(root, path)).toBe(true);
      expect(branchExists(root, branch)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('a git child that never finishes is stopped at the attempt deadline and the next attempt creates the worktree', async () => {
    const root = freshRepo();
    try {
      const path = join(root, '.goodvibes', '.worktrees', 'ws', 'conflict', 'second');
      const branch = 'ws/conflict/second';
      // post-checkout runs inside `git worktree add`. It stalls the FIRST add
      // only (a marker file records that it already ran), standing in for a git
      // child that never exits.
      const marker = join(root, 'hook-ran');
      const hook = join(root, '.git', 'hooks', 'post-checkout');
      writeFileSync(hook, `#!/bin/sh\nif [ ! -e '${marker}' ]; then : > '${marker}'; exec sleep 8; fi\nexit 0\n`);
      chmodSync(hook, 0o755);
      const failures: string[] = [];
      const wt = new IsolatedWorktree(root, path, branch, 'main');

      const startedAt = Date.now();
      await wt.create({ attemptTimeoutMs: 1_000, retryDelayMs: 0, onAttemptFailed: ({ error }) => { failures.push(error); } });
      const elapsedMs = Date.now() - startedAt;

      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain('did not finish within 1000ms');
      // Well under the 8s stall: the deadline, not the stalled child, ended attempt 1.
      expect(elapsedMs).toBeLessThan(6_000);
      expect(existsSync(join(path, 'shared.txt'))).toBe(true);
      expect(worktreeListed(root, path)).toBe(true);
      expect(branchExists(root, branch)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('a branch that already exists is refused up front and left untouched', async () => {
    const root = freshRepo();
    try {
      const path = join(root, '.goodvibes', '.worktrees', 'ws', 'conflict', 'second');
      const branch = 'ws/conflict/second';
      mustGit(root, ['branch', branch]);
      const before = mustGit(root, ['rev-parse', branch]).trim();
      let attemptsFailed = 0;
      const wt = new IsolatedWorktree(root, path, branch, 'main');

      await expect(wt.create({ retryDelayMs: 0, onAttemptFailed: () => { attemptsFailed += 1; } })).rejects.toThrow(/already exists/);

      expect(attemptsFailed).toBe(0);
      expect(mustGit(root, ['rev-parse', branch]).trim()).toBe(before);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('engine: an item whose worktree cannot be created fails with a named reason, never sits unspawned', () => {
  test('a lock that is never released fails that item after every attempt; its sibling still spawns', async () => {
    const root = freshRepo();
    try {
      const lockPath = holdRefLock(root, 'ws/conflict/second');
      const bus = new RuntimeEventBus();
      const spawnedFor: string[] = [];
      let counter = 0;
      const agentManager: PhaseRunnerAgentManagerLike = {
        spawn: (input) => {
          counter += 1;
          const raw = input as unknown as { task?: string; workingDirectory?: string };
          spawnedFor.push(raw.workingDirectory ?? '');
          return makeRecord({ id: `agent-${counter}`, task: raw.task ?? 'task', template: 'engineer' });
        },
        getStatus: () => null,
        cancel: () => true,
        registerCancellationSignal: () => undefined,
        releaseCancellationSignal: () => undefined,
      };
      const engine = createOrchestrationEngine({
        agentManager, configManager: makeFakeConfigManager(), runtimeBus: bus,
        projectRoot: root, persist: false, skipClaimVerification: true,
      });
      const events: OrchestrationEvent[] = [];
      engine.on((e) => events.push(e));
      const ws = engine.createWorkstream({
        id: 'ws-conflict', title: 'conflict', isolation: 'worktree',
        phases: [{ role: 'engineer', capacity: 2, kind: 'engineer', gate: { scope: 'scoped', gates: [] } }],
        items: [{ id: 'item-first', title: 'first', task: 'a' }, { id: 'item-second', title: 'second', task: 'b' }],
      });
      engine.start(ws.id);

      const deadline = Date.now() + 20_000;
      while (!events.some((e) => e.type === 'item-failed' && e.itemId === 'item-second') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const failed = events.find((e): e is Extract<OrchestrationEvent, { type: 'item-failed' }> => e.type === 'item-failed' && e.itemId === 'item-second');
      expect(failed).toBeDefined();
      expect(failed!.reason).toContain('worktree isolation setup failed');
      expect(failed!.reason).toContain('after 3 attempt(s)');

      const first = ws.items.find((i) => i.id === 'item-first')!;
      expect(spawnedFor).toEqual([first.worktreePath!]);
      // Nothing the failed attempts made is left behind.
      expect(branchExists(root, 'ws/conflict/second')).toBe(false);
      expect(existsSync(join(root, '.goodvibes', '.worktrees', 'ws', 'conflict', 'second'))).toBe(false);
      // The foreign lock is not ours and is never removed.
      expect(existsSync(lockPath)).toBe(true);
      engine.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
