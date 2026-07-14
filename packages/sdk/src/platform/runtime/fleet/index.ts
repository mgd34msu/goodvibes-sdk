/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

// ── Fleet — live process registry ───────────────────────────────────────────
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
  ProcessAttention,
  ProcessAttentionReason,
  ProcessHeadline,
  ProcessStallTell,
  ObservedAgentKind,
  ObservedSteerChannel,
  ObservedLiveness,
  ProcessObserved,
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
export {
  HEADLINE_MAX_CHARS,
  DEFAULT_STALL_TELL_MS,
  headlineSource,
  deriveStallTell,
  HeadlineTable,
} from './headlines.js';
export { withFleetArchive } from './archive.js';
export { attachFleetEmitBridge } from './emit-bridge.js';
export type { FleetEmitBridgeDeps } from './emit-bridge.js';
export type { ArchivableProcessRegistry, FleetArchiveResult, FleetArchiveView } from './archive.js';
export { chainNodeId, subtaskNodeId, workItemNodeId } from './adapters/agent.js';
export { scheduleNodeId } from './adapters/schedule.js';
export { workstreamNodeId, phaseNodeId } from './adapters/orchestration.js';
export { codeIndexNodeId } from './adapters/code-index.js';
export type { CodeIndexProcessSource } from './adapters/code-index.js';
// Observed foreign-agent rows: the render-facing TYPES ship through the type
// block above (ProcessObserved etc.); the detector/source/adapter VALUES stay
// daemon-internal (imported directly from ./observed/* and ./adapters/observed.js
// where composed), so no observed runtime code is dragged into this barrel entry.
