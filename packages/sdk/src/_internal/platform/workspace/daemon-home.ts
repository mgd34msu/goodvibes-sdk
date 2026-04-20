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

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
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
  /** Current working directory, used as base for operator-tokens migration. */
  readonly cwd?: string;
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
  deps: DaemonHomeMigrationDeps = {},
): DaemonHomeDirs {
  const alreadyExists = existsSync(daemonHomeDir);

  if (alreadyExists) {
    return { daemonHomeDir, freshInstall: false };
  }

  // Create the daemon home directory tree
  mkdirSync(daemonHomeDir, { recursive: true });

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

  // Migrate operator-tokens.json — search multiple legacy paths (F3 revision).
  // 0.21.17 used <cwd>/.goodvibes/operator-tokens.json (workspace-scoped).
  // 0.21.16 and earlier used surface-scoped ~/.goodvibes/<surface>/companion-token.json.
  // 0.21.19+ canonical path is <daemonHomeDir>/operator-tokens.json.
  const destTokenPath = join(daemonHomeDir, 'operator-tokens.json');
  if (!existsSync(destTokenPath)) {
    // Priority 1: workspace-scoped path from 0.21.17
    const legacyWorkspaceTokens = join(cwd, '.goodvibes', 'operator-tokens.json');
    // Priority 2: surface-scoped legacy tokens from 0.21.16 and earlier
    const legacySurfaceToken = join(userGoodVibesRoot, 'tui', 'companion-token.json');
    // Priority 3: XDG data home if set
    const xdgDataHome = options.env?.['XDG_DATA_HOME'];
    const xdgToken = xdgDataHome ? join(xdgDataHome, 'goodvibes', 'operator-tokens.json') : null;

    // Scan for any surface-scoped companion-token.json files under ~/.goodvibes/
    const surfaceScopedTokens: string[] = [];
    try {
      const entries = readdirSync(userGoodVibesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const candidate = join(userGoodVibesRoot, entry.name, 'companion-token.json');
          if (existsSync(candidate)) surfaceScopedTokens.push(candidate);
        }
      }
    } catch {
      // Best-effort scan
    }

    const tokenSources = [
      legacyWorkspaceTokens,
      ...(xdgToken ? [xdgToken] : []),
      legacySurfaceToken,
      ...surfaceScopedTokens,
    ];

    for (const src of tokenSources) {
      if (!existsSync(src)) continue;
      // Validate JSON before copying — corrupt JSON must not be migrated.
      try {
        JSON.parse(readFileSync(src, 'utf-8'));
      } catch (parseErr) {
        const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
        logger.warn('daemon-home: skipping corrupt token file during migration', {
          sourcePath: src,
          reason,
        });
        _emitMigrationEvent(deps.runtimeBus, { type: 'WORKSPACE_IDENTITY_MIGRATION_FAILED', sourcePath: src, reason });
        safeCopy(src, destTokenPath, { skipIfInvalid: true });
        continue;
      }
      if (safeCopy(src, destTokenPath)) {
        logger.info('daemon-home: migrated operator token', { from: src, to: destTokenPath });
        _emitMigrationEvent(deps.runtimeBus, { type: 'WORKSPACE_IDENTITY_MIGRATED', from: src, to: destTokenPath });
      }
      break; // First valid source wins
    }
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
    } catch {
      // Overwrite corrupt file
    }
  }
  writeFileSync(tmpPath, JSON.stringify({ ...existing, [key]: value }, null, 2), 'utf-8');
  renameSync(tmpPath, settingsPath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a workspace migration event on the runtime bus.
 * Never throws — bus emission must not interrupt migration.
 */
function _emitMigrationEvent(
  bus: RuntimeEventBus | undefined,
  payload:
    | { type: 'WORKSPACE_IDENTITY_MIGRATED'; from: string; to: string }
    | { type: 'WORKSPACE_IDENTITY_MIGRATION_FAILED'; sourcePath: string; reason: string },
): void {
  if (!bus) return;
  try {
    const envelope = createEventEnvelope(
      payload.type,
      payload,
      { sessionId: '', source: 'daemon-home-migration' },
    );
    bus.emit<'workspace'>(
      'workspace',
      // WorkspaceEvent discriminated-union member; single widening cast is safe.
      envelope as RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>,
    );
  } catch {
    // Swallow — never let event emission break migration
  }
}

/**
 * Copy src to dest. Returns true on success, false on failure.
 * Failures are logged at warn level. Never throws.
 */
function safeCopy(src: string, dest: string, opts?: { skipIfInvalid?: boolean }): boolean {
  if (opts?.skipIfInvalid) return false;
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
