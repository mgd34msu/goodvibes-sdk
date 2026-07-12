/**
 * Capability gates and per-feature settings metadata — barrel exports and factory.
 *
 * Surfaces render FEATURE_SETTINGS: every platform capability as a first-class
 * domain setting (enablement key, option shapes, real descriptions). The gate
 * manager underneath is internal plumbing whose state derives from those same
 * settings keys; it also carries the emergency kill switch.
 *
 * Usage:
 * ```ts
 * import { createFeatureFlagManager, deriveFeatureStates } from './feature-flags/index.js';
 * const gates = createFeatureFlagManager();
 * gates.loadFromConfig({ flags: deriveFeatureStates(configManager) });
 *
 * // Check before using a gated subsystem
 * if (gates.isEnabled('exec-sandbox')) {
 *   // per-command sandbox is active
 * }
 *
 * // Emergency kill
 * gates.kill('exec-sandbox', 'Crash loop detected in production');
 * ```
 */

export type { FlagState, FeatureFlag, FlagConfig, FlagTransition } from './types.js';
export type { FlagSubscriber } from './manager.js';
export { FeatureFlagManager, createFeatureFlagManager } from './manager.js';
export type {
  FeatureSetting,
  FeatureSettingsBinding,
  FeatureEnablementKind,
} from './feature-settings.js';
export {
  FEATURE_SETTINGS,
  FEATURE_SETTINGS_BINDINGS,
  getFeatureSettingsBinding,
  deriveFeatureState,
  deriveFeatureStates,
  bindFeatureSettingsBridge,
} from './feature-settings.js';
export type { FeatureFlagReader } from './gates.js';
export {
  isFeatureGateEnabled,
  isSurfaceFeatureGateEnabled,
  requireFeatureGate,
  surfaceFeatureGateId,
} from './gates.js';
