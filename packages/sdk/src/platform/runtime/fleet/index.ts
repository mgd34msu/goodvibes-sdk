/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

// ── Fleet — live process registry (W2.1) ────────────────────────────────────
// Curated named-export barrel (no `export *`), mirroring the observability
// barrel convention: the public fleet surface is an explicit allowlist.
export type {
  ProcessKind,
  ProcessState,
  ProcessUsage,
  ProcessActivity,
  ProcessCapabilities,
  ProcessSessionRef,
  ProcessCostState,
  ProcessNode,
  FleetSnapshot,
  FleetQueryFilter,
  ProcessKillOptions,
  ProcessRegistry,
  SteerResult,
} from './types.js';
export type { ProcessRegistryDeps, RegistryTimers } from './registry.js';
export {
  createProcessRegistry,
  DEFAULT_STALLED_THRESHOLD_MS,
  DEFAULT_TICK_INTERVAL_MS,
  STEER_TTL_MS,
} from './registry.js';
export { chainNodeId, subtaskNodeId, workItemNodeId } from './adapters/agent.js';
export { scheduleNodeId } from './adapters/schedule.js';
export { workstreamNodeId, phaseNodeId } from './adapters/orchestration.js';
