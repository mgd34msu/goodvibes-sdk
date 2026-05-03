/**
 * Forensics subsystem — public API.
 *
 * Usage:
 * 1. Create a ForensicsRegistry owned by the current runtime/session.
 * 2. Create a ForensicsCollector, passing the RuntimeEventBus and registry.
 * 3. The collector auto-generates reports on terminal failure states.
 * 4. Pass the registry to ForensicsPanel (diagnostic provider) and the
 *    /forensics command handler via CommandContext.forensicsRegistry.
 */
export type {
  FailureReport,
  FailureClass,
  PhaseTimingEntry,
  CausalChainEntry,
  ForensicsJumpLink,
  ForensicsBundle,
  ForensicsReplayEvidence,
  ForensicsEvidenceSummary,
} from './types.js';
export type { ReplaySnapshotInput } from './registry.js';
export { classifyFailure, summariseFailure } from './classifier.js';
export { ForensicsRegistry, DEFAULT_REGISTRY_LIMIT } from './registry.js';
export { ForensicsCollector } from './collector.js';
