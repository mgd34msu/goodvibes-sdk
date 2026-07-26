/**
 * daemon-config-tier.ts — the daemon's own config store.
 *
 * Every daemon-owned key (see config-ownership.ts) lives in exactly one file,
 * `<daemonHome>/settings.json`, which defaults to `~/.goodvibes/daemon/
 * settings.json` — the same directory that already holds the daemon's identity
 * state (operator-tokens.json, detached-daemon.json). One writer, one reader of
 * record, therefore nothing to sync and nothing to drift.
 *
 * The old arrangement put these keys in `~/.goodvibes/tui/settings.json` for no
 * reason other than the daemon binary being the TUI binary, so every other
 * product had to know that "tui" secretly meant "daemon". It no longer does.
 *
 * Resolution order for a daemon-owned key: defaults < global surface < project
 * surface < shared tier < DAEMON TIER < CLI overrides. The daemon tier overlays
 * last so a stale value left behind in a surface silo can never win.
 */

import { join } from 'node:path';
import {
  persistSharedKey,
  readDotPath,
  readSharedTierFile,
  removeSharedKey,
} from './shared-config-tier.js';
import { isDaemonOwnedConfigKey, listDaemonOwnedConfigKeys } from './config-ownership.js';
import type { ConfigKey } from './schema.js';

/** Directory name of the daemon's own state root under `~/.goodvibes/`. */
export const DAEMON_CONFIG_ROOT = 'daemon';

/** File name of the daemon's settings store within the daemon home. */
export const DAEMON_SETTINGS_FILE = 'settings.json';

/** Absolute path of the daemon config store for a given daemon home directory. */
export function daemonConfigPathForHome(daemonHomeDir: string): string {
  return join(daemonHomeDir, DAEMON_SETTINGS_FILE);
}

/**
 * Absolute path of the daemon config store derived from a user home directory:
 * `<homeDir>/.goodvibes/daemon/settings.json`. Callers that honor
 * `GOODVIBES_DAEMON_HOME` should resolve the daemon home first and use
 * {@link daemonConfigPathForHome} instead.
 */
export function daemonConfigPath(homeDir: string): string {
  return join(homeDir, '.goodvibes', DAEMON_CONFIG_ROOT, DAEMON_SETTINGS_FILE);
}

/** Read the daemon config store as a plain object ({} when it does not exist). */
export function readDaemonTierFile(path: string): Record<string, unknown> {
  return readSharedTierFile(path, 'daemon tier');
}

/** Persist one daemon-owned key, merging with whatever else is already stored. */
export function persistDaemonKey(path: string, key: string, value: unknown): void {
  persistSharedKey(path, key, value);
}

/** Remove one daemon-owned key so it falls back to its default. */
export function removeDaemonKey(path: string, key: string): void {
  removeSharedKey(path, key);
}

/** A daemon-owned key found in a settings object, with its stored value. */
export interface DaemonTierEntry {
  readonly key: ConfigKey;
  readonly value: unknown;
}

/**
 * Every daemon-owned key explicitly present in a parsed settings object. Used
 * both to overlay the daemon tier at load and to find what a surface silo is
 * still holding that should have moved.
 */
export function collectDaemonOwnedEntries(parsed: unknown): readonly DaemonTierEntry[] {
  const found: DaemonTierEntry[] = [];
  for (const key of listDaemonOwnedConfigKeys()) {
    const hit = readDotPath(parsed, key);
    if (hit.present) found.push({ key, value: hit.value });
  }
  return found;
}

/**
 * Overlay the daemon tier onto a resolved config. `assign` receives each
 * daemon-owned key that the store explicitly carries; keys absent from the
 * store keep whatever the lower tiers resolved to.
 *
 * Returns the keys that were overlaid, so `describeConfigKeySource` can report
 * the daemon tier honestly rather than guessing.
 */
export function overlayDaemonTier(
  path: string,
  assign: (key: ConfigKey, value: unknown) => void,
): readonly ConfigKey[] {
  const stored = readDaemonTierFile(path);
  const applied: ConfigKey[] = [];
  for (const entry of collectDaemonOwnedEntries(stored)) {
    assign(entry.key, entry.value);
    applied.push(entry.key);
  }
  return applied;
}

/** Re-exported for callers that hold a raw key string rather than a ConfigKey. */
export { isDaemonOwnedConfigKey };
