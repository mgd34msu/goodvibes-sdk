/**
 * schema-domain-learning.ts — config for idle-time memory consolidation
 * (`learning.consolidation.*`, shipped as a behavioral contract in
 * state/memory-consolidation-config.ts).
 *
 * WHY THIS FILE EXISTS. The consolidation keys were read directly off the raw
 * user `learning` block (resolveMemoryConsolidationConfig → getRaw()), but the
 * shared config schema had no `learning` domain at all — so DEFAULT_CONFIG
 * carried no `learning` section and ConfigManager.resolvePath threw
 * "section 'learning' does not exist" for every typed get('learning.…') /
 * set('learning.…'). Registering the domain (same idiom as the worktree fix)
 * makes typed get/set safe everywhere without changing the resolver: the
 * resolver still reads getRaw().learning.consolidation and now simply finds the
 * schema defaults there when the user set nothing, which are identical to its
 * own DEFAULT_MEMORY_CONSOLIDATION_CONFIG fallback (a test guards that they
 * never drift), so its output is unchanged.
 *
 * The scalar keys ARE ordinary ConfigKeys, registered through the string-keyed
 * ConfigSettingDefinition[] the composition spreads into CONFIG_SCHEMA (as the
 * runtime domain does), so they need no edit to the grandfathered schema-types.ts
 * ConfigKey union; the LearningConfig type is augmented onto GoodVibesConfig here,
 * co-located with its default below.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';

/** Idle-time memory consolidation policy (`learning.consolidation.*`). Off by default. */
export interface LearningConfig {
  consolidation: {
    enabled: boolean;
    intervalMs: number;
    minIdleMs: number;
    maxMergesPerRun: number;
    maxDecaysPerRun: number;
    maxProposalsPerRun: number;
    decayAgeDays: number;
    decayConfidenceStep: number;
    archiveConfidenceFloor: number;
  };
}
declare module './schema-types.js' {
  interface GoodVibesConfig {
    learning: LearningConfig;
  }
}

/**
 * Defaults MUST equal DEFAULT_MEMORY_CONSOLIDATION_CONFIG in
 * state/memory-consolidation-config.ts (that module is the behavioral contract;
 * this is the config-surface mirror). A test asserts they are identical so the
 * two cannot drift — duplicated here rather than imported to keep the config
 * layer free of a dependency on the state layer.
 */
export const learningConfigDefaults: { learning: LearningConfig } = {
  learning: {
    consolidation: {
      enabled: false,
      intervalMs: 6 * 60 * 60 * 1000,
      minIdleMs: 0,
      maxMergesPerRun: 10,
      maxDecaysPerRun: 20,
      maxProposalsPerRun: 20,
      decayAgeDays: 45,
      decayConfidenceStep: 10,
      archiveConfidenceFloor: 40,
    },
  },
};

export const learningConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'learning.consolidation.enabled',
    type: 'boolean',
    default: false,
    description:
      'Master switch for the idle-time memory consolidation pass (dedupe merges, confidence decay of never-referenced records, and review proposals). Off by default — the pass runs only when explicitly enabled.',
  },
  {
    key: 'learning.consolidation.intervalMs',
    type: 'number',
    default: 6 * 60 * 60 * 1000,
    description: 'Minimum time between consolidation runs, in milliseconds. Doubles as the schedule cadence (default: 6 hours).',
    ...intRange(1, 30 * 24 * 60 * 60 * 1000),
  },
  {
    key: 'learning.consolidation.minIdleMs',
    type: 'number',
    default: 0,
    description: 'Minimum continuous idle time required before a consolidation run may start, in milliseconds (default: 0 = no idle requirement).',
    ...intRange(0, 24 * 60 * 60 * 1000),
  },
  {
    key: 'learning.consolidation.maxMergesPerRun',
    type: 'number',
    default: 10,
    description: 'Maximum duplicate groups merged in a single consolidation run.',
    ...intRange(1, 10_000),
  },
  {
    key: 'learning.consolidation.maxDecaysPerRun',
    type: 'number',
    default: 20,
    description: 'Maximum records decayed or archived in a single consolidation run.',
    ...intRange(1, 10_000),
  },
  {
    key: 'learning.consolidation.maxProposalsPerRun',
    type: 'number',
    default: 20,
    description: 'Maximum review proposals emitted in a single consolidation run.',
    ...intRange(1, 10_000),
  },
  {
    key: 'learning.consolidation.decayAgeDays',
    type: 'number',
    default: 45,
    description: 'Active records older than this (by updatedAt) become decay candidates, in days.',
    ...intRange(1, 3_650),
  },
  {
    key: 'learning.consolidation.decayConfidenceStep',
    type: 'number',
    default: 10,
    description: 'Confidence points removed from a never-referenced decaying record per run.',
    ...intRange(1, 100),
  },
  {
    key: 'learning.consolidation.archiveConfidenceFloor',
    type: 'number',
    default: 40,
    description: 'A decaying record whose confidence would fall to or below this is archived (marked stale).',
    ...intRange(0, 100),
  },
];
