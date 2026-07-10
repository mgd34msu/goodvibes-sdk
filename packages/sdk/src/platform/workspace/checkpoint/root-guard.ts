/**
 * root-guard.ts
 *
 * Pure helpers and constants for WorkspaceCheckpointManager's root-safety
 * guards: deciding whether a resolved workspace root is too broad to snapshot,
 * and building the honest refusal messages used both for automatic-subscription
 * skips and for rejected explicit `create()` calls.
 *
 * Kept separate from manager.ts so the guard policy (and its wording) is
 * unit-testable in isolation and the manager file stays within its line cap.
 */

import { existsSync, realpathSync } from 'node:fs';
import { parse, resolve } from 'node:path';

/** Constructor option (and log-facing name) that opts a manager into snapshotting a broad root (home, fs root, or the daemon state dir). */
export const BROAD_ROOT_OVERRIDE = 'allowBroadRoot';

/** Constructor option (and log-facing name) that opts a manager into a first snapshot whose sweep exceeds the file-count ceiling. */
export const LARGE_FIRST_SNAPSHOT_OVERRIDE = 'allowLargeFirstSnapshot';

/**
 * Default ceiling for the first-ever snapshot's file sweep. Deliberately
 * generous: a real source tree (with node_modules/build output gitignored)
 * sits far below this, while a mistaken sweep of a home directory or an
 * over-broad root blows past it — the exact case that produced an orphaned
 * multi-GiB checkpoint store rooted at $HOME.
 */
export const DEFAULT_MAX_FIRST_SNAPSHOT_FILES = 50_000;

/**
 * Decide whether `root` is too broad to auto-snapshot. Returns a short,
 * human-readable reason when it is (filesystem root, the user's home
 * directory, or the daemon state directory `~/.goodvibes`), or `null` when the
 * root is a normal project directory. Paths are compared by their canonical
 * (realpath-resolved where possible) form so symlinked homes still match.
 */
export function broadRootReason(root: string, homeDir: string, daemonStateDir: string): string | null {
  const canonical = (p: string): string => {
    try {
      return existsSync(p) ? realpathSync(p) : resolve(p);
    } catch {
      return resolve(p);
    }
  };
  const r = canonical(root);
  if (parse(r).root === r) return 'the filesystem root';
  if (r === canonical(homeDir)) return 'the user home directory';
  if (r === canonical(daemonStateDir)) return 'the daemon state directory (~/.goodvibes)';
  return null;
}

/** Honest, override-naming message for a refused broad root. */
export function broadRootRefusalMessage(root: string, reason: string): string {
  return (
    `WorkspaceCheckpointManager: refusing to checkpoint "${root}" because it is ${reason}. ` +
    `Automatic and manual checkpoints are disabled for this root to avoid an unbounded store. ` +
    `Set ${BROAD_ROOT_OVERRIDE} if a broad root is genuinely intended.`
  );
}

/** Honest, count-and-override-naming message for a refused oversized first snapshot. */
export function firstSnapshotTooLargeMessage(root: string, count: number, limit: number): string {
  return (
    `WorkspaceCheckpointManager: refusing the first checkpoint of "${root}" — ` +
    `a full sweep would capture ${count} files (limit ${limit}). ` +
    `This usually means the root is too broad. Set ${LARGE_FIRST_SNAPSHOT_OVERRIDE} to proceed anyway.`
  );
}
