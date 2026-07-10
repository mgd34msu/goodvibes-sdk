/**
 * workspace/registration/resolution.ts
 *
 * The PURE resolution function and path helpers for the registered-workspace
 * registry. No disk, no git spawning — given a path, optional worktree-link git
 * metadata, and the registry state, it decides whether the path is covered by
 * (and which) registered root, remembered-declined, or unknown.
 *
 * SETTLED SEMANTICS (implemented exactly):
 *   - Coverage flows DOWN a registered root's subtree, never up: a root covers a
 *     path when the path equals the root or sits beneath it.
 *   - Worktree inheritance follows the git worktree→main-repo LINK, not path
 *     ancestry: if the path is a linked worktree whose main repo
 *     (git.mainWorktreeRoot) is covered by a registered root, the path inherits
 *     that registration even when it lives outside the root's subtree (the
 *     orchestration sibling-worktree case).
 *   - Nearest registered root wins when registrations nest (longest matching
 *     root path).
 *   - Declines are subtree-scoped at the root that was asked; a declined root
 *     covers its subtree the same way a registered root does.
 *   - When a registered root and a declined root both cover a path, the NEARER
 *     one wins; a tie resolves to `covered` (affirmative coverage beats a
 *     remembered "no").
 */

import { resolve, sep } from 'node:path';
import type {
  DeclinedWorkspaceRecord,
  RegisteredWorkspaceRecord,
  ResolveWorkspaceInput,
  WorkspaceResolution,
} from './types.js';

/**
 * Exact-string normalization matching the agent registry: an absolute path with
 * no trailing separator (except a bare filesystem root). Registration must not
 * require the directory to exist, so this uses `resolve`, not `realpath`.
 */
export function normalizeWorkspaceRoot(root: string): string {
  const resolved = resolve(root);
  if (resolved.length > 1 && resolved.endsWith(sep)) return resolved.slice(0, -1);
  return resolved;
}

/** Does `ancestor` cover `descendant` — same path, or a directory strictly above it? */
export function pathCovers(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return descendant.startsWith(prefix);
}

/**
 * The best (nearest = longest) root among `roots` that covers `path` directly or
 * — when a main worktree root is supplied — via the worktree link. Returns the
 * matching root and whether the match was only through the link.
 */
function bestCoveringRoot(
  roots: readonly string[],
  path: string,
  mainWorktreeRoot: string | null,
): { root: string; viaWorktreeLink: boolean } | null {
  let best: { root: string; viaWorktreeLink: boolean } | null = null;
  for (const root of roots) {
    const direct = pathCovers(root, path);
    const viaLink = !direct && mainWorktreeRoot !== null && pathCovers(root, mainWorktreeRoot);
    if (!direct && !viaLink) continue;
    if (best === null || root.length > best.root.length) {
      best = { root, viaWorktreeLink: !direct };
    }
  }
  return best;
}

/**
 * Resolve a path against the registry. Pure: identical inputs always yield an
 * identical verdict.
 */
export function resolveWorkspaceRegistration(input: ResolveWorkspaceInput): WorkspaceResolution {
  const path = normalizeWorkspaceRoot(input.path);
  const mainWorktreeRoot = input.git?.mainWorktreeRoot
    ? normalizeWorkspaceRoot(input.git.mainWorktreeRoot)
    : null;

  const registeredRoots = input.registrations.map((r: RegisteredWorkspaceRecord) => r.root);
  const declinedRoots = input.declines.map((d: DeclinedWorkspaceRecord) => d.root);

  const registered = bestCoveringRoot(registeredRoots, path, mainWorktreeRoot);
  const declined = bestCoveringRoot(declinedRoots, path, mainWorktreeRoot);

  // Nearest-wins across both kinds; a tie resolves to covered.
  const registeredWins =
    registered !== null && (declined === null || registered.root.length >= declined.root.length);

  if (registeredWins && registered !== null) {
    return {
      path,
      status: 'covered',
      coveredBy: registered.root,
      declinedRoot: null,
      viaWorktreeLink: registered.viaWorktreeLink,
      reason: registered.viaWorktreeLink
        ? `inherited registration of "${registered.root}" through the git worktree link (main worktree ${mainWorktreeRoot ?? '?'})`
        : `covered by registered root "${registered.root}"`,
    };
  }

  if (declined !== null) {
    return {
      path,
      status: 'declined',
      coveredBy: null,
      declinedRoot: declined.root,
      viaWorktreeLink: declined.viaWorktreeLink,
      reason: declined.viaWorktreeLink
        ? `registration was declined at "${declined.root}" (inherited through the git worktree link)`
        : `registration was declined at "${declined.root}" (covers this subtree)`,
    };
  }

  return {
    path,
    status: 'unknown',
    coveredBy: null,
    declinedRoot: null,
    viaWorktreeLink: false,
    reason: 'no registered or declined root covers this path',
  };
}
