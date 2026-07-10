/**
 * workspace/registration/worktree-link.ts
 *
 * The impure worktree→main-repo LINK probe. A linked git worktree records its
 * main repository in its own `.git` file, and `git rev-parse --git-common-dir`
 * resolves to that main repo's shared `.git` directory regardless of where the
 * worktree lives on disk. This is exactly the link registration inheritance must
 * follow — an orchestration-spawned worktree can sit outside the registered
 * project's subtree yet still belong to it — so we derive the MAIN worktree root
 * from the common dir rather than from path ancestry.
 *
 * Kept isolated (and behind an injectable runner) so the resolver and store stay
 * pure/testable and only this file shells out.
 */

import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { normalizeWorkspaceRoot } from './resolution.js';
import type { WorkspaceGitMetadata } from './types.js';

/** Runs one `git -C <cwd> <args>` and returns trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: readonly string[]) => string | null;

const defaultGitRunner: GitRunner = (cwd, args) => {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * Probe the worktree→main-repo link for `path`. Returns `mainWorktreeRoot` only
 * when `path` is a LINKED worktree whose main repo lives elsewhere; returns an
 * empty object for the main worktree, a non-worktree directory, or a
 * non-repo/bare-repo path.
 */
export function probeWorktreeLink(path: string, runGit: GitRunner = defaultGitRunner): WorkspaceGitMetadata {
  const commonDir = runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return {};

  // The main worktree root is the parent of the shared `.git` directory. A bare
  // repo's common dir is not a `.git` directory, so there is no main worktree to
  // inherit from — report nothing rather than guessing.
  if (basename(commonDir) !== '.git') return {};
  const mainRoot = normalizeWorkspaceRoot(dirname(commonDir));

  const topLevel = runGit(path, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
  // Only a LINKED worktree (whose own top-level differs from the main root)
  // needs inheritance; the main worktree already matches by path.
  if (!topLevel || normalizeWorkspaceRoot(topLevel) === mainRoot) return {};

  return { mainWorktreeRoot: mainRoot };
}
