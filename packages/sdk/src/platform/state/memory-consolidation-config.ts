/**
 * Idle-time memory consolidation settings (`learning.consolidation.*` namespace).
 *
 * HOISTED to the SDK from the agent surface so every consumer (agent, TUI,
 * webui, daemon) resolves the SAME consolidation policy the SAME way, rather
 * than each re-deriving (and re-weakening) it. The behavioral contract lives in
 * memory-consolidation.ts; this module is just the config shape + a resolver
 * with an injectable read seam.
 *
 * ON by default: the daemon (the memory store's single writer) runs the pass
 * on its idle/schedule triggers, and `enabled: false` is the user's off
 * switch. These keys are read from the `learning` block the ConfigManager
 * deep-merge preserves to `getRaw()` (registered in
 * config/schema-domain-learning.ts, whose defaults mirror these).
 *
 * settings.json example:
 *
 *   "learning": {
 *     "consolidation": {
 *       "enabled": true,
 *       "intervalMs": 21600000,
 *       "minIdleMs": 0,
 *       "maxMergesPerRun": 10,
 *       "maxDecaysPerRun": 20,
 *       "maxProposalsPerRun": 20,
 *       "decayAgeDays": 45,
 *       "decayConfidenceStep": 10,
 *       "archiveConfidenceFloor": 40
 *     }
 *   }
 */
export interface ResolvedMemoryConsolidationConfig {
  /** Master switch. When false the pass never runs. Default true (daemon-run). */
  readonly enabled: boolean;
  /** Minimum time between runs, in ms. Default 6 hours. Doubles as the schedule cadence. */
  readonly intervalMs: number;
  /** Minimum continuous idle time required before a run, in ms. Default 0. */
  readonly minIdleMs: number;
  /** Max duplicate groups merged in one run. Default 10. */
  readonly maxMergesPerRun: number;
  /** Max records decayed/archived in one run. Default 20. */
  readonly maxDecaysPerRun: number;
  /** Max proposals emitted in one run. Default 20. */
  readonly maxProposalsPerRun: number;
  /** Active records older than this (by updatedAt) become decay candidates. Default 45 days. */
  readonly decayAgeDays: number;
  /** Confidence points removed from a never-referenced decaying record per run. Default 10. */
  readonly decayConfidenceStep: number;
  /** A decaying record whose confidence would fall to/below this is archived (marked stale). Default 40. */
  readonly archiveConfidenceFloor: number;
}

export const DEFAULT_MEMORY_CONSOLIDATION_CONFIG: ResolvedMemoryConsolidationConfig = {
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,
  minIdleMs: 0,
  maxMergesPerRun: 10,
  maxDecaysPerRun: 20,
  maxProposalsPerRun: 20,
  decayAgeDays: 45,
  decayConfidenceStep: 10,
  archiveConfidenceFloor: 40,
};

/**
 * Minimal read seam: any object exposing `getRaw()` (a ConfigManager satisfies
 * it structurally). Kept structural so this module does not import the config
 * package and create a state→config cycle.
 */
export interface MemoryConsolidationConfigSource {
  getRaw(): unknown;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readPositive(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegative(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the effective consolidation config from a user-supplied
 * `learning.consolidation` block, falling back to
 * DEFAULT_MEMORY_CONSOLIDATION_CONFIG for every absent or wrong-typed key.
 */
export function resolveMemoryConsolidationConfig(
  configSource: MemoryConsolidationConfigSource,
): ResolvedMemoryConsolidationConfig {
  const raw = configSource.getRaw() as unknown as Record<string, unknown>;
  const learning = raw?.learning;
  if (learning === null || typeof learning !== 'object' || Array.isArray(learning)) {
    return DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  }
  const block = (learning as Record<string, unknown>).consolidation;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  }
  const c = block as Record<string, unknown>;
  const d = DEFAULT_MEMORY_CONSOLIDATION_CONFIG;
  return {
    enabled: readBoolean(c, 'enabled', d.enabled),
    intervalMs: readPositive(c, 'intervalMs', d.intervalMs),
    minIdleMs: readNonNegative(c, 'minIdleMs', d.minIdleMs),
    maxMergesPerRun: readPositive(c, 'maxMergesPerRun', d.maxMergesPerRun),
    maxDecaysPerRun: readPositive(c, 'maxDecaysPerRun', d.maxDecaysPerRun),
    maxProposalsPerRun: readPositive(c, 'maxProposalsPerRun', d.maxProposalsPerRun),
    decayAgeDays: readPositive(c, 'decayAgeDays', d.decayAgeDays),
    decayConfidenceStep: readPositive(c, 'decayConfidenceStep', d.decayConfidenceStep),
    archiveConfidenceFloor: readNonNegative(c, 'archiveConfidenceFloor', d.archiveConfidenceFloor),
  };
}
