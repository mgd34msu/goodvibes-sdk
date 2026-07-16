/**
 * schema-domain-memory.ts — MemoryGovernor config (`memory.*`).
 *
 * Owner-confirmed defaults (2026-07-14). `memory.budgetMb` uses 0 as an "auto"
 * sentinel: the governor resolves it to min(25% of system RAM, 4096 MB) at
 * runtime — kept a sentinel here so the browser-safe config schema never calls
 * node:os. The tier percentages and tripwire values are literal defaults.
 */
import { type ConfigSettingDefinition, intRange, numRange } from './schema-shared.js';

/** MemoryGovernor policy (`memory.*`). */
export interface MemoryConfig {
  /** Budget in MB. 0 = auto: min(25% of system RAM, 4096). */
  budgetMb: number;
  tier: {
    /** Trim caches to floor + gc at/above this % of budget. */
    elevatedPct: number;
    /** Flush caches + pause deferrable jobs at/above this % of budget. */
    highPct: number;
    /** Refuse new expensive work + emit ops event at/above this % of budget. */
    criticalPct: number;
  };
  tripwire: {
    /** Post-flush RSS growth rate (MB/s) that, if sustained, indicates a leak. */
    rateMbPerSec: number;
    /** How long (s) the growth must be sustained after a flush before exiting. */
    sustainSec: number;
  };
  /**
   * Absolute-RSS backstop as a percent of the budget, ABOVE the tier ladder
   * (must exceed tier.criticalPct). The rate tripwire only catches fast leaks;
   * this ceiling catches a slow leak that would otherwise ride to a kernel OOM
   * kill. Default 120.
   */
  hardLimitPct: number;
}
declare module './schema-types.js' {
  interface GoodVibesConfig {
    memory: MemoryConfig;
  }
}

export const memoryConfigDefaults: { memory: MemoryConfig } = {
  memory: {
    budgetMb: 0,
    tier: {
      elevatedPct: 60,
      highPct: 80,
      criticalPct: 95,
    },
    tripwire: {
      rateMbPerSec: 25,
      sustainSec: 60,
    },
    hardLimitPct: 120,
  },
};

export const memoryConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'memory.budgetMb',
    type: 'number',
    default: 0,
    description:
      'MemoryGovernor budget in MB. The governor sheds caches and pauses background jobs as RSS approaches this budget. 0 means auto: min(25% of system RAM, 4096 MB), resolved at daemon start.',
    ...intRange(0, 1_048_576),
  },
  {
    key: 'memory.tier.elevatedPct',
    type: 'number',
    default: 60,
    description:
      'Elevated tier threshold, as a percent of the budget: at/above this the governor trims registered caches to their floor and runs a gc.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tier.highPct',
    type: 'number',
    default: 80,
    description:
      'High tier threshold, as a percent of the budget: at/above this the governor flushes all registered caches and pauses deferrable background jobs.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tier.criticalPct',
    type: 'number',
    default: 95,
    description:
      'Critical tier threshold, as a percent of the budget: at/above this the governor refuses new expensive work with an honest structured outcome and emits an ops attention event.',
    ...intRange(1, 100),
  },
  {
    key: 'memory.tripwire.rateMbPerSec',
    type: 'number',
    default: 25,
    description:
      'Leak tripwire rate in MB/s: if RSS keeps growing faster than this AFTER a full cache flush, the flush did not help and a leak is suspected.',
    ...numRange(1, 100_000),
  },
  {
    key: 'memory.tripwire.sustainSec',
    type: 'number',
    default: 60,
    description:
      'Leak tripwire sustain window in seconds: the post-flush growth rate must exceed memory.tripwire.rateMbPerSec continuously for this long before the governor writes a receipt and exits for a clean supervisor restart.',
    ...intRange(1, 86_400),
  },
  {
    key: 'memory.hardLimitPct',
    type: 'number',
    default: 120,
    description:
      'Absolute-RSS backstop as a percent of the budget, above the tier ladder (must exceed memory.tier.criticalPct). The rate tripwire only catches fast leaks; if RSS holds at/above this percent of the budget for memory.tripwire.sustainSec, the governor writes a hard-limit receipt and exits — so a slow leak the rate tripwire cannot see becomes a clean restart instead of a kernel OOM kill.',
    ...intRange(101, 100_000),
  },
];
