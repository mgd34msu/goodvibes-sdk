/**
 * daemon-home.ts
 *
 * Resolves and manages the daemon's identity home directory (`daemon.homeDir`).
 *
 * The daemon home holds immutable-after-startup identity state:
 *   - auth-users.json
 *   - auth-bootstrap.txt
 *   - daemon-settings.json
 *   - operator-tokens.json
 *
 * Resolution order (first match wins):
 *   1. --daemon-home=<path> CLI arg (passed as daemonHomeArg)
 *   2. GOODVIBES_DAEMON_HOME environment variable
 *   3. ~/.goodvibes/daemon/
 *
 * One-time migration (run on first 0.21.19+ startup):
 *   - If ~/.goodvibes/daemon/ does not exist:
 *     - ~/.goodvibes/tui/auth-users.json → ~/.goodvibes/daemon/auth-users.json
 *     - ~/.goodvibes/tui/auth-bootstrap.txt → ~/.goodvibes/daemon/auth-bootstrap.txt
 *     - <cwd>/.goodvibes/operator-tokens.json → ~/.goodvibes/daemon/operator-tokens.json (F3 revision)
 *   - Old paths are left intact (never deleted) to avoid breaking older binaries.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonHomeDirs {
  /** Absolute path to the daemon home directory (immutable identity state). */
  readonly daemonHomeDir: string;
  /** True if this is the first startup at this daemon home (migration was run). */
  readonly freshInstall: boolean;
}

export interface DaemonHomeOptions {
  /** Value of --daemon-home CLI flag, if provided. */
  readonly daemonHomeArg?: string | undefined;
  /** Current working directory, used as base for operator-tokens migration. */
  readonly cwd?: string;
  /** Override process.env for testing. */
  readonly env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon home directory from CLI flag, environment variable, or default.
 */
export function resolveDaemonHomeDir(options: DaemonHomeOptions = {}): string {
  const env = options.env ?? process.env;

  // 1. CLI arg
  if (options.daemonHomeArg) {
    const p = options.daemonHomeArg.trim();
    if (p) return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  }

  // 2. Env var
  const envVal = env['GOODVIBES_DAEMON_HOME']?.trim();
  if (envVal) {
    return isAbsolute(envVal) ? resolve(envVal) : resolve(process.cwd(), envVal);
  }

  // 3. Default: ~/.goodvibes/daemon/
  return join(homedir(), '.goodvibes', 'daemon');
}

// ---------------------------------------------------------------------------
// One-time migration
// ---------------------------------------------------------------------------

/**
 * Run migration if the daemon home directory does not yet exist.
 * Creates the directory and copies identity files from legacy paths if found.
 * Old files are NOT deleted.
 *
 * Returns `freshInstall: true` when migration ran, `false` when the dir already existed.
 */
export function runDaemonHomeMigration(
  daemonHomeDir: string,
  options: DaemonHomeOptions = {},
): DaemonHomeDirs {
  const alreadyExists = existsSync(daemonHomeDir);

  if (alreadyExists) {
    return { daemonHomeDir, freshInstall: false };
  }

  // Create the daemon home directory tree
  mkdirSync(join(daemonHomeDir), { recursive: true });

  const userGoodVibesRoot = join(homedir(), '.goodvibes');
  const cwd = options.cwd ?? process.cwd();

  // Migrate auth-users.json from tui surface path
  const legacyAuthUsers = join(userGoodVibesRoot, 'tui', 'auth-users.json');
  if (existsSync(legacyAuthUsers)) {
    safeCopy(legacyAuthUsers, join(daemonHomeDir, 'auth-users.json'));
  }

  // Migrate auth-bootstrap.txt from tui surface path
  const legacyBootstrap = join(userGoodVibesRoot, 'tui', 'auth-bootstrap.txt');
  if (existsSync(legacyBootstrap)) {
    safeCopy(legacyBootstrap, join(daemonHomeDir, 'auth-bootstrap.txt'));
  }

  // Migrate operator-tokens.json from workspace-scoped path (F3 revision):
  // 0.21.17 moved tokens to <cwd>/.goodvibes/operator-tokens.json.
  // 0.21.19 re-homes them to daemon home so workspace swaps don't invalidate tokens.
  const legacyWorkspaceTokens = join(cwd, '.goodvibes', 'operator-tokens.json');
  if (existsSync(legacyWorkspaceTokens)) {
    safeCopy(legacyWorkspaceTokens, join(daemonHomeDir, 'operator-tokens.json'));
  }

  return { daemonHomeDir, freshInstall: true };
}

// ---------------------------------------------------------------------------
// Daemon settings persistence
// ---------------------------------------------------------------------------

/**
 * Read a single key from daemon-settings.json, or return undefined if missing.
 */
export function readDaemonSetting(daemonHomeDir: string, key: string): string | undefined {
  const settingsPath = join(daemonHomeDir, 'daemon-settings.json');
  if (!existsSync(settingsPath)) return undefined;
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const val = parsed[key];
    return typeof val === 'string' ? val : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a single key into daemon-settings.json (merge, not replace).
 */
export function writeDaemonSetting(daemonHomeDir: string, key: string, value: string): void {
  mkdirSync(daemonHomeDir, { recursive: true });
  const settingsPath = join(daemonHomeDir, 'daemon-settings.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Overwrite corrupt file
    }
  }
  writeFileSync(settingsPath, JSON.stringify({ ...existing, [key]: value }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeCopy(src: string, dest: string): void {
  try {
    copyFileSync(src, dest);
  } catch {
    // Best-effort — never block startup due to a copy failure
  }
}
