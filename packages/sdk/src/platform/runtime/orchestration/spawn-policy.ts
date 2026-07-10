import type { ConfigManager } from '../../config/manager.js';
import { coreConfigDefaults } from '../../config/schema-domain-core.js';

export type OrchestrationSpawnMode = 'manual-batch' | 'plan-auto' | 'recursive-child';

/**
 * Config keys for the orchestration caps this policy enforces. Named here so a
 * bind message and the structured decision can report exactly which documented
 * setting refused or queued a spawn.
 */
export const ORCHESTRATION_CAP_KEYS = {
  maxActiveAgents: 'orchestration.maxActiveAgents',
  maxDepth: 'orchestration.maxDepth',
  recursionEnabled: 'orchestration.recursionEnabled',
} as const;

/** Identity of the cap that bound a spawn decision: its config key and value. */
export type BoundCap = {
  /** The documented config key that bound the decision. */
  key: string;
  /** The cap's effective value at the moment it bound. */
  value: number | boolean;
};

export type OrchestrationSpawnDecision = {
  allowed: boolean;
  reason?: string | undefined;
  maxAgents: number;
  activeAgents: number;
  availableSlots: number;
  requestedDepth: number;
  maxDepth: number;
  mode: OrchestrationSpawnMode;
  /**
   * When `allowed` is false because a cap was hit, the documented cap that
   * bound the decision (config key + value). Undefined when the spawn is
   * allowed.
   */
  boundCap?: BoundCap | undefined;
};

export function evaluateOrchestrationSpawn(input: {
  configManager: Pick<ConfigManager, 'get'>;
  mode: OrchestrationSpawnMode;
  activeAgents: number;
  requestedDepth?: number | undefined;
  overrides?: {
    recursionEnabled?: boolean | undefined;
    maxAgents?: number | undefined;
    maxDepth?: number | undefined;
  };
}): OrchestrationSpawnDecision {
  // Fallbacks source the documented schema defaults (coreConfigDefaults) rather
  // than re-declaring literals, so the in-file value can never silently drift
  // from the config default.
  const maxAgents = input.overrides?.maxAgents ?? ((input.configManager.get('orchestration.maxActiveAgents') as number | null) ?? coreConfigDefaults.orchestration.maxActiveAgents);
  const maxDepth = input.overrides?.maxDepth ?? ((input.configManager.get('orchestration.maxDepth') as number | null) ?? coreConfigDefaults.orchestration.maxDepth);
  const recursionEnabled = input.overrides?.recursionEnabled ?? ((input.configManager.get('orchestration.recursionEnabled') as boolean | null) ?? coreConfigDefaults.orchestration.recursionEnabled);
  const requestedDepth = input.requestedDepth ?? 0;
  const availableSlots = Math.max(0, maxAgents - input.activeAgents);

  if (input.mode === 'recursive-child' || input.mode === 'plan-auto') {
    if (!recursionEnabled) {
      return {
        allowed: false,
        reason: `recursive orchestration is disabled — cap: ${ORCHESTRATION_CAP_KEYS.recursionEnabled}=${recursionEnabled}`,
        maxAgents,
        activeAgents: input.activeAgents,
        availableSlots,
        requestedDepth,
        maxDepth,
        mode: input.mode,
        boundCap: { key: ORCHESTRATION_CAP_KEYS.recursionEnabled, value: recursionEnabled },
      };
    }
  }

  if (input.mode === 'recursive-child' && requestedDepth > maxDepth) {
    return {
      allowed: false,
      reason: `requested depth ${requestedDepth} exceeds configured recursion depth ${maxDepth} — cap: ${ORCHESTRATION_CAP_KEYS.maxDepth}=${maxDepth}`,
      maxAgents,
      activeAgents: input.activeAgents,
      availableSlots,
      requestedDepth,
      maxDepth,
      mode: input.mode,
      boundCap: { key: ORCHESTRATION_CAP_KEYS.maxDepth, value: maxDepth },
    };
  }

  if (availableSlots <= 0) {
    return {
      allowed: false,
      reason: `agent capacity reached (${input.activeAgents}/${maxAgents}) — cap: ${ORCHESTRATION_CAP_KEYS.maxActiveAgents}=${maxAgents}`,
      maxAgents,
      activeAgents: input.activeAgents,
      availableSlots,
      requestedDepth,
      maxDepth,
      mode: input.mode,
      boundCap: { key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: maxAgents },
    };
  }

  return {
    allowed: true,
    maxAgents,
    activeAgents: input.activeAgents,
    availableSlots,
    requestedDepth,
    maxDepth,
    mode: input.mode,
  };
}
