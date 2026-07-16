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
   * Absolute-RSS backstop as a percent of the EFFECTIVE KILL CEILING — the
   * own-cgroup memory limit where one applies, else physical RAM. Default 90.
   * Anchored to the ceiling (not the budget) so a large-but-stable working set
   * above the deliberately-small budget never exits a healthy daemon; the
   * critical tier handles that by refusing new expensive work and staying
   * alive. This only fires when the kernel/cgroup OOM killer is genuinely
   * imminent and the leak was too slow for the rate tripwire to see.
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
    hardLimitPct: 90,
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
    default: 90,
    description:
      'Absolute-memory backstop as a percent of the EFFECTIVE KILL CEILING — the daemon\'s own cgroup memory limit where one applies, else physical RAM. If RSS holds at/above this percent of that ceiling for memory.tripwire.sustainSec, the governor writes a hard-limit receipt and exits so a supervisor restarts clean — catching a leak too slow for memory.tripwire.rateMbPerSec just before the kernel/cgroup OOM killer would strike. Default 90: fire at 90% of the real kill line, leaving a safety margin for the exit itself. Deliberately anchored to the kill ceiling and NOT to memory.budgetMb: the budget caps small by design (25% of RAM, max 4096 MB), and a large-but-stable working set above the budget on a big-RAM host is handled by the critical tier (refuse new expensive work, stay alive) — anchoring the exit to the budget would put such a healthy daemon in a permanent restart loop.',
    ...intRange(1, 100),
  },
];
