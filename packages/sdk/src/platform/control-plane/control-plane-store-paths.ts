/**
 * control-plane-store-paths.ts
 *
 * The one resolver every control-plane store file path goes through.
 *
 * `ShellPathService.resolveUserPath(...segments)` (platform/runtime/shell-
 * paths.ts) never adds a surface segment on its own — the segment is always
 * the CALLER's to pass. A set of control-plane stores (workspace
 * registrations, principals, channel profiles, channel sync, check-in
 * receipts, tailscale serve receipts, CI watches, occasions state, push
 * subscriptions, pairing tokens) called `resolveUserPath('control-plane',
 * file)` directly and forgot it, so every one of them wrote to
 * `~/.goodvibes/control-plane/` while every other daemon-owned store sits
 * under the surface-scoped `~/.goodvibes/<surfaceRoot>/control-plane/`. That
 * unscoped directory is the pre-split orphan a missing segment produces —
 * `~/.goodvibes/control-plane/` on a real machine held live, unread state
 * (occasions-state.json, workspace-registrations.json) that nothing serving
 * the scoped path ever saw.
 *
 * Calling `resolveUserPath` directly at each control-plane call site is how
 * the next one drifts the same way: nothing forces the surface segment to be
 * there, so a new store is one omitted argument away from writing to the same
 * orphan directory. Routing every one of them through this single function
 * instead makes the omission a compile error (`surfaceRoot` is required, not
 * optional-with-a-default — a default is exactly what let this happen) rather
 * than a silent divergence discovered on a live machine.
 */

/** The slice of ShellPathService this resolver needs. */
export interface ControlPlaneStorePathShellPaths {
  resolveUserPath(...segments: string[]): string;
}

/**
 * Resolve a control-plane store's file path under the given surface root:
 * `<home>/.goodvibes/<surfaceRoot>/control-plane/<file>`.
 *
 * `surfaceRoot` is REQUIRED. A blank or whitespace-only value throws rather
 * than silently falling through to the unscoped `resolveUserPath('control-
 * plane', file)` path — an empty segment reproduces the exact defect this
 * function exists to end, and it would do so silently, which is worse than
 * the original bug: at least the original wrote to a directory that existed
 * and someone eventually noticed.
 */
export function controlPlaneStorePath(
  shellPaths: ControlPlaneStorePathShellPaths,
  surfaceRoot: string,
  file: string,
): string {
  if (!surfaceRoot || !surfaceRoot.trim()) {
    throw new Error(
      `controlPlaneStorePath: surfaceRoot must be a non-empty string (got ${JSON.stringify(surfaceRoot)}). `
      + "A blank surface segment would resolve to the unscoped '~/.goodvibes/control-plane/' orphan directory.",
    );
  }
  return shellPaths.resolveUserPath(surfaceRoot, 'control-plane', file);
}
