/**
 * install-kind.ts, how a running process was installed, decided from its own
 * executable path rather than assumed, and what command replaces an in-place
 * swap for each kind.
 *
 * `platform/runtime/self-update` owns the swap itself. This is the question the
 * swap has to answer first: is this install ours to replace, or someone else's?
 */

/**
 * How this running process was installed:
 *   - "binary": a standalone `bun build --compile` executable with no
 *     package-manager ancestry, the suite installer's install path. Swappable
 *     in place.
 *   - "bun-global-package": the vendored binary shipped inside an npm/bun-managed
 *     package install (execPath contains a `node_modules` path segment, true
 *     for both a global add and a local project dependency). Managed by the
 *     package manager; swapping the vendored file in place would fight the next
 *     upgrade, so this is never swapped, the user re-runs their package manager.
 *   - "source": running directly via the `bun` interpreter, not a compiled
 *     binary at all.
 */
export type InstallKind = 'binary' | 'bun-global-package' | 'source';

export function detectInstallKind(execPath: string): InstallKind {
  const segments = execPath.split(/[\\/]/);
  const execName = (segments[segments.length - 1] ?? '').toLowerCase();
  if (execName === 'bun' || execName === 'bun.exe') {
    return 'source';
  }
  if (segments.includes('node_modules')) {
    return 'bun-global-package';
  }
  return 'binary';
}

/** The installer command a standalone-binary install is brought up to date with. */
export const BINARY_INSTALL_COMMAND = 'curl -fsSL https://goodvibes.sh/install.sh | sh';

/**
 * The exact command to tell the user to run instead of an in-place swap.
 *
 * A package-managed install is updated through the package manager, which needs
 * the PACKAGE name, and that is the calling product's own, not something this
 * module can know. Pass it; the source-run case ignores it and points at the
 * installer, because a source checkout has no package to upgrade.
 */
export function fallbackUpdateCommand(kind: Exclude<InstallKind, 'binary'>, packageName: string): string {
  if (kind === 'bun-global-package') {
    return `bun add -g ${packageName}`;
  }
  return BINARY_INSTALL_COMMAND;
}
