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
 *   - Operator tokens are global-only: read/written exclusively at
 *     <daemonHomeDir>/operator-tokens.json. No workspace-scoped paths.
 *   - Old paths are left intact (never deleted) to avoid breaking older binaries.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import type { WorkspaceEvent } from '../runtime/events/workspace.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../runtime/events/index.js';
import { createEventEnvelope } from '../runtime/events/index.js';

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
  /** Override process.env for testing. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Optional dependencies for migration event emission.
 * When provided, migration outcomes are broadcast on the runtime event bus
 * under the 'workspace' domain.
 */
export interface DaemonHomeMigrationDeps {
  readonly runtimeBus?: RuntimeEventBus;
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
// Global operator token path
// ---------------------------------------------------------------------------

/**
 * Returns the single canonical path for operator tokens.
 * All reads and writes MUST use this path. No workspace-scoped fallback exists.
 */
export function resolveOperatorTokenPath(daemonHomeDir: string): string {
  return join(daemonHomeDir, 'operator-tokens.json');
}

// ---------------------------------------------------------------------------
// One-time migration
// ---------------------------------------------------------------------------

/**
 * Run migration if the daemon home directory does not yet exist.
 * Creates the directory and copies identity files from legacy paths if found.
 * Old files are NOT deleted.
 *
 * Operator tokens are NOT migrated from workspace-scoped paths — the global
 * daemon-home path is canonical since 0.21.28. If tokens are missing,
 * the first pairing operation will create them at the global path.
 *
 * Returns `freshInstall: true` when migration ran, `false` when the dir already existed.
 */
export function runDaemonHomeMigration(
  daemonHomeDir: string,
  options: DaemonHomeOptions = {},
  deps: DaemonHomeMigrationDeps = {},
): DaemonHomeDirs {
  const alreadyExists = existsSync(daemonHomeDir);

  if (alreadyExists) {
    return { daemonHomeDir, freshInstall: false };
  }

  // Create the daemon home directory tree
  mkdirSync(daemonHomeDir, { recursive: true });

  const userGoodVibesRoot = join(homedir(), '.goodvibes');

  // Migrate auth-users.json from tui surface path
  // SEC-02: credential-bearing files must land at 0600 regardless of source perms.
  const legacyAuthUsers = join(userGoodVibesRoot, 'tui', 'auth-users.json');
  if (existsSync(legacyAuthUsers)) {
    safeCopyIdentity(legacyAuthUsers, join(daemonHomeDir, 'auth-users.json'));
  }

  // Migrate auth-bootstrap.txt from tui surface path
  const legacyBootstrap = join(userGoodVibesRoot, 'tui', 'auth-bootstrap.txt');
  if (existsSync(legacyBootstrap)) {
    safeCopyIdentity(legacyBootstrap, join(daemonHomeDir, 'auth-bootstrap.txt'));
  }

  // NOTE: Operator tokens are NOT migrated from legacy workspace-scoped paths.
  // The canonical path is <daemonHomeDir>/operator-tokens.json (global, set at 0600).
  // If no token file exists at the canonical path, the first pairing call will
  // create it via getOrCreateCompanionToken (companion-token.ts).
  void deps; // deps.runtimeBus reserved for future migration event emission

  return { daemonHomeDir, freshInstall: true };
}

// ---------------------------------------------------------------------------
// Operator token file write (global-only, mode 0600)
// ---------------------------------------------------------------------------

/**
 * Write operator tokens to the global daemon-home path with mode 0600.
 * All token provisioning MUST go through this function.
 *
 * Uses a write-to-tmp-then-rename pattern for atomicity.
 * Applies chmod 0600 after rename so the file is never world-readable.
 */
export function writeOperatorTokenFile(daemonHomeDir: string, content: string): void {
  const tokenPath = resolveOperatorTokenPath(daemonHomeDir);
  mkdirSync(dirname(tokenPath), { recursive: true });
  const tmpPath = tokenPath + '.tmp';
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, tokenPath);
  // Apply chmod again after rename — some filesystems reset permissions on rename
  try { chmodSync(tokenPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Read operator tokens from the global daemon-home path.
 * Returns undefined when the file does not exist or cannot be parsed.
 */
export function readOperatorTokenFile(daemonHomeDir: string): string | undefined {
  const tokenPath = resolveOperatorTokenPath(daemonHomeDir);
  if (!existsSync(tokenPath)) return undefined;
  try {
    return readFileSync(tokenPath, 'utf-8');
  } catch {
    return undefined;
  }
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
 *
 * Uses a write-to-tmp-then-rename pattern for atomicity:
 * a crash between write and rename leaves a .tmp file, never a corrupt target.
 */
export function writeDaemonSetting(daemonHomeDir: string, key: string, value: string): void {
  mkdirSync(daemonHomeDir, { recursive: true });
  const settingsPath = join(daemonHomeDir, 'daemon-settings.json');
  const tmpPath = settingsPath + '.tmp';
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch (err: unknown) {
      // OBS-11: Overwrite corrupt file; log so ops can see when this happens
      logger.warn('[DaemonHome] daemon-settings.json parse failed — overwriting with fresh state', {
        path: settingsPath,
        error: String(err),
      });
    }
  }
  // SEC-12: daemon-settings.json may contain sensitive pairing state; write at 0600.
  writeFileSync(tmpPath, JSON.stringify({ ...existing, [key]: value }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
  renameSync(tmpPath, settingsPath);
  try { chmodSync(settingsPath, 0o600); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Copy src to dest. Returns true on success, false on failure.
 * Failures are logged at warn level. Never throws.
 */
function safeCopy(src: string, dest: string): boolean {
  try {
    copyFileSync(src, dest);
    return true;
  } catch (err) {
    logger.warn('daemon-home: safeCopy failed', {
      src,
      dest,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Copy a credential-bearing identity file from src to dest and force mode 0600.
 *
 * SEC-02: `copyFileSync` preserves source permissions. Legacy TUI files may be
 * 0644 (world-readable). Calling `chmodSync` after copy ensures the new
 * canonical path is always owner-only regardless of the source's permissions.
 * Never throws — failures are logged at warn level.
 */
function safeCopyIdentity(src: string, dest: string): boolean {
  if (!safeCopy(src, dest)) return false;
  try {
    chmodSync(dest, 0o600);
  } catch (err) {
    logger.warn('daemon-home: safeCopyIdentity chmod failed (best-effort)', {
      dest,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
