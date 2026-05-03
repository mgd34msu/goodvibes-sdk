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
 * The daemon home is canonical. Startup creates it when absent, but does not
 * import identity state from other surfaces or workspace-scoped paths.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DaemonHomeDirs {
  /** Absolute path to the daemon home directory (immutable identity state). */
  readonly daemonHomeDir: string;
  /** True if this startup created the daemon home directory. */
  readonly freshInstall: boolean;
}

export interface DaemonHomeOptions {
  /** Value of --daemon-home CLI flag, if provided. */
  readonly daemonHomeArg?: string | undefined;
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
// Daemon home creation
// ---------------------------------------------------------------------------

/**
 * Create the daemon home directory if it does not already exist.
 *
 * Returns `freshInstall: true` when the directory was created, `false` when it
 * already existed.
 */
export function ensureDaemonHome(daemonHomeDir: string): DaemonHomeDirs {
  const alreadyExists = existsSync(daemonHomeDir);

  if (alreadyExists) {
    return { daemonHomeDir, freshInstall: false };
  }

  mkdirSync(daemonHomeDir, { recursive: true });
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
  try {
    chmodSync(tokenPath, 0o600);
  } catch (error) {
    logger.warn('daemon-home: failed to chmod operator token file after rename', {
      path: tokenPath,
      error: String(error),
    });
  }
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
  try {
    chmodSync(tmpPath, 0o600);
  } catch (error) {
    logger.warn('daemon-home: failed to chmod temporary daemon settings file', {
      path: tmpPath,
      error: String(error),
    });
  }
  renameSync(tmpPath, settingsPath);
  try {
    chmodSync(settingsPath, 0o600);
  } catch (error) {
    logger.warn('daemon-home: failed to chmod daemon settings file after rename', {
      path: settingsPath,
      error: String(error),
    });
  }
}
