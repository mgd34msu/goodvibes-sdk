/**
 * Runtime permissions public API barrel.
 *
 * Exports the LayeredPolicyEvaluator, all types, rule evaluators, safety checks,
 * and the createPermissionEvaluator() factory function.
 *
 * Feature flag: `permissions-policy-engine` must be enabled to use this module in production.
 */

export { LayeredPolicyEvaluator } from './evaluator.js';
export { DecisionLog } from './decision-log.js';
export { runSafetyChecks } from './safety-checks.js';
export { PermissionSimulator, SimulationEnforcementError } from './simulation.js';
export { buildDefaultPolicySimulationScenarios, runPolicySimulationScenarios } from './simulation-scenarios.js';
export { lintPolicyConfig } from './lint.js';
export { buildPolicyPreflightReview } from './preflight.js';
export { buildPermissionRuleSuggestions } from './rule-suggestions.js';
// Policy signing
export { signBundle, verifyBundle, canonicalise } from './policy-signer.js';
export { loadPolicyBundle, createUnsignedBundle, PolicySignatureError } from './policy-loader.js';

export type {
  PermissionMode,
  CommandClassification,
  DecisionReason,
  SourceLayer,
  EvaluationStep,
  PermissionDecision,
  PolicyRule,
  PrefixRule,
  ArgShapeRule,
  PathScopeRule,
  NetworkScopeRule,
  ModeConstraintRule,
  RuleOrigin,
  PermissionsConfig,
  SimulationMode,
  SimulationResult,
  DivergenceType,
  DivergenceRecord,
  DivergenceStats,
  DivergenceReport,
  PermissionSimulatorConfig,
} from './types.js';

export type { DecisionLogEntry, DecisionLogQuery } from './decision-log.js';
export type { SafetyCheckResult } from './safety-checks.js';
export type { PolicyLintFinding, PolicyLintSeverity } from './lint.js';
export type { PermissionRuleSuggestion } from './rule-suggestions.js';
export type {
  PolicyPreflightStatus,
  PolicyPreflightServer,
  PolicyPreflightIssue,
  PolicyPreflightReview,
} from './preflight.js';
export type {
  PolicySimulationScenario,
  PolicySimulationScenarioResult,
  PolicySimulationSummary,
} from './simulation-scenarios.js';
// Policy signing
export type {
  PolicyBundleId,
  SignatureStatus,
  ProvenanceSource,
  SignedPolicyBundle,
  VerifyResult,
} from './policy-signer.js';
export type {
  PolicyBundlePayload,
  BundleProvenance,
  PolicyLoadResult,
  PolicyLoaderOptions,
} from './policy-loader.js';

export {
  evaluatePrefixRule,
  evaluateArgShapeRule,
  evaluatePathScopeRule,
  evaluateNetworkScopeRule,
  evaluateModeConstraintRule,
} from './rules/index.js';

// Divergence dashboard
export {
  DivergenceDashboard,
  DivergenceGateError,
} from './divergence-dashboard.js';
export type {
  DivergenceTrendEntry,
  EnforceGateStatus,
  EnforceGateResult,
  DivergenceDashboardSnapshot,
  DivergenceDashboardConfig,
} from './divergence-dashboard.js';

// Policy-as-Code
export { PolicyRegistry } from './policy-registry.js';
export {
  PolicyRuntimeState,
} from './policy-runtime.js';
export type {
  BundleLifecycleState,
  PolicyBundleVersion,
  PolicyDiffResult,
  PromoteResult,
  RollbackResult,
  PolicyRegistryConfig,
} from './policy-registry.js';

// ── Factory ──────────────────────────────────────────────────────────────────────

import { LayeredPolicyEvaluator } from './evaluator.js';
import { PermissionSimulator } from './simulation.js';
import { DivergenceDashboard } from './divergence-dashboard.js';
import { PolicyRegistry } from './policy-registry.js';
import type { PermissionsConfig, SimulationMode, PermissionSimulatorConfig } from './types.js';
import type { FeatureFlagManager } from '../feature-flags/manager.js';
import type { FeatureFlagReader } from '../feature-flags/index.js';
import { requireFeatureGate } from '../feature-flags/index.js';
import type { BundleProvenance } from './policy-loader.js';
import type { DivergenceDashboardConfig } from './divergence-dashboard.js';
import type { PolicyRegistryConfig } from './policy-registry.js';

/**
 * createPermissionEvaluator — Factory function for the runtime permission evaluator.
 *
 * Returns a LayeredPolicyEvaluator configured with the given options.
 * Designed as the primary entry point for integrating the runtime permissions system.
 *
 * The returned evaluator exposes:
 *   - `evaluate(toolName, args)` — perform a full layered evaluation
 *   - `recordSessionOverride(...)` — cache a user prompt response
 *   - `log` — DecisionLog for audit queries
 *   - `getMode()` — inspect the active mode
 *
 * @example
 * ```ts
 * const perms = createPermissionEvaluator({ mode: 'default', rules: [] });
 * const decision = perms.evaluate('write', { path: '/tmp/out.txt' });
 * if (!decision.allowed) {
 *   console.error('denied:', decision.reason);
 * }
 * ```
 *
 * @param config     — Optional configuration; all fields have safe defaults.
 * @param provenance — Optional bundle provenance (GC-PERM-011).
 */
export function createPermissionEvaluator(
  config: PermissionsConfig = {},
  provenance?: BundleProvenance,
  flagManager?: Pick<FeatureFlagManager, 'isEnabled'> | null,
): LayeredPolicyEvaluator {
  if (flagManager && !flagManager.isEnabled('permissions-policy-engine')) {
    throw new Error('Feature flag "permissions-policy-engine" is not enabled');
  }
  return new LayeredPolicyEvaluator(config, provenance);
}

/**
 * createPermissionSimulator — Factory for `PermissionSimulator`.
 *
 * Creates a dual-evaluator simulation pipeline for the runtime permissions system that runs
 * both the actual and simulated evaluators in parallel, tracking divergence.
 *
 * Requires the `permissions-simulation` feature flag to be enabled.
 *
 * @param actualConfig    — Config for the authoritative evaluator.
 * @param simulatedConfig — Config for the candidate evaluator.
 * @param simulationMode  — Controls enforcement and warning behaviour.
 * @param config          — Optional tuning: record limit, divergence threshold.
 *
 * @example
 * ```ts
 * const simulator = createPermissionSimulator(
 *   { mode: 'default', rules: currentRules },
 *   { mode: 'default', rules: candidateRules },
 *   'warn-on-divergence',
 * );
 * const result = simulator.evaluate('write', { path: '/tmp/out.txt' });
 * const report = simulator.getDivergenceReport();
 * ```
 */
export function createPermissionSimulator(
  actualConfig: PermissionsConfig,
  simulatedConfig: PermissionsConfig,
  simulationMode: SimulationMode,
  config: PermissionSimulatorConfig = {},
  flagManager?: FeatureFlagManager,
): PermissionSimulator {
  if (flagManager && !flagManager.isEnabled('permissions-simulation')) {
    throw new Error('Feature flag "permissions-simulation" is not enabled');
  }
  return new PermissionSimulator(
    actualConfig,
    simulatedConfig,
    simulationMode,
    config,
  );
}

/**
 * createDivergenceDashboard — Factory for the permissions divergence dashboard.
 *
 * Requires the `permission-divergence-dashboard` feature flag when a flag manager
 * is supplied. Hosts without the feature-flag subsystem can gate this factory
 * at their own boundary before calling it.
 */
export function createDivergenceDashboard(
  simulator: PermissionSimulator,
  mode: SimulationMode,
  config: DivergenceDashboardConfig = {},
  flagManager?: FeatureFlagReader,
): DivergenceDashboard {
  requireFeatureGate(flagManager, 'permission-divergence-dashboard', 'create divergence dashboard');
  return new DivergenceDashboard(simulator, mode, config);
}

/**
 * createPolicyRegistry — Factory for the policy-as-code registry.
 *
 * Requires the `policy-as-code` feature flag when a flag manager is supplied.
 * Hosts without the feature-flag subsystem can gate this factory at their own
 * boundary before calling it.
 */
export function createPolicyRegistry(
  config: PolicyRegistryConfig = {},
  flagManager?: FeatureFlagReader,
): PolicyRegistry {
  requireFeatureGate(flagManager, 'policy-as-code', 'create policy registry');
  return new PolicyRegistry(config);
}
