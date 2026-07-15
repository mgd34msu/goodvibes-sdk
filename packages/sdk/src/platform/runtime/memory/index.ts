/**
 * runtime/memory — SDK-owned memory governance layer.
 *
 * The daemon defends its own footprint: a registry of every retained cache, a
 * seam to pause deferrable background jobs, and a governor that samples RSS/heap,
 * sheds memory by tier, and trips on a genuine leak before the OS OOM-kills it.
 */
export {
  CacheRegistry,
  KNOWN_MEMORY_CACHES,
  isMemoryCacheRegistered,
  assertMemoryCacheRegistered,
  type MemoryCacheId,
  type RegisteredCache,
  type CacheTrimLevel,
  type CacheFootprint,
} from './cache-registry.js';

export {
  PauseController,
  type PausableJob,
  type PausableJobState,
} from './pause-controller.js';

export {
  createMemoryGovernance,
  wireDaemonMemoryGovernance,
  type MemoryGovernanceHandles,
  type MemoryGovernanceWiringOptions,
  type DaemonMemoryGovernanceOptions,
} from './wiring.js';

export {
  MemoryGovernor,
  resolveEffectiveSystemRamMb,
  type MemoryTier,
  type MemorySample,
  type MemorySampler,
  type MemoryGovernorConfig,
  type MemoryGovernorDeps,
  type MemoryGovernorSnapshot,
  type MemoryPressureEvent,
  type MemoryTripwireReceipt,
  type ExpensiveWorkDecision,
} from './memory-governor.js';
