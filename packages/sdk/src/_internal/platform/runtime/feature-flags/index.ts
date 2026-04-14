/**
 * Feature flag and kill-switch system for the goodvibes-sdk runtime — barrel exports and factory.
 *
 * Usage:
 * ```ts
 * import { createFeatureFlagManager } from './feature-flags/index.js';
 * const flagManager = createFeatureFlagManager();
 *
 * // Check before using a gated subsystem
 * if (flagManager.isEnabled('fetch-sanitization')) {
 *   // enable stricter fetch sanitization rules
 * }
 *
 * // Emergency kill
 * flagManager.kill('fetch-sanitization', 'Crash loop detected in production');
 * ```
 */

export type { FlagState, FeatureFlag, FlagConfig, FlagTransition } from './types.js';
export type { FlagSubscriber } from './manager.js';
export { FeatureFlagManager, createFeatureFlagManager } from './manager.js';
export { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.js';
