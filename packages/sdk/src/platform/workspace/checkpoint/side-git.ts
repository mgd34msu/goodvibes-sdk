/**
 * side-git.ts
 *
 * SideGitRunner — a hidden git repository ("side repo") whose object store
 * (GIT_DIR) lives under <workspaceRoot>/.goodvibes/checkpoints/git while its
 * GIT_WORK_TREE is the live workspace itself.
 *
 * This is the dotfiles-bare-repo trick (`git --git-dir=X --work-tree=Y`):
 * git tracks arbitrary files in Y using an object store rooted at X,
 * completely independent of whatever real .git directory Y may or may not
 * already have. It gives us, for free:
 *   - content-addressed, deduped storage (unchanged files cost ~nothing)
 *   - `git diff` / `git diff --stat` between any two snapshots
 *   - whole-tree restore via `read-tree` + `checkout-index`
 *   - correct behavior in a workspace that is NOT itself a git repo
 *
 * DO NOT reuse GitService (../../git/service.ts) for this: it binds a single
 * baseDir with no GIT_DIR support, and it fires Pre/Post hook events on
 * every commit/add — automatic silent snapshots must never trigger a user's
 * PreCommit/PostCommit hooks. AgentWorktree (../../agents/worktree.ts) already
 * proves the `simpleGit(...).raw([...])` + explicit env pattern used here.
 *
 * Checkpoints are addressed entirely through our own ref namespace
 * (refs/goodvibes/checkpoints/<id>) and through commit objects created via
 * `commit-tree`, never through the side repo's HEAD/branch. There is no
 * meaningful "current branch" in this design — parent/lineage is tracked in
 * the manifest (manager.ts), not via git HEAD — so there is nothing to leave
 * "detached" and no branch state to pollute.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Git's well-known empty-tree object hash, valid in every repository. */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Ref namespace all workspace checkpoints live under. */
export const CHECKPOINT_REF_PREFIX = 'refs/goodvibes/checkpoints/';

/** Fallback identity used for checkpoint commits so this never depends on the user's global git config. */
const FALLBACK_IDENTITY = { name: 'GoodVibes Checkpoints', email: 'checkpoints@goodvibes.local' } as const;

/**
 * Environment variable names that simple-git's built-in vulnerability scanner
 * treats as unsafe (it would otherwise throw on every raw call rather than
 * risk spawning an interactive editor/pager/askpass/proxy). We never need
 * any of these — every commit here is created via `commit-tree -m <message>`,
 * never a bare `commit`/`rebase -i`/`merge` — so stripping them from the
 * inherited environment we pass through is both safe and avoids depending on
 * simple-git's `unsafe.allowUnsafe*` escape hatches (not part of this
 * package version's public option types).
 */
const UNSAFE_GIT_ENV_KEYS = new Set([
  'editor',
  'git_editor',
  'git_sequence_editor',
  'git_askpass',
  'ssh_askpass',
  'git_config',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'pager',
  'git_proxy_command',
  'git_template_dir',
  'git_ssh',
  'git_ssh_command',
  'prefix',
]);

/** Copy `env`, dropping keys (case-insensitively) that simple-git's vulnerability scanner blocks by default. */
function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (UNSAFE_GIT_ENV_KEYS.has(key.toLowerCase())) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export interface SideGitRunnerOptions {
  /** Absolute path to the live workspace (GIT_WORK_TREE). */
  readonly workspaceRoot: string;
  /** Absolute path to the side repo's object store (GIT_DIR). */
  readonly gitDir: string;
}

/**
 * Thin runner around a `simple-git` instance permanently scoped (via `.env()`)
 * to an isolated GIT_DIR/GIT_WORK_TREE pair. Every method here is a small,
 * named wrapper around a raw git invocation — no hook emission, no shared
 * state with the user's real repository.
 */
export class SideGitRunner {
  readonly workspaceRoot: string;
  readonly gitDir: string;
  private readonly git: SimpleGit;

  constructor(opts: SideGitRunnerOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.gitDir = opts.gitDir;
    this.git = simpleGit({ baseDir: opts.workspaceRoot }).env({
      ...sanitizeGitEnv(process.env),
      GIT_DIR: opts.gitDir,
      GIT_WORK_TREE: opts.workspaceRoot,
    });
  }

  /** Run an arbitrary raw git command against the side repo, returning stdout. */
  async raw(args: string[]): Promise<string> {
    return this.git.raw(args);
  }

  /**
   * Idempotently initialize the side repo: `git init` the GIT_DIR if it does
   * not already look initialized, set a local (side-repo-only) fallback
   * identity so commits never depend on the user's global git config, and
   * ensure `.goodvibes` is gitignored from the user's own repo's perspective.
   */
  async init(): Promise<void> {
    if (!existsSync(this.gitDir)) {
      mkdirSync(this.gitDir, { recursive: true });
    }
    const alreadyInit = existsSync(join(this.gitDir, 'HEAD'));
    if (!alreadyInit) {
      await this.git.raw(['init', '--quiet']);
      logger.debug('SideGitRunner.init: initialized side repo', { gitDir: this.gitDir });
    }
    // Local (side-repo-scoped) identity — never touches the user's ~/.gitconfig
    // or the workspace's real .git/config (there is no --global here, and
    // GIT_DIR points at our own directory, so `git config` without --global
    // writes to <gitDir>/config).
    await this.git.raw(['config', 'user.name', FALLBACK_IDENTITY.name]);
    await this.git.raw(['config', 'user.email', FALLBACK_IDENTITY.email]);
    this.ensureGoodvibesIgnored();
  }

  /**
   * Ensure `<workspaceRoot>/.goodvibes/.gitignore` contains a bare `*` line so
   * the side repo's own storage (and every other tool's state under
   * `.goodvibes`) is invisible to the user's OWN git repo (if any). Without
   * this, `git status`/`git add -A` in the user's real repo would see our
   * GIT_DIR as an untracked directory and could accidentally stage it.
   *
   * This intentionally only ever writes inside `.goodvibes/` — it never
   * touches the workspace's own top-level `.gitignore`.
   */
  private ensureGoodvibesIgnored(): void {
    const goodvibesDir = join(this.workspaceRoot, '.goodvibes');
    const ignorePath = join(goodvibesDir, '.gitignore');
    if (!existsSync(goodvibesDir)) {
      mkdirSync(goodvibesDir, { recursive: true });
    }
    try {
      if (!existsSync(ignorePath)) {
        writeFileSync(ignorePath, '*\n', 'utf-8');
        return;
      }
      const existing = readFileSync(ignorePath, 'utf-8');
      const hasIgnoreAll = existing.split('\n').some((line) => line.trim() === '*');
      if (!hasIgnoreAll) {
        writeFileSync(ignorePath, `${existing.replace(/\s*$/, '')}\n*\n`, 'utf-8');
      }
    } catch (err) {
      logger.warn('SideGitRunner.ensureGoodvibesIgnored: failed to write .goodvibes/.gitignore', {
        error: summarizeError(err),
      });
    }
  }

  /**
   * Stage changes into the side index.
   *
   * @param paths When provided (non-empty), stage only these pathspecs
   * (scoped snapshot). Otherwise sweep the whole work tree, always excluding
   * `.goodvibes` (our own storage) via pathspec magic — the same
   * `:(exclude)` pattern AgentWorktree already uses for the same reason.
   * Beyond that exclusion, git's normal `.gitignore` handling already applies
   * here: `.gitignore` matching is a work-tree-relative feature of git and
   * works identically regardless of where GIT_DIR points, so the workspace's
   * own `.gitignore` (node_modules, build output, etc.) is honored with no
   * extra configuration.
   */
  async stageAll(paths?: string[]): Promise<void> {
    const pathspecs = paths && paths.length > 0
      ? paths
      : ['.', ':(exclude).goodvibes', ':(exclude).goodvibes/**'];
    await this.git.raw(['add', '-A', '--', ...pathspecs]);
  }

  /** Write the currently-staged index out as a tree object, without committing. Returns the tree hash. */
  async writeTree(): Promise<string> {
    return (await this.git.raw(['write-tree'])).trim();
  }

  /** Resolve `<commit>^{tree}` for an existing commit hash. */
  async treeOf(commit: string): Promise<string> {
    return (await this.git.raw(['rev-parse', `${commit}^{tree}`])).trim();
  }

  /**
   * Create a commit object from a tree (optionally with a parent), WITHOUT
   * moving any branch/HEAD. The returned hash is only reachable once a ref is
   * pointed at it via `updateRef`.
   */
  async commitTree(treeHash: string, message: string, parentCommit: string | null): Promise<string> {
    const args = ['commit-tree', treeHash, '-m', message];
    if (parentCommit) args.push('-p', parentCommit);
    return (await this.git.raw(args)).trim();
  }

  async updateRef(refName: string, commit: string): Promise<void> {
    await this.git.raw(['update-ref', refName, commit]);
  }

  async deleteRef(refName: string): Promise<void> {
    await this.git.raw(['update-ref', '-d', refName]);
  }

  /** List every ref under CHECKPOINT_REF_PREFIX as `{ id, commit }`. */
  async listCheckpointRefs(): Promise<{ id: string; commit: string }[]> {
    let out: string;
    try {
      out = await this.git.raw(['for-each-ref', '--format=%(refname) %(objectname)', CHECKPOINT_REF_PREFIX]);
    } catch {
      return [];
    }
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [refName, commit] = line.split(' ');
        const id = (refName ?? '').slice(CHECKPOINT_REF_PREFIX.length);
        return { id, commit: commit ?? '' };
      })
      .filter((entry) => entry.id.length > 0 && entry.commit.length > 0);
  }

  /** Files tracked in a commit's tree (recursive, name-only). */
  async listTrackedFiles(commitOrTree: string): Promise<string[]> {
    const out: string = await this.git.raw(['ls-tree', '-r', '--name-only', commitOrTree]);
    return out.split('\n').map((line: string) => line.trim()).filter(Boolean);
  }

  /** Reset the side index to exactly match a commit's tree (does not touch the working tree). */
  async readTreeReset(commit: string): Promise<void> {
    await this.git.raw(['read-tree', '--reset', commit]);
  }

  /** Write every file currently in the side index out to the working tree, overwriting existing files. */
  async checkoutIndexAll(): Promise<void> {
    await this.git.raw(['checkout-index', '-a', '-f']);
  }

  /** `git diff` between two commit-ish values. Omit `to` to diff against the live working tree. */
  async diff(from: string, to?: string): Promise<string> {
    return this.git.raw(to ? ['diff', from, to] : ['diff', from]);
  }

  /** `git diff --stat` between two commit-ish values. Omit `to` to diff against the live working tree. */
  async diffStat(from: string, to?: string): Promise<string> {
    return this.git.raw(to ? ['diff', '--stat', from, to] : ['diff', '--stat', from]);
  }

  /** `git diff --name-only` between two commit-ish values. Omit `to` to diff against the live working tree. */
  async diffNameOnly(from: string, to?: string): Promise<string[]> {
    const out: string = await this.git.raw(to ? ['diff', '--name-only', from, to] : ['diff', '--name-only', from]);
    return out.split('\n').map((line: string) => line.trim()).filter(Boolean);
  }

  /** `git gc --prune=now` on the side repo. */
  async gc(): Promise<void> {
    await this.git.raw(['gc', '--prune=now', '--quiet']);
  }
}
