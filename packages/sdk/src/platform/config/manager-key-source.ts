/**
 * manager-key-source.ts, "where did this value actually come from".
 *
 * Split out of manager.ts (line cap) and worth its own file anyway: the whole
 * daemon-owned-config change exists because nobody could see which store a
 * setting resolved from, so the tier report is not an incidental debug helper.
 *
 * Resolution order, lowest to highest: default < global surface < project
 * surface < shared tier < daemon tier.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readDotPath } from './shared-config-tier.js';
import type { ConfigKey } from './schema.js';
import type { DaemonOwnedConfigPath } from './config-ownership.js';

/** The tier a resolved config value came from. */
export type ConfigKeyTier = 'daemon' | 'shared' | 'project' | 'global' | 'default';

/** Where a config key's live value resolves from, and which tiers can hold it. */
export interface ConfigKeySource {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly tier: ConfigKeyTier;
  /** True when this key resolves from/writes to the surface-root-independent shared tier. */
  readonly shareable: boolean;
  /** The shared-tier settings file path, or null when no shared tier is configured. */
  readonly sharedTierPath: string | null;
  /** True when the daemon owns this key and writes land in the daemon store. */
  readonly daemonOwned: boolean;
  /** The daemon store path, or null when no daemon tier is configured. */
  readonly daemonTierPath: string | null;
}

export interface ConfigKeySourceInput {
  readonly key: ConfigKey;
  readonly value: unknown;
  readonly shareable: boolean;
  readonly daemonOwned: boolean;
  readonly sharedTierPath: string | null;
  readonly daemonTierPath: string | null;
  readonly projectConfigPath: string | null;
  readonly configPath: string;
  /** Keys the last load sourced from the shared tier. */
  readonly sharedKeysPresent: ReadonlySet<ConfigKey>;
  /** Keys the last load sourced from the daemon store. */
  readonly daemonKeysPresent: ReadonlySet<DaemonOwnedConfigPath>;
}

/** True when the JSON settings file at `path` carries an explicit value for `key`. */
export function settingsFileHasKey(path: string, key: ConfigKey): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return readDotPath(parsed, key).present;
  } catch {
    return false;
  }
}

/** Report which tier a key's live value resolves from. */
export function describeKeySource(input: ConfigKeySourceInput): ConfigKeySource {
  const common = {
    key: input.key,
    value: input.value,
    shareable: input.shareable,
    sharedTierPath: input.sharedTierPath,
    daemonOwned: input.daemonOwned,
    daemonTierPath: input.daemonTierPath,
  };
  if (input.daemonOwned && input.daemonKeysPresent.has(input.key)) return { ...common, tier: 'daemon' };
  if (input.shareable && input.sharedKeysPresent.has(input.key)) return { ...common, tier: 'shared' };
  if (input.projectConfigPath && settingsFileHasKey(input.projectConfigPath, input.key)) {
    return { ...common, tier: 'project' };
  }
  if (settingsFileHasKey(input.configPath, input.key)) return { ...common, tier: 'global' };
  return { ...common, tier: 'default' };
}
