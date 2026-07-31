/**
 * feature-flag-composition.ts — the ONE way a runtime composition gets its
 * feature-flag manager.
 *
 * Both compositions need the identical three steps: take the caller's manager
 * when it owns one, otherwise build one and load gate states from the domain
 * settings keys AND keep the live `config.set` bridge attached, then point the
 * process tracer at `telemetry.otelMode`. Written once here so the daemon-grade
 * `createRuntimeServices` and the pure-client `createClientRuntimeServices`
 * cannot drift on the "who owns the manager" rule — the subtle half, because
 * loading + bridging a manager the caller already wired would double-bind it.
 */

import type { ConfigManager } from '../config/manager.js';
import { createFeatureFlagManager, type FeatureFlagManager } from './feature-flags/index.js';
import { bindFeatureSettingsBridge, deriveFeatureStates } from './feature-flags/feature-settings.js';
import { installComposedTelemetry } from './telemetry/index.js';

export interface RuntimeFeatureFlagOptions {
  readonly configManager: ConfigManager;
  /** The caller's manager. Present ⇒ used as-is (the caller already loaded and bridged it). */
  readonly featureFlags?: FeatureFlagManager | undefined;
}

/**
 * Resolve the feature-flag manager for a runtime composition, wiring the
 * settings bridge and telemetry exactly once.
 */
export function resolveRuntimeFeatureFlags(options: RuntimeFeatureFlagOptions): FeatureFlagManager {
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Gate states derive from domain settings keys; the bridge keeps live
    // config.set changes flowing. Wired only for a manager this call owns.
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(options.configManager) });
    bindFeatureSettingsBridge(options.configManager, featureFlags);
  }
  installComposedTelemetry(featureFlags); // telemetry.otelMode -> the process tracer
  return featureFlags;
}
