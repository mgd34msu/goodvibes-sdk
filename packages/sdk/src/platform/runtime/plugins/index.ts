/**
 * Plugin lifecycle system — barrel export and factory.
 *
 * Gated by the `plugin-lifecycle` feature flag. Import and call
 * `createPluginLifecycleManager()` at startup after the feature flag
 * manager has been initialised.
 *
 * @example
 * ```ts
 * import { createPluginLifecycleManager } from './src/runtime/plugins/index.js';
 *
 * const lcm = createPluginLifecycleManager({ sessionId: session.id, runtimeBus });
 * lcm.scanAndRegister();
 * ```
 */

export type {
  PluginCapability,
  PluginCapabilityManifest,
  PluginManifestV2,
  PluginTransition,
  TransitionResult,
  PluginHealthCheckResult,
  PluginLifecycleRecord,
  PluginLifecycleManagerOptions,
  PluginLifecycleState,
} from './types.js';

export { ALL_CAPABILITIES, MAX_TRANSITION_HISTORY } from './types.js';

export {
  VALID_TRANSITIONS,
  canTransition,
  applyTransition,
  isOperational,
  isReloadable,
  isTerminal,
} from './lifecycle.js';

export {
  resolveCapabilityManifest,
  hasCapability,
  validateManifestV2,
} from './manifest.js';

export { PluginLifecycleManager } from './manager.js';
import { PluginLifecycleManager } from './manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';

// Trust framework.
export type {
  PluginTrustTier,
  PluginTrustRecord,
  SignatureValidationResult,
} from './trust.js';
export {
  PluginTrustStore,
  validatePluginSignature,
  filterCapabilitiesByTrust,
  SAFE_CAPABILITIES,
} from './trust.js';

export type { QuarantineRecord } from './quarantine.js';
export { PluginQuarantineEngine } from './quarantine.js';

export { isHighRiskCapability } from './manifest.js';

export type { HotReloadOptions, HotReloadResult } from './hot-reload.js';
export { runHotReload } from './hot-reload.js';

/**
 * createPluginLifecycleManager — Factory function for the PluginLifecycleManager.
 *
 * Intended as the primary entry point for consumers. Respects the
 * `plugin-lifecycle` feature flag — callers should check the flag before
 * invoking if they want to gate the entire system.
 *
 * @param options - Optional manager configuration.
 * @returns A new PluginLifecycleManager instance.
 */
export function createPluginLifecycleManager(
  options: import('./types.js').PluginLifecycleManagerOptions = {},
  flagManager?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): PluginLifecycleManager {
  if (flagManager && !flagManager.isEnabled('plugin-lifecycle')) {
    throw new Error('Feature flag "plugin-lifecycle" is not enabled');
  }
  return new PluginLifecycleManager(options);
}
