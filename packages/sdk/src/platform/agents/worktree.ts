import { existsSync } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { GitService } from '../git/service.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';


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
   * filtered before staging: a path that exists on disk (created/modified) is kept outright;
   * a path that does not exist is kept only if `git ls-files` shows it as tracked (a real
   * deletion), otherwise it is a hallucinated path and dropped. This matters because
   * `git add -A -- <path>` throws "pathspec did not match any files" for a path that is
   * neither on disk nor known to git — a single bad claim must not fail the whole batch.
   * Omit (or pass an empty array) to keep the legacy `git add --all` sweep for back-compat.
   */
  async commitWorkingTree(message: string, paths?: string[]): Promise<string | null> {
    const git = simpleGit({ baseDir: this.git.getCwd() });
    const scoped = paths && paths.length > 0 ? paths : null;

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
      if (existingPaths.length === 0) {
        logger.debug('AgentWorktree.commitWorkingTree: no scoped paths exist on disk or in the index, nothing to stage', {
          claimedPaths: scoped,
        });
        return null;
      }
      // -A (not plain add) scoped to just these pathspecs so confirmed deletions are staged
      // too (plain `git add <path>` silently no-ops on a path that no longer exists on disk).
      await git.raw(['add', '-A', '--', ...existingPaths]);
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
        return null;
      }
      await git.raw(['add', '--all', '--', '.', ':(exclude).goodvibes', ':(exclude).goodvibes/**']);
    }

    try {
      const result = await this.git.commit(message, {
        fallbackIdentity: { name: 'GoodVibes', email: 'goodvibes@local' },
      });
      logger.debug('AgentWorktree.commitWorkingTree: committed direct working tree changes', {
        hash: result.hash,
      });
      return result.hash;
    } catch (error) {
      const message = summarizeError(error).toLowerCase();
      if (message.includes('nothing to commit') || message.includes('no changes added to commit')) {
        logger.debug('AgentWorktree.commitWorkingTree: no committable changes after staging');
        return null;
      }
      throw error;
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
