/**
 * src/runtime/mcp — MCP lifecycle barrel.
 *
 * Gated by the `mcp-lifecycle` feature flag.
 *
 * Public API:
 *   - `createMcpLifecycleManager()` — factory function
 *   - All types from types.ts
 *   - State machine helpers from lifecycle.ts
 *   - Permission manager from permissions.ts
 *   - Schema freshness tracker from schema-freshness.ts
 *   - Manager from manager.ts
 */

export { McpLifecycleManager, type McpEventHandler, type McpLifecycleManagerOptions } from './manager.js';
export { McpPermissionManager, buildMcpAttackPathReview } from './permissions.js';
export { McpSchemaFreshnessTracker } from './schema-freshness.js';
export {
  canTransition,
  reachableFrom,
  applyTransition,
  isOperational,
  isTerminal,
  type TransitionResult,
} from './lifecycle.js';
export type {
  McpServerState,
  SchemaFreshness,
  McpSchemaRecord,
  QuarantineReason,
  QuarantineRecord,
  McpTrustLevel,
  McpTrustMode,
  McpServerRole,
  McpCapabilityClass,
  McpCoherenceVerdict,
  McpRiskLevel,
  McpPermission,
  McpTrustProfile,
  McpCoherenceAssessment,
  McpDecisionRecord,
  McpSecuritySnapshot,
  McpAttackPathFindingKind,
  McpAttackPathFinding,
  McpAttackPathReview,
  McpToolPermission,
  McpServerPermissions,
  McpServerEntry,
  McpReconnectConfig,
} from './types.js';
export { DEFAULT_RECONNECT_CONFIG } from './types.js';

import { McpLifecycleManager } from './manager.js';
import type { McpLifecycleManagerOptions } from './manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';

/**
 * Factory function for creating a `McpLifecycleManager`.
 *
 * Check the `mcp-lifecycle` feature flag before calling this — when the
 * flag is disabled, the caller should use the standard MCP registry path.
 *
 * @param options - Optional configuration overrides
 */
export function createMcpLifecycleManager(
  options?: McpLifecycleManagerOptions,
  flagManager?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): McpLifecycleManager {
  if (flagManager && !flagManager.isEnabled('mcp-lifecycle')) {
    throw new Error('Feature flag "mcp-lifecycle" is not enabled');
  }
  return new McpLifecycleManager(options);
}
