/**
 * shared-register-path.ts — where the workspace register lives, for every
 * product that touches it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The register is not one surface's state. Three products read and write the
 * SAME file: the SDK's gateway verb group writes it, goodvibes-agent reads and
 * writes it directly, and the daemon reads it again to decide checkpoint
 * eligibility. It sat at `~/.goodvibes/control-plane/` — the unscoped pre-split
 * orphan — which was the wrong address but at least an address all three
 * agreed on.
 *
 * Surface-scoping it (`.goodvibes/<surface root>/control-plane/`) is what the
 * rest of that directory's stores correctly did, and it is exactly wrong here:
 * it resolves to whichever product is asking, so the agent and the daemon would
 * each get their own register. Workspaces registered from one would vanish from
 * the other, and checkpoint eligibility would refuse workspaces the operator had
 * registered. That split was written once and reverted before it shipped.
 *
 * It belongs in the platform's SHARED tier — `~/.goodvibes/shared/`, which
 * already holds the cross-surface settings tier and the canonical memory store.
 * That tier is home-scoped and takes no surface root, which is the property the
 * register needs: one path, identical from every product.
 *
 * ── The read fallback, and why it is not a hack ───────────────────────────
 *
 * WRITES always go to the shared path. READS try the shared path first and fall
 * back to the legacy unscoped path, READ-ONLY, when the shared file is not there
 * yet.
 *
 * That fallback is the whole version-skew story. A machine mid-update has an
 * updated product and a not-yet-updated one running side by side:
 *
 *   - An updated product finds the state wherever it currently is — shared once
 *     the daemon's boot fold has run, legacy before that. It never sees an empty
 *     register because of the move.
 *   - A product still on the old build keeps reading and writing legacy until it
 *     updates. Its worst case is missing a registration made after the fold —
 *     it never loses one, and nothing overwrites the shared copy.
 *
 * Non-destructive in both directions, and the window is one auto-update cycle
 * because this ships as one train.
 */

/** The shared tier's directory name under `~/.goodvibes/`. */
export const SHARED_TIER_DIRECTORY = 'shared';

/** The register's file name, in both the shared tier and the legacy location. */
export const WORKSPACE_REGISTER_FILE = 'workspace-registrations.json';

/** The slice of ShellPathService these resolvers need. */
export interface WorkspaceRegisterShellPaths {
  resolveUserPath(...segments: string[]): string;
}

function requireResolved(path: string, what: string): string {
  if (!path || !path.trim()) {
    throw new Error(
      `${what}: the resolved path is empty. The workspace register is shared across products; `
      + 'an empty path would silently split it or write it somewhere nothing reads.',
    );
  }
  return path;
}

/**
 * Where the register is WRITTEN, always:
 * `<home>/.goodvibes/shared/workspace-registrations.json`.
 */
export function sharedWorkspaceRegisterPath(shellPaths: WorkspaceRegisterShellPaths): string {
  return requireResolved(
    shellPaths.resolveUserPath(SHARED_TIER_DIRECTORY, WORKSPACE_REGISTER_FILE),
    'sharedWorkspaceRegisterPath',
  );
}

/**
 * The pre-split address, kept ONLY so reads can fall back to it and so the
 * daemon's boot fold knows what to migrate. Nothing writes here any more.
 */
export function legacyWorkspaceRegisterPath(shellPaths: WorkspaceRegisterShellPaths): string {
  return requireResolved(
    shellPaths.resolveUserPath('control-plane', WORKSPACE_REGISTER_FILE),
    'legacyWorkspaceRegisterPath',
  );
}

/**
 * Where a READER should look: the shared path when it exists, the legacy one
 * otherwise. Never used to decide where to write.
 *
 * `exists` is injected so this stays pure and testable; callers pass
 * `existsSync`.
 */
export function resolveWorkspaceRegisterReadPath(
  shellPaths: WorkspaceRegisterShellPaths,
  exists: (path: string) => boolean,
): string {
  const shared = sharedWorkspaceRegisterPath(shellPaths);
  if (exists(shared)) return shared;
  const legacy = legacyWorkspaceRegisterPath(shellPaths);
  return exists(legacy) ? legacy : shared;
}
