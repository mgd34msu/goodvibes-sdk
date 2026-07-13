import { existsSync } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { GitService } from '../git/service.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';


/**
 * Result of committing the working tree. `hash` is the commit sha, or null when
 * there was nothing to commit (empty ledger, all paths ignored/missing, or no
 * dirty changes). `skippedIgnored` lists scoped paths that were dropped because
 * git ignores them — deliberately excluded from staging so an ignored bookkeeping
 * path in a self-reported ledger cannot fail the whole commit. Callers surface
 * this as an honest note rather than a failure.
 */
export interface CommitWorkingTreeResult {
  readonly hash: string | null;
  readonly skippedIgnored: readonly string[];
}

/**
 * AgentWorktree — Manages git worktree lifecycle for spawned agents.
 *
 * Each agent works in an isolated git worktree so its file changes are
 * sandboxed from the main working tree.
 *
 * Lifecycle:
 *   create()  — create worktree + branch, return path
 *   merge()   — merge agent branch back to current branch, remove worktree
 *   cleanup() — remove worktree without merging (cancel/error path)
 */
export class AgentWorktree {
  private readonly git: GitService;

  constructor(cwd: string) {
    this.git = new GitService(cwd);
  }

  /**
   * Create a new worktree for the given agent.
   * Returns the absolute path to the worktree directory.
   */
  async create(agentId: string): Promise<string> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.create', { agentId, worktreePath, branch });

    await this.git.worktreeAdd(worktreePath, branch);
    return worktreePath;
  }

  /**
   * Merge the agent's branch back into the current branch and remove the worktree.
   * Returns true if a merge was performed, false if no changes were found.
   */
  async merge(agentId: string): Promise<boolean> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.merge', { agentId, worktreePath, branch });

    if (!(await this._branchExists(branch))) {
      logger.debug('AgentWorktree.merge: branch missing, skipping merge', { agentId, branch });
      return false;
    }

    // Check if the agent branch has any commits beyond base
    const hasChanges = await this._hasChanges(worktreePath, branch);
    if (!hasChanges) {
      logger.debug('AgentWorktree.merge: no changes, skipping merge', { agentId });
      if (existsSync(worktreePath)) {
        await this._removeWorktree(worktreePath);
      }
      await this._deleteBranch(branch);
      return false;
    }

    // Remove worktree first (required before merging the branch)
    if (existsSync(worktreePath)) {
      await this._removeWorktree(worktreePath);
    }

    // Merge the branch
    await this.git.merge(branch);

    // Clean up the agent branch
    await this._deleteBranch(branch);

    logger.debug('AgentWorktree.merge: complete', { agentId });
    return true;
  }

  /**
   * @param paths When provided (non-empty), stage only these paths instead of sweeping the
   * whole working tree. Paths are self-reported LLM claims, not ground truth, so they are
   * filtered before staging:
   *  - a path that exists on disk (created/modified) is kept outright;
   *  - a path that does not exist is kept only if `git ls-files` shows it as tracked (a real
   *    deletion), otherwise it is a hallucinated path and dropped — `git add -A -- <path>`
   *    throws "pathspec did not match any files" for a path neither on disk nor known to git;
   *  - a path that git IGNORES (e.g. the product's own `.goodvibes/` bookkeeping written by a
   *    memory/preference tool) is dropped and reported in `skippedIgnored`. This is load-bearing:
   *    `git add -A -- <ignored>` exits non-zero ("paths are ignored") AFTER staging its valid
   *    siblings, so a single ignored path in the ledger would both fail the whole batch and
   *    leave the real deliverables staged in the user's index.
   * On any commit failure the staged paths are reset so the caller's index is never left mutated
   * by a commit that could not complete. Omit (or pass an empty array) to keep the legacy
   * `git add --all` sweep for back-compat.
   */
  async commitWorkingTree(message: string, paths?: string[]): Promise<CommitWorkingTreeResult> {
    const git = simpleGit({ baseDir: this.git.getCwd() });
    const scoped = paths && paths.length > 0 ? paths : null;
    let stagedPathspecs: string[];
    let addFlag: '-A' | '--all';
    const skippedIgnored: string[] = [];

    if (scoped) {
      const cwd = this.git.getCwd();
      const onDisk = scoped.filter((p) => existsSync(join(cwd, p)));
      const maybeDeleted = scoped.filter((p) => !onDisk.includes(p));
      let trackedDeleted: string[] = [];
      if (maybeDeleted.length > 0) {
        const tracked: string = await git.raw(['ls-files', '--', ...maybeDeleted]);
        const trackedSet = new Set(tracked.split('\n').map((line: string) => line.trim()).filter(Boolean));
        trackedDeleted = maybeDeleted.filter((p) => trackedSet.has(p));
      }
      const existingPaths = [...onDisk, ...trackedDeleted];
      // checkIgnore returns the subset git ignores; it returns [] (does NOT throw) when nothing
      // is ignored, so it is safe to call unconditionally on the whole candidate set.
      const ignored = existingPaths.length > 0 ? await git.checkIgnore(existingPaths) : [];
      const ignoredSet = new Set(ignored);
      const stageable = existingPaths.filter((p) => !ignoredSet.has(p));
      skippedIgnored.push(...existingPaths.filter((p) => ignoredSet.has(p)));
      if (skippedIgnored.length > 0) {
        logger.debug('AgentWorktree.commitWorkingTree: dropping gitignored scoped paths before staging', {
          skippedIgnored,
        });
      }
      if (stageable.length === 0) {
        logger.debug('AgentWorktree.commitWorkingTree: no committable scoped paths after filtering (missing/ignored)', {
          claimedPaths: scoped,
          skippedIgnored,
        });
        return { hash: null, skippedIgnored };
      }
      // -A (not plain add) scoped to just these pathspecs so confirmed deletions are staged
      // too (plain `git add <path>` silently no-ops on a path that no longer exists on disk).
      stagedPathspecs = stageable;
      addFlag = '-A';
    } else {
      const status = await git.raw([
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        '.',
        ':(exclude).goodvibes',
        ':(exclude).goodvibes/**',
      ]);
      if (status.trim().length === 0) {
        logger.debug('AgentWorktree.commitWorkingTree: no direct working tree changes');
        return { hash: null, skippedIgnored };
      }
      stagedPathspecs = ['.', ':(exclude).goodvibes', ':(exclude).goodvibes/**'];
      addFlag = '--all';
    }

    try {
      await git.raw(['add', addFlag, '--', ...stagedPathspecs]);
      const result = await this.git.commit(message, {
        fallbackIdentity: { name: 'GoodVibes', email: 'goodvibes@local' },
      });
      if (result.hash) {
        logger.debug('AgentWorktree.commitWorkingTree: committed direct working tree changes', {
          hash: result.hash,
          skippedIgnored,
        });
        return { hash: result.hash, skippedIgnored };
      }
      // simple-git RESOLVES a rejected commit (e.g. a failing pre-commit hook) with an empty hash
      // rather than throwing. Distinguish that from a genuine no-op: if changes are still staged,
      // a hook/verification step rejected the commit — throw so the catch below restores the index
      // and the caller can report an honest warning. If nothing is staged, it was a true no-op.
      const stagedAfter = (await git.raw(['diff', '--cached', '--name-only'])).trim();
      if (stagedAfter.length > 0) {
        throw new Error('git created no commit despite staged changes (a pre-commit hook or verification step likely rejected the commit)');
      }
      logger.debug('AgentWorktree.commitWorkingTree: no committable changes after staging');
      return { hash: null, skippedIgnored };
    } catch (error) {
      const reason = summarizeError(error).toLowerCase();
      if (reason.includes('nothing to commit') || reason.includes('no changes added to commit')) {
        logger.debug('AgentWorktree.commitWorkingTree: no committable changes after staging');
        return { hash: null, skippedIgnored };
      }
      // Any other failure (rejected add, rejected commit, hook/identity/disk error) must not leave
      // the caller's staging area mutated by a commit we could not complete — restore what we staged.
      await this._restoreIndex(git, stagedPathspecs);
      throw error;
    }
  }

  /**
   * Unstage the given pathspecs after a failed commit so the caller's index is returned to its
   * pre-commit state. `git reset -- <pathspecs>` is safe on a repo with no HEAD yet (a brand-new
   * repo whose first commit was the one that just failed). Best-effort: a reset failure is logged,
   * not thrown, so it never masks the original commit error the caller needs to see.
   */
  private async _restoreIndex(git: ReturnType<typeof simpleGit>, pathspecs: string[]): Promise<void> {
    try {
      await git.raw(['reset', '--', ...pathspecs]);
      logger.debug('AgentWorktree.commitWorkingTree: restored index after failed commit', { pathspecs });
    } catch (err) {
      logger.warn('AgentWorktree.commitWorkingTree: index restore after failed commit did not complete', {
        error: summarizeError(err),
      });
    }
  }

  async currentHead(): Promise<string | null> {
    try {
      const git = simpleGit({ baseDir: this.git.getCwd() });
      return (await git.raw(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      logger.warn('AgentWorktree.currentHead failed', { error: summarizeError(error) });
      return null;
    }
  }

  /**
   * Remove the worktree without merging (cancel/error path).
   */
  async cleanup(agentId: string): Promise<void> {
    const worktreePath = this._worktreePath(agentId);
    const branch = this._branchName(agentId);

    logger.debug('AgentWorktree.cleanup', { agentId, worktreePath });

    if (existsSync(worktreePath)) {
      await this._removeWorktree(worktreePath);
    }

    await this._deleteBranch(branch).catch(() => {
      // Branch may not exist if create() never completed
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _worktreePath(agentId: string): string {
    return join(this.git.getCwd(), '.goodvibes', '.worktrees', `agent-${agentId}`);
  }

  private _branchName(agentId: string): string {
    return `agent/${agentId}`;
  }

  /**
   * Check whether the agent branch has any commits that differ from
   * the current branch (the main working tree HEAD).
   */
  private async _hasChanges(worktreePath: string, branch: string): Promise<boolean> {
    try {
      // Use a simple-git instance pointed at the worktree to check status
      const wgit = simpleGit({ baseDir: this.git.getCwd() });
      // Count commits on the branch that aren't on the current branch
      const result = await wgit.raw(['rev-list', '--count', `HEAD..${branch}`]);
      const count = parseInt(result.trim(), 10);
      return count > 0;
    } catch (err) {
      // If rev-list fails (e.g. brand-new worktree with no commits), treat as no changes
      logger.warn('AgentWorktree._hasChanges: rev-list failed, treating as no changes', { branch, worktreeDir: worktreePath, error: summarizeError(err) });
      return false;
    }
  }

  private async _branchExists(branch: string): Promise<boolean> {
    try {
      const wgit = simpleGit({ baseDir: this.git.getCwd() });
      await wgit.raw(['rev-parse', '--verify', '--quiet', branch]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Force-remove a worktree directory.
   */
  private async _removeWorktree(worktreePath: string): Promise<void> {
    try {
      await this.git.worktreeRemove(worktreePath);
    } catch (err) {
      // Try with --force flag via raw if normal remove fails
      logger.debug('AgentWorktree._removeWorktree: first attempt failed, retrying with --force', { worktreePath, error: summarizeError(err) });
      try {
        const wgit = simpleGit({ baseDir: this.git.getCwd() });
        await wgit.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch (err) {
        logger.error('AgentWorktree._removeWorktree failed', { worktreePath, error: summarizeError(err) });
        throw err;
      }
    }
  }

  /**
   * Delete a branch (no-op if it doesn't exist).
   */
  private async _deleteBranch(branch: string): Promise<void> {
    try {
      const wgit = simpleGit({ baseDir: this.git.getCwd() });
      await wgit.raw(['branch', '-D', branch]);
    } catch (err) {
      logger.warn('AgentWorktree._deleteBranch failed during cleanup', { branch, error: summarizeError(err) });
    }
  }
}

/** Outcome of integrating an item branch back into the base branch (see IsolatedWorktree.integrate). */
export type IntegrationOutcome =
  /** Clean merge — `hash` is the merge commit on the base branch. */
  | { readonly status: 'merged'; readonly hash: string }
  /** The base merge conflicted; `files` names the conflicting paths. The base tree is restored (merge --abort) so the lane can continue. */
  | { readonly status: 'conflict'; readonly files: readonly string[] }
  /** The item branch carried no commits beyond base — nothing to merge (an honest no-op, not a failure). */
  | { readonly status: 'empty' };

/**
 * IsolatedWorktree — one work item's dedicated git worktree for the
 * orchestration engine's `worktree` isolation mode (see WorkstreamIsolation).
 *
 * Unlike {@link AgentWorktree} (whose merge() folds an agent branch into the
 * SAME working tree's current branch and is used today only for its
 * commitWorkingTree surface), an IsolatedWorktree models the full per-item
 * lifecycle the engine drives:
 *
 *   create()    — add a git worktree at `path` on a fresh branch `branch`,
 *                 branched from the base branch (the root tree's current HEAD).
 *   commit()    — scoped-commit the item's touched paths onto `branch`, INSIDE
 *                 the worktree (delegates to AgentWorktree.commitWorkingTree
 *                 bound to `path`, so the ignored/hallucinated/deletion
 *                 filtering is reused verbatim).
 *   isClean()   — whether the worktree's working tree has uncommitted changes
 *                 (drives the fail/kill cleanup rule: remove only if clean).
 *   integrate() — merge `branch` into the base branch IN THE ROOT TREE. The
 *                 root tree stays checked out on base; a different branch being
 *                 merged never needs the worktree removed first. On conflict it
 *                 runs `merge --abort` to restore the root index so the single
 *                 sequential integration lane can proceed to the next item.
 *   remove()    — remove the worktree dir and delete `branch` (post-merge, or
 *                 a clean tree after fail/kill).
 *   keepInPlace()/branchHasCommits() — inspection helpers for KEPT worktrees.
 *
 * Location: worktrees live under `<root>/.goodvibes/.worktrees/`, the same
 * gitignored bookkeeping area AgentWorktree and WorktreeRegistry already use —
 * chosen over the system temp dir deliberately: (1) crash cleanup — a worktree
 * under the repo is discoverable by `git worktree list` and the existing
 * WorktreeRegistry path scan, so an orphan left by a crashed process can be
 * reconciled; a temp-dir worktree is invisible to repo-relative reconciliation
 * and can be swept out from under a KEPT (dirty) tree by an OS temp cleaner,
 * losing data. (2) gitignore interplay — `.goodvibes/` is already ignored and
 * the commit path already excludes it, so a nested worktree checkout there
 * never pollutes the parent's tracked status nor gets accidentally committed.
 */
export class IsolatedWorktree {
  readonly path: string;
  readonly branch: string;
  private readonly rootGit: GitService;
  private readonly baseBranch: string;

  /**
   * @param rootDir     the repository root (base tree) — merges land here.
   * @param path        absolute path for this item's worktree directory.
   * @param branch      the item branch name to create/check out in the worktree.
   * @param baseBranch  the branch merges integrate into (the root tree's branch).
   */
  constructor(rootDir: string, path: string, branch: string, baseBranch: string) {
    this.path = path;
    this.branch = branch;
    this.baseBranch = baseBranch;
    this.rootGit = new GitService(rootDir);
  }

  /** Add the worktree on a fresh `branch` branched from base (the root tree's current HEAD). */
  async create(): Promise<void> {
    logger.debug('IsolatedWorktree.create', { path: this.path, branch: this.branch });
    await this.rootGit.worktreeAdd(this.path, this.branch);
  }

  /**
   * Scoped-commit the item's touched paths onto the item branch, inside the
   * worktree. Reuses AgentWorktree.commitWorkingTree (bound to the worktree
   * path) so the ignored/hallucinated/confirmed-deletion filtering is identical
   * to shared mode. A fresh worktree starts clean, so in worktree mode the
   * launch-dirty snapshot is per-worktree and trivially empty (see the engine).
   */
  async commit(message: string, paths?: string[]): Promise<CommitWorkingTreeResult> {
    return new AgentWorktree(this.path).commitWorkingTree(message, paths);
  }

  /** HEAD of the item branch (inside the worktree), or null if it can't be read. */
  async currentHead(): Promise<string | null> {
    try {
      const wgit = simpleGit({ baseDir: this.path });
      return (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
      logger.warn('IsolatedWorktree.currentHead failed', { path: this.path, error: summarizeError(error) });
      return null;
    }
  }

  /** True when the worktree has NO uncommitted changes (clean tree). Missing dir ⇒ treated as clean. */
  async isClean(): Promise<boolean> {
    if (!existsSync(this.path)) return true;
    try {
      const wgit = simpleGit({ baseDir: this.path });
      const status = (await wgit.raw(['status', '--porcelain'])).trim();
      return status.length === 0;
    } catch (error) {
      // If we can't read status, treat as DIRTY (keep the tree) — data safety.
      logger.warn('IsolatedWorktree.isClean: status failed, treating as dirty', { path: this.path, error: summarizeError(error) });
      return false;
    }
  }

  /** True when the item branch carries at least one commit beyond the base branch. */
  async branchHasCommits(): Promise<boolean> {
    try {
      const wgit = simpleGit({ baseDir: this.rootGit.getCwd() });
      const count = parseInt((await wgit.raw(['rev-list', '--count', `${this.baseBranch}..${this.branch}`])).trim(), 10);
      return Number.isFinite(count) && count > 0;
    } catch (error) {
      logger.warn('IsolatedWorktree.branchHasCommits: rev-list failed, treating as no commits', { branch: this.branch, error: summarizeError(error) });
      return false;
    }
  }

  /**
   * Merge the item branch into the base branch in the ROOT tree. Returns an
   * honest {@link IntegrationOutcome}: `merged` (with the merge commit hash),
   * `conflict` (with the conflicting files — the merge is aborted so the root
   * is restored and the lane can continue), or `empty` (no commits to merge).
   * Never auto-resolves a conflict.
   */
  async integrate(): Promise<IntegrationOutcome> {
    if (!(await this.branchHasCommits())) {
      logger.debug('IsolatedWorktree.integrate: branch has no commits beyond base, nothing to merge', { branch: this.branch });
      return { status: 'empty' };
    }
    const wgit = simpleGit({ baseDir: this.rootGit.getCwd() });
    const before = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    const result = await this.rootGit.merge(this.branch);
    if (result.success) {
      const hash = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
      // A fast-forward or an already-merged branch can leave HEAD unmoved; a
      // fresh merge commit moves it. Either way the branch content is now in
      // base — report the current base HEAD as the integration point.
      logger.debug('IsolatedWorktree.integrate: merged', { branch: this.branch, before, hash });
      return { status: 'merged', hash };
    }
    // Conflict — restore the root tree so the sequential lane can continue.
    const files = [...(result.conflicts ?? [])];
    try {
      await wgit.raw(['merge', '--abort']);
    } catch (err) {
      logger.warn('IsolatedWorktree.integrate: merge --abort did not complete after conflict', { branch: this.branch, error: summarizeError(err) });
    }
    logger.debug('IsolatedWorktree.integrate: conflict, base restored', { branch: this.branch, files });
    return { status: 'conflict', files };
  }

  /**
   * The diff this item branch introduced over the base branch (base...branch —
   * changes on the branch since it diverged). The existing diff plumbing behind
   * a best-of-N candidate: returns the changed files, the unified diff text, and
   * the diffstat. A read error degrades to an empty diff, never throws.
   */
  async diff(): Promise<{ files: string[]; unifiedDiff: string; stat: string }> {
    const range = `${this.baseBranch}...${this.branch}`;
    try {
      const wgit = simpleGit({ baseDir: this.rootGit.getCwd() });
      const names = (await wgit.raw(['diff', '--name-only', range])).trim();
      const files = names.length > 0 ? names.split('\n').filter(Boolean) : [];
      const unifiedDiff = await wgit.raw(['diff', range]);
      const stat = (await wgit.raw(['diff', '--stat', range])).trim();
      return { files, unifiedDiff, stat };
    } catch (error) {
      logger.warn('IsolatedWorktree.diff: could not compute branch diff', { branch: this.branch, error: summarizeError(error) });
      return { files: [], unifiedDiff: '', stat: '' };
    }
  }

  /** Remove the worktree directory and delete the item branch (post-merge, or a clean tree after fail/kill). */
  async remove(): Promise<void> {
    logger.debug('IsolatedWorktree.remove', { path: this.path, branch: this.branch });
    await this.removeDirectory();
    try {
      const wgit = simpleGit({ baseDir: this.rootGit.getCwd() });
      await wgit.raw(['branch', '-D', this.branch]);
    } catch (err) {
      logger.warn('IsolatedWorktree.remove: branch delete did not complete', { branch: this.branch, error: summarizeError(err) });
    }
  }

  /**
   * Evict this worktree under the kept-worktree cap. Eviction bounds DISK
   * usage, never work: any uncommitted state (modified AND untracked files,
   * unfiltered — preservation must be exact) is first committed onto the item
   * branch, then ONLY the directory is removed. The branch is deliberately
   * KEPT, so a conflicted/dirty tree evicted past the cap stays recoverable
   * with `git worktree add <path> <branch>` / `git show <branch>:<file>`.
   *
   * When the preservation commit cannot be created, the directory is NOT
   * removed (the error propagates) — leaving an over-cap directory on disk is
   * always preferred over destroying uncommitted work.
   *
   * @returns the preservation commit hash, or null when the tree was already
   *          clean (nothing needed preserving).
   */
  async evict(): Promise<{ preservedCommit: string | null }> {
    logger.debug('IsolatedWorktree.evict', { path: this.path, branch: this.branch });
    let preservedCommit: string | null = null;
    if (existsSync(this.path) && !(await this.isClean())) {
      const wgit = simpleGit({ baseDir: this.path });
      await wgit.raw(['add', '-A']);
      const message = 'preserve uncommitted work at kept-cap eviction';
      try {
        await wgit.raw(['commit', '--no-verify', '-m', message]);
      } catch (err) {
        // Most common cause: no committer identity configured in this
        // environment. Preservation must not depend on host config — retry
        // with an explicit fallback identity rather than lose the tree.
        logger.debug('IsolatedWorktree.evict: commit failed, retrying with fallback identity', { path: this.path, error: summarizeError(err) });
        await wgit.raw(['-c', 'user.email=goodvibes@localhost', '-c', 'user.name=goodvibes-eviction', 'commit', '--no-verify', '-m', message]);
      }
      preservedCommit = (await wgit.raw(['rev-parse', 'HEAD'])).trim();
    }
    await this.removeDirectory();
    // The branch is KEPT deliberately — no `branch -D` on the eviction path.
    return { preservedCommit };
  }

  /** Remove the worktree directory (plain remove, then a --force retry). */
  private async removeDirectory(): Promise<void> {
    if (!existsSync(this.path)) return;
    try {
      await this.rootGit.worktreeRemove(this.path);
    } catch (err) {
      logger.debug('IsolatedWorktree.removeDirectory: first attempt failed, retrying with --force', { path: this.path, error: summarizeError(err) });
      const wgit = simpleGit({ baseDir: this.rootGit.getCwd() });
      await wgit.raw(['worktree', 'remove', '--force', this.path]);
    }
  }
}
