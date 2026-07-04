/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Dirty-residue guard (Wave 6, wo-F item 4) — prevents an orchestration
 * engine run's scoped commit from sweeping in uncommitted changes that were
 * ALREADY sitting in the working tree before this engine launched (typically
 * residue left behind by a previously killed run sharing the same
 * `projectRoot`, since phase-runner.ts's WorkItem.touchedPaths accumulates
 * across phases/retries and never resets — see phase-runner.ts runPhase).
 *
 * Mechanism: snapshot every dirty path + a binary-safe content hash at
 * engine-launch time (`snapshotDirtyTree`). At scoped-commit time, a
 * candidate path is excluded only when it was ALREADY dirty at launch AND
 * its content hash is unchanged since launch — i.e. this run never touched
 * it. A path that was clean at launch, or whose hash changed, is included:
 * this run is the one that dirtied (or re-dirtied) it.
 *
 * `snapshotDirtyTree` is deliberately SYNCHRONOUS (Bun.spawnSync, mirroring
 * GitService's own sync helpers — initRepo/isGitRepo/getRepoRoot,
 * platform/git/service.ts) rather than shelling out through simple-git's
 * async API: the engine factory (engine.ts) is a synchronous function that
 * must have a settled snapshot before its first phase can possibly reach a
 * commit, and a promise backed by real child-process I/O cannot be relied
 * on to resolve within a caller's microtask-only wait (subprocess exit is
 * delivered via the event loop's macrotask phases, not microtasks) — a real
 * regression seen against tests that only drain microtasks. One blocking
 * `git status` call at launch (paid once, exactly like GitService.initRepo)
 * avoids that whole class of timing hazard entirely.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Dirty paths under this prefix are GoodVibes' own internal state, never a candidate for a scoped commit — excluded from the snapshot so they never pollute the 'dirty-tree-at-launch' event. */
const INTERNAL_STATE_PREFIX = '.goodvibes/';

/** Content hash of a file's current working-tree bytes. Binary-safe (raw bytes, not text). Returns null when the path does not exist on disk (a working-tree deletion). */
export function hashWorkingTreeFile(cwd: string, relativePath: string): string | null {
  const absolutePath = join(cwd, relativePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  } catch (error) {
    logger.warn('orchestration dirty-guard: failed to hash working-tree file', {
      path: relativePath,
      error: summarizeError(error),
    });
    return null;
  }
}

/** path -> content hash at launch (null = the dirty path did not exist on disk, e.g. an unstaged deletion). */
export type DirtyLaunchSnapshot = ReadonlyMap<string, string | null>;

/** Parse `git status --porcelain` output into a set of paths. Handles the `R  old -> new` rename line by keeping only the destination path (the one that will actually be a scoped-commit candidate). */
function parsePorcelainPaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    // Porcelain v1: 2 status chars + 1 space, then the path (which may itself
    // contain spaces — never split on whitespace).
    if (line.length < 4) continue;
    let path = line.slice(3);
    const renameArrow = path.indexOf(' -> ');
    if (renameArrow !== -1) path = path.slice(renameArrow + ' -> '.length);
    if (path.startsWith(INTERNAL_STATE_PREFIX)) continue;
    paths.add(path);
  }
  return paths;
}

/**
 * Snapshot every dirty path (staged + unstaged + untracked) in `cwd`'s
 * working tree right now, each with a content hash. Call once at engine
 * launch, before any phase of this run has had a chance to touch anything.
 * Never throws: a git failure (e.g. `cwd` is not a repo) degrades to an
 * empty snapshot, which makes the exclusion guard a no-op (today's
 * behavior) rather than blocking commits.
 */
export function snapshotDirtyTree(cwd: string): DirtyLaunchSnapshot {
  try {
    const result = Bun.spawnSync(['git', '-C', cwd, 'status', '--porcelain', '--untracked-files=all']);
    if (result.exitCode !== 0) return new Map();
    const output = new TextDecoder().decode(result.stdout);
    const paths = parsePorcelainPaths(output);
    const snapshot = new Map<string, string | null>();
    for (const path of paths) snapshot.set(path, hashWorkingTreeFile(cwd, path));
    return snapshot;
  } catch (error) {
    logger.warn('orchestration dirty-guard: failed to snapshot dirty tree at launch', { error: summarizeError(error) });
    return new Map();
  }
}

/** Result of partitioning a scoped commit's candidate paths against the launch snapshot. */
export interface ScopedCommitExclusion {
  readonly included: readonly string[];
  readonly excluded: readonly string[];
}

/**
 * Partition `candidatePaths` into paths safe to include in a scoped commit
 * vs. paths that must be excluded because they are untouched launch-dirty
 * residue. A path is excluded only when BOTH:
 *  - it appears in `launchSnapshot` (it was already dirty before this run), AND
 *  - its current content hash equals the hash recorded at launch (this run
 *    never actually changed it).
 * Everything else is included — a path absent from the snapshot was clean
 * at launch (this run is what dirtied it), and a path whose hash changed
 * was genuinely touched by this run even though it started out dirty.
 */
export function excludeUntouchedLaunchResidue(
  cwd: string,
  candidatePaths: readonly string[],
  launchSnapshot: DirtyLaunchSnapshot,
): ScopedCommitExclusion {
  const included: string[] = [];
  const excluded: string[] = [];
  for (const path of candidatePaths) {
    if (!launchSnapshot.has(path)) {
      included.push(path);
      continue;
    }
    const hashAtLaunch = launchSnapshot.get(path) ?? null;
    const hashNow = hashWorkingTreeFile(cwd, path);
    if (hashAtLaunch === hashNow) {
      excluded.push(path);
    } else {
      included.push(path);
    }
  }
  return { included, excluded };
}
