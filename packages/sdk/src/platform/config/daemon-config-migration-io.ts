/**
 * daemon-config-migration-io.ts, disk primitives and disclosure shapes for the
 * one-time move of daemon-owned keys into the daemon's own config store.
 *
 * Split from daemon-config-migration.ts so the migration policy (what wins,
 * what is disclosed) stays readable and both halves stay under the line cap.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** File name of the disclosure marker written beside the daemon config store. */
export const DAEMON_CONFIG_MOVED_FILE = 'config-moved.json';

/** Marker schema version. A marker at any other version is re-migrated. */
export const DAEMON_CONFIG_MOVED_VERSION = 1;

/** One daemon-owned key that changed home, and where it came from. */
export interface MovedConfigKey {
  readonly key: string;
  readonly from: string;
}

/** A value that was NOT kept, disclosed rather than silently dropped. */
export interface DiscardedConfigKey {
  readonly key: string;
  readonly from: string;
  /** Redacted when the key names a credential; otherwise the literal value. */
  readonly value: unknown;
  /** 'conflict', a different value already won; 'duplicate', same value. */
  readonly reason: 'conflict' | 'duplicate';
  /** Which store's value won, so the discard is auditable. */
  readonly supersededBy: string;
}

/**
 * The disclosure marker. Shaped after the existing `checkpoints-moved.json`
 * (movedTo / date) and extended with the per-key ledger this migration owes the
 * user. `status` exists so a crash mid-migration leaves a marker that is
 * explicitly incomplete rather than one that merely looks finished.
 */
export interface DaemonConfigMovedMarker {
  readonly version: number;
  readonly status: 'in-progress' | 'complete';
  readonly movedTo: string;
  readonly primarySurface: string;
  readonly date: string;
  readonly sources: readonly string[];
  readonly moved: readonly MovedConfigKey[];
  readonly discarded: readonly DiscardedConfigKey[];
  /**
   * Every key that was daemon-owned when this marker was written, not just the
   * ones that had a value to move.
   *
   * This is what makes the migration RE-RUNNABLE as ownership grows. A key
   * promoted to daemon-owned in a later release (conversationGate.* was exactly
   * this case) would otherwise never migrate: the marker said "complete" and
   * short-circuited the whole run, leaving the operator's existing value
   * stranded in a client file that the daemon does not read. The marker now
   * records the covered set, and a run whose owned set has grown migrates the
   * newcomers instead of declaring victory.
   *
   * Absent on a marker written before this field existed, which is treated as
   * "covers nothing" so those installations get one corrective pass.
   */
  readonly coveredKeys: readonly string[];
}

/** Absolute path of the disclosure marker for a daemon config store. */
export function daemonConfigMovedPath(daemonConfigStorePath: string): string {
  return join(dirname(daemonConfigStorePath), DAEMON_CONFIG_MOVED_FILE);
}

/**
 * Read and VALIDATE the marker by parsing it. Never `existsSync`, a torn or
 * truncated marker has already stranded user data once in this codebase, and a
 * file that exists but does not parse into a complete ledger must count as "not
 * migrated" so the migration runs again.
 *
 * Returns the marker only when it parses, is at the current version, and is
 * marked complete. Anything else (missing, unparseable, wrong version,
 * in-progress, wrong shape) returns null.
 */
export function readDaemonConfigMovedMarker(path: string): DaemonConfigMovedMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== DAEMON_CONFIG_MOVED_VERSION) return null;
  if (record['status'] !== 'complete') return null;
  const movedTo = record['movedTo'];
  if (typeof movedTo !== 'string' || movedTo.trim().length === 0) return null;
  if (!Array.isArray(record['moved']) || !Array.isArray(record['discarded'])) return null;
  if (!Array.isArray(record['sources'])) return null;
  return {
    version: DAEMON_CONFIG_MOVED_VERSION,
    status: 'complete',
    movedTo,
    primarySurface: typeof record['primarySurface'] === 'string' ? record['primarySurface'] : '',
    date: typeof record['date'] === 'string' ? record['date'] : '',
    sources: record['sources'] as readonly string[],
    moved: record['moved'] as readonly MovedConfigKey[],
    discarded: record['discarded'] as readonly DiscardedConfigKey[],
    // A marker written before this field existed covers nothing, so the next
    // run migrates the full owned set rather than trusting an unknown scope.
    coveredKeys: Array.isArray(record['coveredKeys'])
      ? (record['coveredKeys'] as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/**
 * Read a marker regardless of status, used to carry an interrupted run's
 * already-recorded ledger forward so a crash never erases the disclosure of
 * what a previous attempt moved.
 */
export function readAnyDaemonConfigMovedMarker(path: string): Partial<DaemonConfigMovedMarker> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Partial<DaemonConfigMovedMarker>;
  } catch {
    return null;
  }
}

/** Write JSON atomically (temp file + rename) so no reader ever sees a torn file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** Parse a settings JSON file; a missing file reads as {}, an invalid one throws. */
export function readSettingsFileStrict(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file is not a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Every surface settings store under `<homeDir>/.goodvibes/`, excluding the
 * daemon's own root and the surface-independent shared tier. Returns absolute
 * paths in a stable (alphabetical) order so a migration is deterministic.
 */
export function discoverSurfaceSettingsFiles(
  homeDir: string,
  exclude: readonly string[] = ['daemon', 'shared'],
): readonly { surface: string; path: string }[] {
  const root = join(homeDir, '.goodvibes');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const excluded = new Set(exclude);
  const found: { surface: string; path: string }[] = [];
  for (const entry of entries.sort()) {
    if (excluded.has(entry)) continue;
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const settings = join(dir, 'settings.json');
    if (existsSync(settings)) found.push({ surface: entry, path: settings });
  }
  return found;
}

const SECRETISH_LEAF = /(token|secret|password|passphrase|apikey|credential)/i;

/**
 * Redact a disclosed value when the key names a credential. A
 * `goodvibes://secrets/...` reference is not itself a secret, so it is shown
 * intact, that is exactly the detail a user needs to see when two stores
 * pointed at DIFFERENT secret names, which is what happened here.
 */
export function discloseValue(key: string, value: unknown): unknown {
  const leaf = key.split('.').pop() ?? key;
  if (!SECRETISH_LEAF.test(leaf)) return value;
  if (typeof value !== 'string') return value === '' ? value : '[redacted]';
  if (value === '') return '';
  if (value.startsWith('goodvibes://secrets/')) return value;
  return '[redacted]';
}
