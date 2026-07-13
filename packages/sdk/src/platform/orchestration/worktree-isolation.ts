/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * WorktreeIsolationManager — the engine-side driver for `worktree` isolation
 * mode (see WorkstreamIsolation, types.ts, and IsolatedWorktree, worktree.ts).
 *
 * Owns three things the engine calls into at well-defined lifecycle points:
 *
 *   ensureWorktree()      — at an item's FIRST claim (engine.ts runItemPhase),
 *                           create its dedicated worktree if it doesn't have
 *                           one yet. Idempotent across an item's phases (a
 *                           worktree persists for the item's whole run).
 *   enqueueIntegration()  — when a passed item's pipeline terminates, queue its
 *                           branch onto the SINGLE sequential integration lane
 *                           (completion order, not claim order). A conflict
 *                           keeps the worktree + branch and lets the lane
 *                           continue with the next item — never auto-resolved,
 *                           never silently dropped.
 *   cleanupTerminated()   — when an item fails or is killed, remove its
 *                           worktree ONLY if the tree is clean; a dirty tree
 *                           is KEPT (data safety) and counted against the
 *                           kept-worktree cap (oldest-first eviction).
 *   reconcileOrphans()    — at import (a resumed/crashed workstream), find any
 *                           on-disk `ws/<wsShort>/*` worktree not already
 *                           recorded on one of the imported items and either
 *                           ADOPT it (the item still has unresolved work) or
 *                           REPORT it (leave in place for the operator — NEVER
 *                           deleted on sight).
 *
 * Location + naming: worktrees live under
 * `<projectRoot>/.goodvibes/.worktrees/ws/<wsShort>/<itemShort>` on branch
 * `ws/<wsShort>/<itemShort>` — deterministic from (workstreamId, itemId), so
 * `ensureWorktree` and `reconcileOrphans` agree on where a given item's
 * worktree lives without any extra bookkeeping.
 *
 * SYNCHRONOUS orphan scan (deliberate — mirrors dirty-guard.ts's
 * snapshotDirtyTree precedent): `reconcileOrphans` must resolve BEFORE the
 * engine's first tick() can claim any item, or a claim could race the async
 * git listing and create a second worktree at the same deterministic path an
 * orphan already occupies (`git worktree add` on an existing path throws).
 * importWorkstream (engine.ts) is itself a synchronous function, so
 * reconciliation is done with Bun.spawnSync, paid once per import, exactly
 * like the launch-dirty snapshot.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GitService } from '../git/service.js';
import { IsolatedWorktree, type CommitWorkingTreeResult } from '../agents/worktree.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { OrchestrationEvent, WorkItem, Workstream } from './types.js';

export interface WorktreeIsolationManagerDeps {
  readonly projectRoot: string;
  readonly emit: (event: OrchestrationEvent) => void;
  readonly now?: (() => number) | undefined;
  /** Bounds how many KEPT (conflict/dirty) worktrees are retained before oldest-first eviction. Default 20. */
  readonly keptWorktreeCap?: number | undefined;
  /**
   * Cold-start setup hook run once, right after a worktree is first created, so
   * an isolated agent starts with dependencies installed and carried-over
   * untracked files present instead of broken-by-default. The wiring is
   * responsible for capturing/recording the honest outcome (e.g. onto the
   * worktree registry record); a thrown/rejected setup NEVER fails worktree
   * creation — a broken setup is surfaced as a visible state, not a lost
   * worktree. Absent → today's behavior (no provisioning).
   */
  readonly runSetup?: ((worktreePath: string) => Promise<void> | void) | undefined;
}

export interface ItemWorktreeHandle {
  readonly path: string;
  commit(message: string, paths?: string[]): Promise<CommitWorkingTreeResult>;
}

export interface WorktreeIsolationManager {
  /** Ensure this item has a dedicated worktree (idempotent — created once, at first claim). Only meaningful when workstream.isolation === 'worktree'. */
  ensureWorktree(workstream: Workstream, item: WorkItem): Promise<ItemWorktreeHandle>;
  /**
   * Enqueue a just-passed item's branch onto the sequential integration lane.
   * Resolves once THIS item's attempt (merged/conflict/empty) and any
   * resulting cleanup has settled. Callers that don't need to wait may let
   * the returned promise run fire-and-forget (errors are caught internally —
   * this never rejects).
   */
  enqueueIntegration(workstream: Workstream, item: WorkItem): Promise<void>;
  /** Fail/kill cleanup rule: remove the item's worktree if clean, else KEEP it (data safety). No-op if the item never got a worktree. Never throws. */
  cleanupTerminated(workstream: Workstream, item: WorkItem): Promise<void>;
  /** Synchronous orphan scan — see the module doc. Call once, right after registering an imported workstream, before start()/tick(). */
  reconcileOrphans(workstream: Workstream): void;
  /**
   * The diff an item's worktree branch introduced over base (best-of-N candidate
   * diff). Returns null when the item has no live worktree instance (e.g. already
   * cleaned, or never claimed). Never throws.
   */
  diffItem(item: WorkItem): Promise<{ files: string[]; unifiedDiff: string; stat: string } | null>;
}

/** Derives a short, filesystem/branch-safe fragment from an id: the suffix after the last '-' when it's plain alphanumerics, else a stable short hash of the whole id (caller-supplied WorkItemSpec.id can be arbitrary text). */
function shortId(id: string): string {
  const dash = id.lastIndexOf('-');
  const candidate = dash >= 0 ? id.slice(dash + 1) : id;
  if (candidate.length > 0 && /^[A-Za-z0-9]+$/.test(candidate)) return candidate;
  return createHash('sha1').update(id).digest('hex').slice(0, 8);
}

export function itemWorktreeBranch(workstreamId: string, itemId: string): string {
  return `ws/${shortId(workstreamId)}/${shortId(itemId)}`;
}

function itemWorktreeDir(projectRoot: string, workstreamId: string, itemId: string): string {
  return join(projectRoot, '.goodvibes', '.worktrees', 'ws', shortId(workstreamId), shortId(itemId));
}

interface KeptEntry {
  readonly workstream: Workstream;
  readonly item: WorkItem;
  readonly instance: IsolatedWorktree;
  readonly keptAt: number;
}

export function createWorktreeIsolationManager(deps: WorktreeIsolationManagerDeps): WorktreeIsolationManager {
  const now = deps.now ?? ((): number => Date.now());
  const keptCap = deps.keptWorktreeCap ?? 20;
  const rootGit = new GitService(deps.projectRoot);
  const instances = new Map<string, IsolatedWorktree>(); // itemId -> instance
  const kept: KeptEntry[] = [];
  let baseBranchCache: string | null = null;
  let integrationLane: Promise<void> = Promise.resolve();

  /** Resolved once (Bun.spawnSync, mirroring dirty-guard.ts) since every IsolatedWorktree for this manager's lifetime merges into the SAME root-tree branch. */
  function resolveBaseBranch(): string {
    if (baseBranchCache) return baseBranchCache;
    try {
      const result = Bun.spawnSync(['git', '-C', deps.projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : '';
      baseBranchCache = branch.length > 0 && branch !== 'HEAD' ? branch : 'main';
    } catch (error) {
      logger.warn('worktree-isolation: could not resolve base branch, defaulting to "main"', { error: summarizeError(error) });
      baseBranchCache = 'main';
    }
    return baseBranchCache;
  }

  function getOrCreateInstance(workstream: Workstream, item: WorkItem, path: string, branch: string): IsolatedWorktree {
    let instance = instances.get(item.id);
    if (!instance) {
      instance = new IsolatedWorktree(deps.projectRoot, path, branch, resolveBaseBranch());
      instances.set(item.id, instance);
    }
    return instance;
  }

  async function ensureWorktree(workstream: Workstream, item: WorkItem): Promise<ItemWorktreeHandle> {
    const path = item.worktreePath ?? itemWorktreeDir(deps.projectRoot, workstream.id, item.id);
    const branch = item.worktreeBranch ?? itemWorktreeBranch(workstream.id, item.id);
    const instance = getOrCreateInstance(workstream, item, path, branch);
    if (!item.worktreePath) {
      await instance.create();
      item.worktreePath = instance.path;
      item.worktreeBranch = instance.branch;
      deps.emit({ type: 'item-worktree-created', workstreamId: workstream.id, itemId: item.id, path: instance.path, branch: instance.branch });
      // Cold-start setup: install deps, run codegen, carry over untracked
      // files. Never fails worktree creation — the wiring records the honest
      // outcome (including a failure) as a visible worktree state.
      if (deps.runSetup) {
        try {
          await deps.runSetup(instance.path);
        } catch (error) {
          logger.warn('worktree-isolation: cold-start setup hook threw (worktree kept; failure recorded by the setup wiring)', {
            itemId: item.id, path: instance.path, error: summarizeError(error),
          });
        }
      }
    }
    return { path: instance.path, commit: (message, paths) => instance.commit(message, paths) };
  }

  function keepWorktree(workstream: Workstream, item: WorkItem, instance: IsolatedWorktree, reason: string): void {
    item.worktreeKept = true;
    deps.emit({ type: 'item-worktree-kept', workstreamId: workstream.id, itemId: item.id, path: instance.path, reason });
    kept.push({ workstream, item, instance, keptAt: now() });
    enforceKeptCap();
  }

  function enforceKeptCap(): void {
    while (kept.length > keptCap) {
      const oldest = kept.shift();
      if (!oldest) break;
      void removeWorktree(oldest.workstream, oldest.item, oldest.instance, true).catch((error) => {
        logger.error('worktree-isolation: eviction of oldest kept worktree did not complete', {
          itemId: oldest.item.id, error: summarizeError(error),
        });
      });
    }
  }

  async function removeWorktree(workstream: Workstream, item: WorkItem, instance: IsolatedWorktree, evicted: boolean): Promise<void> {
    const path = instance.path;
    let preservedCommit: string | null = null;
    if (evicted) {
      // Cap eviction never destroys work: uncommitted state is committed onto
      // the item branch first, only the directory is removed, and the branch
      // is KEPT (see IsolatedWorktree.evict). If preservation fails, the
      // directory is left in place — an over-cap directory beats lost work —
      // and the tree stays kept/attributed rather than falsely announced gone.
      try {
        preservedCommit = (await instance.evict()).preservedCommit;
      } catch (error) {
        logger.error('worktree-isolation: eviction preservation failed; worktree left on disk', {
          itemId: item.id, path, branch: instance.branch, error: summarizeError(error),
        });
        return;
      }
    } else {
      try {
        await instance.remove();
      } catch (error) {
        logger.warn('worktree-isolation: worktree removal did not complete', { itemId: item.id, path, error: summarizeError(error) });
      }
    }
    instances.delete(item.id);
    item.worktreePath = undefined;
    item.worktreeKept = false;
    deps.emit(
      evicted
        ? {
            type: 'item-worktree-evicted', workstreamId: workstream.id, itemId: item.id, path,
            branch: instance.branch, ...(preservedCommit ? { preservedCommit } : {}),
          }
        : { type: 'item-worktree-removed', workstreamId: workstream.id, itemId: item.id, path },
    );
  }

  async function integrateOne(workstream: Workstream, item: WorkItem): Promise<void> {
    const path = item.worktreePath ?? itemWorktreeDir(deps.projectRoot, workstream.id, item.id);
    const branch = item.worktreeBranch ?? itemWorktreeBranch(workstream.id, item.id);
    const instance = getOrCreateInstance(workstream, item, path, branch);
    item.mergeState = 'pending';
    try {
      const outcome = await instance.integrate();
      if (outcome.status === 'merged') {
        item.mergeState = 'merged';
        item.mergeHash = outcome.hash;
        deps.emit({ type: 'item-merged', workstreamId: workstream.id, itemId: item.id, branch: instance.branch, hash: outcome.hash });
        await removeWorktree(workstream, item, instance, false);
        return;
      }
      if (outcome.status === 'conflict') {
        item.mergeState = 'conflict';
        item.blockedReason = `merge-conflict: ${outcome.files.join(', ') || 'unknown files'}`;
        deps.emit({
          type: 'item-merge-conflict', workstreamId: workstream.id, itemId: item.id,
          branch: instance.branch, path: instance.path, files: outcome.files,
        });
        keepWorktree(workstream, item, instance, `merge-conflict: ${outcome.files.join(', ') || 'unknown files'}`);
        return;
      }
      // 'empty' — the item branch carries no commits beyond base: an honest
      // no-op, not a failure. Nothing to merge, so trivially "merged" (no
      // hash — there is no merge commit to report) and the worktree is
      // reclaimed like any other successfully-integrated item.
      item.mergeState = 'merged';
      await removeWorktree(workstream, item, instance, false);
    } catch (error) {
      logger.error('worktree-isolation: integration attempt threw', { itemId: item.id, error: summarizeError(error) });
      item.mergeState = 'conflict';
      item.blockedReason = `merge-conflict: integration did not complete (${summarizeError(error)})`;
      keepWorktree(workstream, item, instance, `integration attempt threw: ${summarizeError(error)}`);
    }
  }

  function enqueueIntegration(workstream: Workstream, item: WorkItem): Promise<void> {
    const run = integrationLane.then(() => integrateOne(workstream, item));
    // Chain off a NEVER-REJECTING tail so one item's (already internally
    // caught) failure can't skip the lane forward for the next enqueue —
    // integrateOne never actually throws past its own try/catch, but this is
    // cheap insurance against a future change forgetting that invariant.
    integrationLane = run.catch((error) => {
      logger.error('worktree-isolation: integration lane step did not complete', { itemId: item.id, error: summarizeError(error) });
    });
    return run;
  }

  async function cleanupTerminated(workstream: Workstream, item: WorkItem): Promise<void> {
    const instance = instances.get(item.id);
    if (!instance) return; // never got a worktree (failed before claim, or shared mode)
    try {
      const clean = await instance.isClean();
      if (clean) {
        await removeWorktree(workstream, item, instance, false);
      } else {
        keepWorktree(workstream, item, instance, 'dirty tree after item failed/killed');
      }
    } catch (error) {
      logger.error('worktree-isolation: cleanup-on-terminate check did not complete, keeping worktree for safety', {
        itemId: item.id, error: summarizeError(error),
      });
      keepWorktree(workstream, item, instance, `cleanup check did not complete: ${summarizeError(error)}`);
    }
  }

  function reconcileOrphans(workstream: Workstream): void {
    let raw: string;
    try {
      const result = Bun.spawnSync(['git', '-C', deps.projectRoot, 'worktree', 'list', '--porcelain']);
      if (result.exitCode !== 0) return;
      raw = new TextDecoder().decode(result.stdout);
    } catch (error) {
      logger.warn('worktree-isolation: orphan scan (worktree list) did not complete', { error: summarizeError(error) });
      return;
    }
    const prefix = `ws/${shortId(workstream.id)}/`;
    const knownPaths = new Set(
      workstream.items.map((i) => i.worktreePath).filter((p): p is string => typeof p === 'string' && p.length > 0),
    );
    for (const block of raw.trim().split('\n\n').filter(Boolean)) {
      const lines = block.split('\n');
      const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? '';
      const branchLine = lines.find((l) => l.startsWith('branch '));
      const branch = branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : '';
      if (!path || !branch.startsWith(prefix)) continue;
      if (knownPaths.has(path)) continue; // already tracked by an item's recorded worktreePath — not an orphan
      const itemShort = branch.slice(prefix.length);
      const item = workstream.items.find((i) => shortId(i.id) === itemShort);
      const unresolved = !!item && (
        (item.state !== 'passed' && item.state !== 'failed')
        || item.mergeState === 'pending'
      );
      if (item && unresolved) {
        item.worktreePath = path;
        item.worktreeBranch = branch;
        instances.set(item.id, new IsolatedWorktree(deps.projectRoot, path, branch, resolveBaseBranch()));
        deps.emit({ type: 'orphan-worktree-reconciled', workstreamId: workstream.id, path, branch, disposition: 'adopted' });
      } else {
        deps.emit({ type: 'orphan-worktree-reconciled', workstreamId: workstream.id, path, branch, disposition: 'reported' });
      }
    }
  }

  async function diffItem(item: WorkItem): Promise<{ files: string[]; unifiedDiff: string; stat: string } | null> {
    const instance = instances.get(item.id);
    if (!instance) return null;
    return instance.diff();
  }

  return { ensureWorktree, enqueueIntegration, cleanupTerminated, reconcileOrphans, diffItem };
}
