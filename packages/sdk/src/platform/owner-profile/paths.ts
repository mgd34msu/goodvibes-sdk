/**
 * paths.ts — where the profile lives.
 *
 * ```
 * ~/.goodvibes/daemon/owner-profile.md
 * ```
 *
 * Daemon scope, not surface scope, and resolved exactly the way every other
 * daemon-home file is (`workspace/daemon-home.ts`, `config/daemon-config-tier.ts`):
 * `--daemon-home`, then `GOODVIBES_DAEMON_HOME`, then the daemon directory under
 * the tree root — which is what `GOODVIBES_HOME` names, falling back to the
 * login home. "Exactly the way" is load-bearing: this resolver and
 * `resolveDaemonHomeDir` both used to end at a bare `homedir()`, so a process
 * running under a redirected tree root wrote its profile into the real home.
 * Both derive from the one tree-root resolution now.
 *
 * The scope matters. A fact written from the agent must be readable by the
 * daemon with every surface closed, and by the TUI tomorrow. A surface-scoped
 * profile would reproduce the failure that motivated the daemon-credential-scope
 * round: a value written successfully into a silo the daemon never reads,
 * reporting success and configuring nothing.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { DAEMON_CONFIG_ROOT } from '../config/daemon-config-tier.js';
import { resolveGoodVibesHome } from '../config/goodvibes-home.js';

/** File name of the owner profile within the daemon home. */
export const OWNER_PROFILE_FILE = 'owner-profile.md';

/** Absolute path of the profile for a given daemon home directory. */
export function ownerProfilePathForHome(daemonHomeDir: string): string {
  return join(daemonHomeDir, OWNER_PROFILE_FILE);
}

/**
 * Absolute path derived from a user home directory:
 * `<homeDir>/.goodvibes/daemon/owner-profile.md`. Callers honouring
 * `GOODVIBES_DAEMON_HOME` should use {@link resolveOwnerProfilePath} instead.
 */
export function ownerProfilePath(homeDir: string): string {
  return join(homeDir, '.goodvibes', DAEMON_CONFIG_ROOT, OWNER_PROFILE_FILE);
}

export interface OwnerProfilePathOptions {
  /**
   * `profile.path` from config. Empty means the default; a non-empty value is an
   * explicit override for a non-default daemon home and wins outright.
   */
  readonly override?: string | undefined;
  /** Value of the `--daemon-home` CLI flag, when the host parsed one. */
  readonly daemonHomeArg?: string | undefined;
  /** Override `process.env`, for tests. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Override the home directory, for tests. */
  readonly homeDir?: string | undefined;
}

/**
 * Resolve the profile path, first match wins:
 *   1. an explicit `profile.path` override
 *   2. `--daemon-home`
 *   3. `GOODVIBES_DAEMON_HOME`
 *   4. `<tree root>/.goodvibes/daemon/` — an injected `homeDir` when a caller
 *      supplied one, else the tree root `GOODVIBES_HOME` names, else the login
 *      home.
 *
 * A relative path in any of the overrides resolves against the current working
 * directory, matching `resolveDaemonHomeDir` so the two cannot disagree about
 * what a relative daemon home means.
 */
export function resolveOwnerProfilePath(options: OwnerProfilePathOptions = {}): string {
  const override = options.override?.trim();
  if (override) return absolute(override);

  const arg = options.daemonHomeArg?.trim();
  if (arg) return ownerProfilePathForHome(absolute(arg));

  const environment = options.env ?? process.env;
  const env = environment['GOODVIBES_DAEMON_HOME']?.trim();
  if (env) return ownerProfilePathForHome(absolute(env));

  return ownerProfilePath(options.homeDir ?? resolveGoodVibesHome(environment));
}

function absolute(path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}
