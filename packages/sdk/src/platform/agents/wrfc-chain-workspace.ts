/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * wrfc-chain-workspace.ts, the isolated worktree one WRFC chain works in.
 *
 * A chain never edits the user's working directory while it runs. At chain
 * start the user's current files, uncommitted edits and untracked files
 * included, are captured as a snapshot commit WITHOUT touching the user's
 * index (a private GIT_INDEX_FILE), and the chain gets its own git worktree on
 * branch `wrfc/<chain>` checked out at that snapshot. Every chain member
 * (engineer, reviewer, integrator, gates) works there, and the planned-fix
 * workstream branches its item worktrees from, and merges them back into, the
 * chain branch (the engine's `worktree` isolation mode with this worktree as
 * the workstream root).
 *
 * Only after the chain passes does its work come back (landChainWorkspace):
 * the chain's OWN delta, snapshot..chain tip, is three-way merged onto the
 * user's current HEAD and committed as one commit built in a private index,
 * so edits that were uncommitted before the chain started are never part of
 * the chain's commit. The same delta is three-way merged into the user's
 * working copy, so uncommitted edits in a file the chain also changed stay in
 * place, and a file where the two overlap is left exactly as the user had it.
 * Every such case is named in the returned note.
 *
 * All git work is synchronous (Bun.spawnSync, the dirty-guard.ts and
 * worktree-isolation.ts precedent): the controller's chain lifecycle calls are
 * synchronous and these are short, local git plumbing commands.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { resolveEffectiveWorktreeSetup, runWorktreeSetup } from '../runtime/worktree/setup.js';

/** The isolated worktree a chain runs in. Plain data: serialized with the chain. */
export interface WrfcChainWorkspace {
  /** The user's repository top level (where the chain's work lands). */
  readonly toplevel: string;
  /** The chain worktree's top level. */
  readonly path: string;
  /** Where chain members work: the chain worktree plus the project's path inside the repository. */
  readonly cwd: string;
  /** The chain branch (`wrfc/<chain>`). */
  readonly branch: string;
  /** The user's HEAD when the chain started (null in a repository with no commits yet). */
  readonly baseHead: string | null;
  /** The commit the chain started from: HEAD plus the user's uncommitted work at chain start. */
  readonly snapshot: string;
  /** Paths that carried uncommitted work at chain start (never part of the chain's commit). */
  readonly startedWithUncommitted: readonly string[];
}

export type OpenChainWorkspaceResult =
  | { readonly kind: 'isolated'; readonly workspace: WrfcChainWorkspace }
  | { readonly kind: 'not-a-repository' }
  | { readonly kind: 'error'; readonly reason: string };

/** What happened when a passed chain's work came back to the user's directory. */
export interface ChainLandingResult {
  /**
   * committed: one commit with only the chain's changes, working copy updated.
   * applied: working copy updated, nothing committed (commit not requested, or held, see heldFiles).
   * nothing: the chain changed no files.
   * failed: the landing could not complete; the user's files were not touched and the work is on the branch.
   */
  readonly status: 'committed' | 'applied' | 'nothing' | 'failed';
  readonly commit?: string | undefined;
  /** Every file the chain changed (repository-relative). */
  readonly files: readonly string[];
  /** Files that carried the user's uncommitted work: that work was kept in place and is not in the commit. */
  readonly keptUncommitted: readonly string[];
  /** Files left exactly as the user had them because the user's uncommitted edits overlap the chain's change. */
  readonly leftAsIs: readonly string[];
  /** Files whose chain change builds on the user's uncommitted edits, so no commit was made (it would have included them). */
  readonly heldFiles: readonly string[];
  /** True when the chain branch was kept (its work is not fully in the user's directory/commit). */
  readonly branchKept: boolean;
  /** Plain sentence(s) for the chain's completion message. */
  readonly note: string;
}

export interface LandChainWorkspaceOptions {
  /** Commit the chain's changes (auto-commit on) or only apply them to the working copy. */
  readonly commit: boolean;
  /** The commit message (used only when committing). */
  readonly message: string;
  /** Why no commit was requested, stated in the note (e.g. "auto-commit is off"). */
  readonly noCommitReason?: string | undefined;
}

interface GitRun {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const INTERNAL_IDENTITY = ['-c', 'user.name=GoodVibes', '-c', 'user.email=goodvibes@local'];
const ZERO_OID = '0000000000000000000000000000000000000000';
/** Bookkeeping directories are never part of a chain's work (they hold the worktrees themselves). */
const EXCLUDE_BOOKKEEPING = [':(exclude,glob)**/.goodvibes', ':(exclude,glob)**/.goodvibes/**'];

function git(cwd: string, args: readonly string[], options: { env?: Record<string, string>; stdin?: Uint8Array } = {}): GitRun {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode ?? 1,
    stdout: Buffer.from(result.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(result.stderr ?? new Uint8Array()).trim(),
  };
}

function gitText(cwd: string, args: readonly string[], options: { env?: Record<string, string>; stdin?: Uint8Array } = {}): string {
  const run = git(cwd, args, options);
  if (run.code !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${run.stderr || `exit ${run.code}`}`);
  return run.stdout.toString('utf-8').trim();
}

function revParse(cwd: string, rev: string): string | null {
  const run = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return run.code === 0 ? run.stdout.toString('utf-8').trim() : null;
}

function shortChainId(chainId: string): string {
  const cleaned = chainId.replace(/^wrfc-/, '').replace(/[^A-Za-z0-9._-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'chain';
}

/** Identity flags for a commit on the user's branch: theirs when configured, a plain fallback otherwise. */
function userCommitIdentity(cwd: string): string[] {
  const email = git(cwd, ['config', '--get', 'user.email']);
  const name = git(cwd, ['config', '--get', 'user.name']);
  return email.code === 0 && name.code === 0 ? [] : INTERNAL_IDENTITY;
}

function listNulPaths(buffer: Buffer): string[] {
  return buffer.toString('utf-8').split('\0').filter((entry) => entry.length > 0);
}

/**
 * Open the isolated worktree for a chain. `not-a-repository` means isolation is
 * impossible (no git), the caller keeps its non-git behavior; `error` means a
 * git repository where the worktree could not be made.
 */
export function openChainWorkspace(projectRoot: string, chainId: string): OpenChainWorkspaceResult {
  if (!existsSync(projectRoot)) return { kind: 'not-a-repository' };
  const top = git(projectRoot, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { kind: 'not-a-repository' };
  const toplevel = top.stdout.toString('utf-8').trim();
  if (git(toplevel, ['rev-parse', '--is-bare-repository']).stdout.toString('utf-8').trim() === 'true') {
    return { kind: 'not-a-repository' };
  }
  const indexDir = mkdtempSync(join(tmpdir(), 'goodvibes-wrfc-index-'));
  try {
    const baseHead = revParse(toplevel, 'HEAD');
    const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
    gitText(toplevel, baseHead ? ['read-tree', baseHead] : ['read-tree', '--empty'], { env });
    gitText(toplevel, ['add', '-A', '--', '.', ...EXCLUDE_BOOKKEEPING], { env });
    const tree = gitText(toplevel, ['write-tree'], { env });
    const baseTree = baseHead ? gitText(toplevel, ['rev-parse', `${baseHead}^{tree}`]) : null;
    let snapshot: string;
    let startedWithUncommitted: string[] = [];
    if (baseHead && tree === baseTree) {
      snapshot = baseHead;
    } else {
      snapshot = gitText(toplevel, [
        ...INTERNAL_IDENTITY, 'commit-tree', tree, ...(baseHead ? ['-p', baseHead] : []),
        '-m', `goodvibes: your files at the start of chain ${chainId}, uncommitted edits included (never merged)`,
      ]);
      startedWithUncommitted = baseHead
        ? listNulPaths(git(toplevel, ['diff', '--name-only', '-z', '--no-renames', baseHead, snapshot]).stdout)
        : listNulPaths(git(toplevel, ['ls-tree', '-r', '--name-only', '-z', snapshot]).stdout);
    }
    const short = shortChainId(chainId);
    const branch = `wrfc/${short}`;
    const path = join(resolve(projectRoot), '.goodvibes', '.worktrees', 'wrfc', short);
    mkdirSync(dirname(path), { recursive: true });
    gitText(toplevel, ['worktree', 'add', '--quiet', '-b', branch, path, snapshot]);
    const rel = relative(toplevel, resolve(projectRoot));
    return {
      kind: 'isolated',
      workspace: {
        toplevel,
        path,
        cwd: rel.length > 0 && !rel.startsWith('..') ? join(path, rel) : path,
        branch,
        baseHead,
        snapshot,
        startedWithUncommitted,
      },
    };
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/** The plain clause naming where a chain works (empty outside isolation). */
export function describeChainIsolation(workspace: WrfcChainWorkspace | undefined): string {
  if (!workspace) return '';
  const carried = workspace.startedWithUncommitted.length > 0
    ? `; it starts from your current files, including uncommitted edits in ${listFiles(workspace.startedWithUncommitted)}, which this chain will not commit`
    : '';
  return ` in isolated worktree ${workspace.path} on branch ${workspace.branch}${carried}`;
}

/**
 * Cold-start setup for a chain worktree, the same derived setup the engine
 * runs for fix-item worktrees (lockfile install, untracked config carry-over),
 * so the chain's gates and tests run with dependencies present. Never throws:
 * a failed setup is returned as a plain sentence, and the chain still runs.
 */
export async function prepareChainWorkspace(
  workspace: WrfcChainWorkspace,
  projectRoot: string,
  getConfig: (key: string) => unknown,
): Promise<string | null> {
  try {
    const result = await runWorktreeSetup(workspace.path, projectRoot, resolveEffectiveWorktreeSetup(getConfig, projectRoot));
    return result.state === 'failed' ? `worktree setup did not complete (${result.error ?? 'unknown reason'})` : null;
  } catch (error) {
    return `worktree setup did not complete (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Commit everything the chain changed in its worktree onto the chain branch.
 * The worktree started from the snapshot, so everything dirty in it is the
 * chain's own work. Returns the new commit, or null when the tree was clean.
 */
export function checkpointChainWorkspace(workspace: WrfcChainWorkspace, message: string): string | null {
  if (!existsSync(workspace.path)) return null;
  gitText(workspace.path, ['add', '-A', '--', '.', ...EXCLUDE_BOOKKEEPING]);
  if (git(workspace.path, ['diff', '--cached', '--quiet']).code === 0) return null;
  gitText(workspace.path, [...INTERNAL_IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message]);
  return gitText(workspace.path, ['rev-parse', 'HEAD']);
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}

function treeEntry(cwd: string, commit: string | null, path: string): TreeEntry | null {
  if (!commit) return null;
  const out = git(cwd, ['ls-tree', '-z', commit, '--', path]).stdout.toString('utf-8');
  const record = out.split('\0').find((line) => line.endsWith(`\t${path}`));
  if (!record) return null;
  const [meta] = record.split('\t');
  const [mode, type, oid] = (meta ?? '').split(' ');
  if (!mode || !oid || type === 'tree') return null;
  return { mode, oid };
}

function blobBytes(cwd: string, entry: TreeEntry | null): Buffer | null {
  if (!entry) return null;
  if (entry.mode === '160000') return Buffer.from(`submodule ${entry.oid}`);
  const run = git(cwd, ['cat-file', 'blob', entry.oid]);
  if (run.code !== 0) throw new Error(`git cat-file failed for ${entry.oid}: ${run.stderr}`);
  return run.stdout;
}

/** The index entry for a path: null when absent, 'unmerged' when the index holds a conflict for it. */
function indexEntry(cwd: string, path: string): TreeEntry | null | 'unmerged' {
  const out = git(cwd, ['ls-files', '-s', '-z', '--', path]).stdout.toString('utf-8');
  const records = out.split('\0').filter((line) => line.endsWith(`\t${path}`));
  if (records.length === 0) return null;
  if (records.length > 1) return 'unmerged';
  const [meta] = records[0]!.split('\t');
  const [mode, oid, stage] = (meta ?? '').split(' ');
  if (!mode || !oid || stage !== '0') return 'unmerged';
  return { mode, oid };
}

type WorkingFile = { readonly kind: 'absent' } | { readonly kind: 'file'; readonly bytes: Buffer; readonly executable: boolean } | { readonly kind: 'link'; readonly bytes: Buffer } | { readonly kind: 'other' };

function readWorkingFile(absolute: string): WorkingFile {
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return { kind: 'absent' };
  }
  if (stats.isSymbolicLink()) return { kind: 'link', bytes: Buffer.from(readlinkSync(absolute)) };
  if (stats.isFile()) return { kind: 'file', bytes: readFileSync(absolute), executable: (stats.mode & 0o111) !== 0 };
  return { kind: 'other' };
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

type Merge3 = { readonly ok: true; readonly value: Buffer | null } | { readonly ok: false };

/** Three-way merge of whole-file contents (null = file absent). Trivial cases first, then `git merge-file`. */
function merge3(scratch: string, base: Buffer | null, ours: Buffer | null, theirs: Buffer | null): Merge3 {
  if (sameBytes(ours, theirs)) return { ok: true, value: ours };
  if (sameBytes(base, ours)) return { ok: true, value: theirs };
  if (sameBytes(base, theirs)) return { ok: true, value: ours };
  if (base === null || ours === null || theirs === null) return { ok: false };
  const oursFile = join(scratch, 'ours');
  const baseFile = join(scratch, 'base');
  const theirsFile = join(scratch, 'theirs');
  writeFileSync(oursFile, ours);
  writeFileSync(baseFile, base);
  writeFileSync(theirsFile, theirs);
  const run = git(scratch, ['merge-file', '-p', '-q', oursFile, baseFile, theirsFile]);
  return run.code === 0 ? { ok: true, value: run.stdout } : { ok: false };
}

function hashBlob(cwd: string, bytes: Buffer): string {
  return gitText(cwd, ['hash-object', '-w', '--stdin'], { stdin: bytes });
}

function writeWorkingFile(absolute: string, bytes: Buffer | null, mode: string | null): void {
  const existing = readWorkingFile(absolute);
  if (bytes === null) {
    if (existing.kind !== 'absent') unlinkSync(absolute);
    return;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  if (mode === '120000') {
    if (existing.kind !== 'absent') unlinkSync(absolute);
    symlinkSync(bytes.toString('utf-8'), absolute);
    return;
  }
  if (existing.kind === 'link') unlinkSync(absolute);
  writeFileSync(absolute, bytes);
  if (mode === '100755') chmodSync(absolute, 0o755);
  else if (mode === '100644' && existing.kind === 'file' && existing.executable) chmodSync(absolute, 0o644);
}

function listFiles(paths: readonly string[]): string {
  if (paths.length <= 4) return paths.join(', ');
  return `${paths.slice(0, 4).join(', ')} and ${paths.length - 4} more`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Remove the chain worktree directory (its work is committed on the branch first). Never throws. */
function removeWorktreeDirectory(workspace: WrfcChainWorkspace): void {
  if (!existsSync(workspace.path)) return;
  const run = git(workspace.toplevel, ['worktree', 'remove', '--force', workspace.path]);
  if (run.code !== 0 && existsSync(workspace.path)) {
    rmSync(workspace.path, { recursive: true, force: true });
    git(workspace.toplevel, ['worktree', 'prune']);
  }
}

/**
 * On a failed or cancelled chain: keep the chain's work on its branch (commit
 * anything uncommitted), remove the worktree directory, and name the branch.
 * The user's directory is never touched. Never throws.
 */
export function releaseChainWorkspace(workspace: WrfcChainWorkspace): { readonly branchKept: boolean; readonly note: string } {
  try {
    checkpointChainWorkspace(workspace, 'goodvibes: chain work kept when the chain stopped');
    removeWorktreeDirectory(workspace);
    const tip = revParse(workspace.toplevel, workspace.branch);
    if (!tip || tip === workspace.snapshot) {
      git(workspace.toplevel, ['branch', '-D', workspace.branch]);
      return { branchKept: false, note: 'your files were not changed' };
    }
    return { branchKept: true, note: `your files were not changed; the chain's work so far is kept on branch ${workspace.branch}` };
  } catch (error) {
    return { branchKept: true, note: `your files were not changed; the chain's worktree is left at ${workspace.path} (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Bring a passed chain's work back to the user's directory. See the module doc.
 * Never throws: an unexpected git failure yields status 'failed' with the
 * user's files untouched and the chain's work kept on its branch.
 */
export function landChainWorkspace(workspace: WrfcChainWorkspace, options: LandChainWorkspaceOptions): ChainLandingResult {
  const empty = { keptUncommitted: [], leftAsIs: [], heldFiles: [] } as const;
  let tip: string | null;
  try {
    checkpointChainWorkspace(workspace, 'goodvibes: chain work at pass');
    tip = revParse(workspace.toplevel, workspace.branch);
  } catch (error) {
    return {
      status: 'failed', files: [], ...empty, branchKept: true,
      note: `the chain's work could not be brought back (${error instanceof Error ? error.message : String(error)}); your files were not changed and the work is in ${workspace.path}`,
    };
  }
  if (!tip) {
    return { status: 'failed', files: [], ...empty, branchKept: false, note: `the chain branch ${workspace.branch} is missing; your files were not changed` };
  }
  const top = workspace.toplevel;
  const files = listNulPaths(git(top, ['diff', '--name-only', '-z', '--no-renames', workspace.snapshot, tip, '--', '.', ...EXCLUDE_BOOKKEEPING]).stdout);
  if (files.length === 0) {
    removeWorktreeDirectory(workspace);
    git(top, ['branch', '-D', workspace.branch]);
    return { status: 'nothing', files, ...empty, branchKept: false, note: 'the chain changed no files, so there was nothing to commit' };
  }

  const scratch = mkdtempSync(join(tmpdir(), 'goodvibes-wrfc-land-'));
  try {
    const head = revParse(top, 'HEAD');
    interface PlannedFile {
      readonly path: string;
      readonly theirsEntry: TreeEntry | null;
      readonly headEntry: TreeEntry | null;
      readonly headBytes: Buffer | null;
      readonly commitMerge: Merge3;
      readonly workMerge: Merge3;
      readonly working: WorkingFile;
      readonly dirty: boolean;
    }
    const planned: PlannedFile[] = [];
    for (const path of files) {
      const baseEntry = treeEntry(top, workspace.snapshot, path);
      const theirsEntry = treeEntry(top, tip, path);
      const headEntry = treeEntry(top, head, path);
      const base = blobBytes(top, baseEntry);
      const theirs = blobBytes(top, theirsEntry);
      const headBytes = blobBytes(top, headEntry);
      const working = readWorkingFile(join(top, path));
      const workingBytes = working.kind === 'file' || working.kind === 'link' ? working.bytes : null;
      const index = indexEntry(top, path);
      const indexDirty = index === 'unmerged' || (index?.oid ?? null) !== (headEntry?.oid ?? null);
      const workingDirty = working.kind === 'other' || !sameBytes(workingBytes, headBytes);
      planned.push({
        path,
        theirsEntry,
        headEntry,
        headBytes,
        // The chain's own delta (snapshot -> tip) applied onto the user's HEAD: never carries uncommitted edits.
        commitMerge: merge3(scratch, base, headBytes, theirs),
        // The chain's delta applied onto the user's working copy as it is now.
        workMerge: working.kind === 'other' ? { ok: false } : merge3(scratch, base, workingBytes, theirs),
        working,
        dirty: indexDirty || workingDirty,
      });
    }

    const heldFiles = planned.filter((file) => !file.commitMerge.ok).map((file) => file.path);
    const keptUncommitted: string[] = [];
    const leftAsIs: string[] = [];
    let commit: string | undefined;

    if (options.commit && heldFiles.length === 0) {
      const indexDir = join(scratch, 'index');
      mkdirSync(indexDir);
      const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
      gitText(top, head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      const committed = new Map<string, { mode: string; oid: string } | null>();
      for (const file of planned) {
        const value = (file.commitMerge as { value: Buffer | null }).value;
        if (value === null) {
          gitText(top, ['update-index', '--force-remove', '--', file.path], { env });
          committed.set(file.path, null);
          continue;
        }
        const mode = file.theirsEntry?.mode ?? file.headEntry?.mode ?? '100644';
        const oid = hashBlob(top, value);
        gitText(top, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${file.path}`], { env });
        committed.set(file.path, { mode, oid });
      }
      const tree = gitText(top, ['write-tree'], { env });
      const headTree = head ? gitText(top, ['rev-parse', `${head}^{tree}`]) : null;
      if (tree !== headTree) {
        commit = gitText(top, [...userCommitIdentity(top), 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', options.message]);
        gitText(top, ['update-ref', '-m', 'goodvibes: WRFC chain commit', 'HEAD', commit, head ?? ZERO_OID]);
        // The user's index: a path with nothing staged moves to the new commit's
        // version; a path with staged edits keeps them, merged with the chain's
        // change when they do not overlap.
        for (const file of planned) {
          const entry = committed.get(file.path) ?? null;
          const index = indexEntry(top, file.path);
          if (index === 'unmerged') continue;
          if ((index?.oid ?? null) === (file.headEntry?.oid ?? null)) {
            if (entry) gitText(top, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${file.path}`]);
            else git(top, ['update-index', '--force-remove', '--', file.path]);
            continue;
          }
          const staged = index ? blobBytes(top, index) : null;
          const merged = merge3(scratch, file.headBytes, staged, entry ? blobBytes(top, entry) : null);
          if (!merged.ok) continue;
          if (merged.value === null) git(top, ['update-index', '--force-remove', '--', file.path]);
          else gitText(top, ['update-index', '--add', '--cacheinfo', `${index?.mode ?? entry?.mode ?? '100644'},${hashBlob(top, merged.value)},${file.path}`]);
        }
      }
    }

    // The working copy: the chain's delta merged around whatever the user has there now.
    for (const file of planned) {
      if (!file.workMerge.ok) {
        leftAsIs.push(file.path);
        continue;
      }
      if (file.dirty) keptUncommitted.push(file.path);
      const value = file.workMerge.value;
      const current = file.working.kind === 'file' || file.working.kind === 'link' ? file.working.bytes : null;
      if (sameBytes(current, value)) continue;
      writeWorkingFile(join(top, file.path), value, file.theirsEntry?.mode ?? file.headEntry?.mode ?? null);
    }

    const fullyLanded = commit !== undefined && leftAsIs.length === 0;
    removeWorktreeDirectory(workspace);
    if (fullyLanded) git(top, ['branch', '-D', workspace.branch]);
    const branchKept = !fullyLanded;

    const sentences: string[] = [];
    if (commit !== undefined) {
      sentences.push(`committed ${commit.slice(0, 7)} with only the chain's changes to ${plural(files.length, 'file')} (${listFiles(files)})`);
    } else if (options.commit && heldFiles.length > 0) {
      sentences.push(`nothing was committed: the chain's changes to ${listFiles(heldFiles)} build on edits you had not committed, so a commit would have included your edits`);
      sentences.push(`the chain's changes were applied to your working copy and are kept on branch ${workspace.branch}`);
    } else if (options.commit) {
      sentences.push(`the chain's changes to ${listFiles(files)} were already in your last commit, so no new commit was made`);
    } else {
      sentences.push(`${options.noCommitReason ?? 'no commit was requested'}, so the chain's changes to ${plural(files.length, 'file')} (${listFiles(files)}) were applied to your working copy without a commit`);
    }
    if (keptUncommitted.length > 0) {
      sentences.push(`your uncommitted edits in ${listFiles(keptUncommitted)} were kept in place${commit !== undefined ? ' and are not part of that commit' : ''}`);
    }
    if (leftAsIs.length > 0) {
      sentences.push(`${listFiles(leftAsIs)} ${leftAsIs.length === 1 ? 'was' : 'were'} left exactly as you had ${leftAsIs.length === 1 ? 'it' : 'them'} because your uncommitted edits there overlap the chain's change; the chain's version is on branch ${workspace.branch}`);
    }
    return {
      status: commit !== undefined ? 'committed' : (options.commit && heldFiles.length === 0 ? 'nothing' : 'applied'),
      ...(commit !== undefined ? { commit } : {}),
      files,
      keptUncommitted,
      leftAsIs,
      heldFiles,
      branchKept,
      note: sentences.join('; '),
    };
  } catch (error) {
    return {
      status: 'failed', files, ...empty, branchKept: true,
      note: `the chain's work could not be brought back (${error instanceof Error ? error.message : String(error)}); it is kept on branch ${workspace.branch}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
