/**
 * secrets-store-paths.ts, where a secret physically lives, per scope.
 *
 * Three tiers, and the difference between them is a real directory rather than
 * a label:
 *
 *   project, `<root>/.goodvibes/<surface>/secrets.enc`, walked up the ancestor
 *             chain nearest-first. A credential that belongs to one checkout.
 *
 *   user   , `<home>/.goodvibes/<surface>/secrets.enc`. This operator's own
 *             credential, on this machine, for this surface.
 *
 *   daemon , `<daemonHome>/secrets.enc`, defaulting to
 *             `~/.goodvibes/daemon/secrets.enc`: the same directory that already
 *             holds `settings.json`, `operator-tokens.json` and the rest of the
 *             daemon's own state (see daemon-config-tier.ts). Deliberately NOT
 *             surface-scoped, the daemon is one process whichever product
 *             launched it, so a credential it executes with has exactly one
 *             home, and the TUI, the agent and the web UI all read that one.
 *
 * Read order puts the daemon tier FIRST among the file stores, which is the
 * secret-store form of the rule daemon-config-tier.ts already states for
 * settings: a stale copy left behind in a surface silo must never beat the
 * daemon's own. The tier is opt-in and empty until something writes to it
 * explicitly, so this changes nothing for a store that has no daemon secrets.
 * The environment still wins over all three.
 */

import { dirname, join, resolve } from 'node:path';
import { DAEMON_CONFIG_ROOT } from './daemon-config-tier.js';
import {
  resolveSharedDirectory,
  resolveSurfaceDirectory,
  resolveSurfaceSharedFile,
} from '../runtime/surface-root.js';

/** Which tier owns a stored secret. */
export type SecretScope = 'project' | 'user' | 'daemon';

/** Whether a store is encrypted at rest. */
export type SecretStorageMedium = 'secure' | 'plaintext';

/** Where a resolved secret was read from. */
export type SecretSource =
  | 'env'
  | 'project-secure'
  | 'project-plaintext'
  | 'user-secure'
  | 'user-plaintext'
  | 'daemon-secure'
  | 'daemon-plaintext';

/** One store file, with the tier and medium it represents. */
export interface SecretStorePath {
  readonly source: Exclude<SecretSource, 'env'>;
  readonly path: string;
  readonly secure: boolean;
  readonly scope: SecretScope;
}

/** The roots and explicit overrides the path builders need. */
export interface SecretStoreLayout {
  readonly projectRoot: string;
  readonly globalHome: string;
  readonly daemonHome: string;
  readonly surfaceRoot: string;
  readonly secureProjectFilePath?: string | undefined;
  readonly secureUserFilePath?: string | undefined;
  readonly secureDaemonFilePath?: string | undefined;
  readonly plaintextProjectFilePath?: string | undefined;
  readonly plaintextUserFilePath?: string | undefined;
  readonly plaintextDaemonFilePath?: string | undefined;
}

/** The daemon's state root under a user home: `<home>/.goodvibes/daemon`. */
export function defaultDaemonSecretHome(globalHome: string): string {
  return resolveSharedDirectory(globalHome, DAEMON_CONFIG_ROOT);
}

/**
 * Deduplicate by FILE, not by (tier, file).
 *
 * A project root inside the home directory, `~/Projects/thing` under `~`, has
 * the home among its ancestors, so `<home>/.goodvibes/<surface>/secrets.enc`
 * is produced once as a project store (from the ancestor walk) and again as the
 * user store. One physical file, two entries.
 *
 * Keying on `source:path` kept both, because the sources differ. Reading twice
 * is harmless; ENUMERATING twice is not, the credential migration walks these
 * stores, so one credential was processed and receipted as two, in two tiers,
 * one of which does not exist. Whichever entry comes first wins, which
 * preserves the existing precedence exactly.
 */
function uniquePaths(paths: readonly SecretStorePath[]): SecretStorePath[] {
  const seen = new Set<string>();
  const ordered: SecretStorePath[] = [];
  for (const path of paths) {
    if (seen.has(path.path)) continue;
    seen.add(path.path);
    ordered.push(path);
  }
  return ordered;
}

function collectAncestorRoots(start: string): string[] {
  const roots: string[] = [];
  let current = resolve(start);
  while (true) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function daemonStore(layout: SecretStoreLayout, medium: SecretStorageMedium): SecretStorePath {
  return medium === 'secure'
    ? {
      source: 'daemon-secure',
      path: layout.secureDaemonFilePath ?? join(layout.daemonHome, 'secrets.enc'),
      secure: true,
      scope: 'daemon',
    }
    : {
      source: 'daemon-plaintext',
      path: layout.plaintextDaemonFilePath ?? join(layout.daemonHome, 'secrets.json'),
      secure: false,
      scope: 'daemon',
    };
}

function userStore(layout: SecretStoreLayout, medium: SecretStorageMedium): SecretStorePath {
  return medium === 'secure'
    ? {
      source: 'user-secure',
      path: layout.secureUserFilePath ?? resolveSurfaceDirectory(layout.globalHome, layout.surfaceRoot, 'secrets.enc'),
      secure: true,
      scope: 'user',
    }
    : {
      source: 'user-plaintext',
      path: layout.plaintextUserFilePath
        ?? resolveSurfaceSharedFile(layout.globalHome, `${layout.surfaceRoot}.secrets`, 'json'),
      secure: false,
      scope: 'user',
    };
}

function projectStore(layout: SecretStoreLayout, root: string, medium: SecretStorageMedium): SecretStorePath {
  return medium === 'secure'
    ? {
      source: 'project-secure',
      path: layout.secureProjectFilePath ?? resolveSurfaceDirectory(root, layout.surfaceRoot, 'secrets.enc'),
      secure: true,
      scope: 'project',
    }
    : {
      source: 'project-plaintext',
      path: layout.plaintextProjectFilePath ?? resolveSurfaceSharedFile(root, `${layout.surfaceRoot}.secrets`, 'json'),
      secure: false,
      scope: 'project',
    };
}

/**
 * Every OTHER surface's user-tier store under this home.
 *
 * `secretReadOrder` walks one surface root, this manager's own, which is
 * right for resolution: the agent has no business resolving a credential out of
 * the TUI's silo at read time, and a daemon that did would be reading a value
 * nobody asked it to.
 *
 * Migration is the exception, and the owner's machine is why. Their Telegram
 * token sat in `~/.goodvibes/agent/secrets.enc` while the daemon booted rooted
 * at `daemon` and enumerated only its own store. The credential was one
 * directory away, readable, and invisible to the only code that could have
 * lifted it, so it was never lifted by anything, ever.
 *
 * Discovered by listing `<home>/.goodvibes/` rather than from a list of known
 * surface names: a product the SDK has never heard of still leaves its store
 * there, and a hand-maintained list is the thing that goes stale. Entries
 * holding no store are skipped, so every path returned exists.
 */
export function siblingSurfaceSecretStores(
  layout: SecretStoreLayout,
  listDirectory: (path: string) => readonly string[],
  fileExists: (path: string) => boolean,
): SecretStorePath[] {
  const root = join(layout.globalHome, '.goodvibes');
  let entries: readonly string[];
  try {
    entries = listDirectory(root);
  } catch {
    return [];
  }

  const stores: SecretStorePath[] = [];
  const seenSurfaces = new Set<string>();
  for (const entry of entries) {
    // The two tiers do not share a layout, and assuming they did is how this
    // first shipped looking in the wrong place for half of them:
    //   secure    -> <home>/.goodvibes/<surface>/secrets.enc   (a directory)
    //   plaintext -> <home>/.goodvibes/<surface>.secrets.json  (a sibling FILE)
    // So the surface name is recovered from either shape, then both candidate
    // paths are probed.
    const surface = entry.endsWith('.secrets.json') ? entry.slice(0, -'.secrets.json'.length) : entry;
    if (!surface || surface === DAEMON_CONFIG_ROOT || surface === layout.surfaceRoot) continue;
    if (seenSurfaces.has(surface)) continue;
    seenSurfaces.add(surface);

    const secure = join(root, surface, 'secrets.enc');
    if (fileExists(secure)) {
      stores.push({ source: 'user-secure', path: secure, secure: true, scope: 'user' });
    }
    const plaintext = join(root, `${surface}.secrets.json`);
    if (fileExists(plaintext)) {
      stores.push({ source: 'user-plaintext', path: plaintext, secure: false, scope: 'user' });
    }
  }
  return stores;
}

/**
 * The stores a lookup consults, in the order it consults them. First match
 * wins, so the daemon tier leads: see the header for why.
 */
export function secretReadOrder(layout: SecretStoreLayout, includePlaintext: boolean): SecretStorePath[] {
  const ordered: SecretStorePath[] = [daemonStore(layout, 'secure')];
  if (includePlaintext) ordered.push(daemonStore(layout, 'plaintext'));

  for (const root of collectAncestorRoots(layout.projectRoot)) {
    ordered.push(projectStore(layout, root, 'secure'));
    if (includePlaintext) ordered.push(projectStore(layout, root, 'plaintext'));
  }

  ordered.push(userStore(layout, 'secure'));
  if (includePlaintext) ordered.push(userStore(layout, 'plaintext'));
  return uniquePaths(ordered);
}

/** Every store this manager could touch, policy aside. Used by delete/inspect. */
export function allSecretStores(layout: SecretStoreLayout): SecretStorePath[] {
  const ordered: SecretStorePath[] = [daemonStore(layout, 'secure'), daemonStore(layout, 'plaintext')];
  for (const root of collectAncestorRoots(layout.projectRoot)) {
    ordered.push(projectStore(layout, root, 'secure'), projectStore(layout, root, 'plaintext'));
  }
  ordered.push(userStore(layout, 'secure'), userStore(layout, 'plaintext'));
  return uniquePaths(ordered);
}

/** The single store a write of `scope`/`medium` lands in. */
export function secretWriteTarget(
  layout: SecretStoreLayout,
  scope: SecretScope,
  medium: SecretStorageMedium,
): SecretStorePath {
  if (scope === 'daemon') return daemonStore(layout, medium);
  if (scope === 'project') return projectStore(layout, layout.projectRoot, medium);
  return userStore(layout, medium);
}
