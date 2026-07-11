/**
 * config-bridge.ts — live bridge from persisted `featureFlags.<id>` config
 * changes to the in-process FeatureFlagManager.
 *
 * FeatureFlagManager.loadFromConfig() previously ran exactly once, at
 * RuntimeServices construction. A `configManager.set('featureFlags.<id>', ...)`
 * call after boot — the path the webui settings surface uses, and a
 * legitimate generic path for any operator — persisted to disk but never
 * reached the manager until the process restarted, even for flags whose
 * registry entry says `runtimeToggleable: true`.
 *
 * `bindFeatureFlagConfigBridge` closes that gap: it subscribes to every
 * registered flag's config key and forwards live changes to
 * `FeatureFlagManager.applyConfigState()`, which applies runtime-toggleable
 * flags immediately (through the same transition path a direct
 * `enable()`/`disable()`/`kill()` call uses, so subscribers fire identically)
 * and records a pending-restart marker for startup-gated flags instead of
 * faking a live apply.
 */
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { logger } from '../../utils/logger.js';
import { FEATURE_FLAG_MAP } from './flags.js';
import type { FeatureFlagManager } from './manager.js';
import type { FlagState } from './types.js';

const VALID_FLAG_STATES: ReadonlySet<string> = new Set<FlagState>(['enabled', 'disabled', 'killed']);

function isFlagState(value: unknown): value is FlagState {
  return typeof value === 'string' && VALID_FLAG_STATES.has(value);
}

/**
 * Subscribes the feature-flag manager to live `featureFlags.<id>` config
 * changes for every flag in the registry. Returns an unsubscribe function
 * that detaches all per-flag subscriptions (mirrors the
 * `ConfigManager.subscribe` convention used elsewhere, e.g.
 * `createHostModeRestartWatcher`).
 *
 * A malformed persisted value (not one of `enabled`/`disabled`/`killed`) is
 * logged and ignored rather than applied or thrown — a stale/corrupt config
 * key must never crash the runtime.
 */
export function bindFeatureFlagConfigBridge(
  configManager: Pick<ConfigManager, 'subscribe'>,
  featureFlags: Pick<FeatureFlagManager, 'applyConfigState'>,
): () => void {
  const unsubs: Array<() => void> = [];
  for (const id of FEATURE_FLAG_MAP.keys()) {
    const key = `featureFlags.${id}` as ConfigKey;
    unsubs.push(configManager.subscribe(key, (newValue: unknown) => {
      if (!isFlagState(newValue)) {
        logger.warn('[feature-flags] ignoring non-flag-state config value', { flagId: id, value: newValue });
        return;
      }
      featureFlags.applyConfigState(id, newValue);
    }));
  }
  return () => {
    for (const unsub of unsubs.splice(0)) unsub();
  };
}
