/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Controller-compat (see CHANGELOG 0.38.0) — stage 1 of the 3-stage WrfcController
 * migration.
 *
 * `fromChainSpec()` produces the canned two-phase engineer->review
 * WORKSTREAM SPEC that a `WrfcController.createChain(ownerRecord)` call
 * would otherwise start — a NEW opt-in surface for callers that want the
 * engine-backed pipeline. It returns a `CreateWorkstreamInput` (a spec), not
 * a live `Workstream`: realizing one (generated ids, initialized item
 * state) is the engine's own responsibility via
 * `engine.createWorkstream(fromChainSpec(...))`, mirroring how the type
 * model already separates PhaseSpec/WorkItemSpec (input) from Phase/WorkItem
 * (engine-owned state).
 *
 * STAGE 1 (this wave, unchanged): WrfcController itself is NOT touched.
 * spawn-forced-wrfc, /teamwork, and archetypes all keep hitting
 * WrfcController.createChain via AgentManager.manager.ts:565 exactly as
 * before. This function is additive only.
 * STAGE 2 (later, feature-flagged): WrfcController.createChain internally
 * builds a workstream via this same helper and delegates execution to the
 * engine — the public seam (createChain's signature and the three entry
 * points) stays byte-for-byte unchanged.
 * STAGE 3 (future wave): retire the standalone WrfcController state machine
 * once parity is proven.
 */
import type { AgentRecord } from '../tools/agent/manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import { getWrfcCommitScope } from '../agents/wrfc-config.js';
import type { CreateWorkstreamInput } from './engine.js';
import type { PhaseSpec } from './types.js';

/**
 * The canonical engineer→review phase template (BIG-3 item 1). This is the ONE
 * definition of the standard two-phase pipeline; both the compat single-chain
 * bridge (`fromChainSpec`, capacity 1) and the multi-item proposal assembly
 * (`fromPlanProposal`, proposal-workstream.ts, capacity = item count) build
 * their phases from it — "the same phase template fromChainSpec uses",
 * parameterized only by the per-phase `capacity` knob so N proposal items can
 * run the engineer phase concurrently (dependency-gated) while a single chain
 * stays at capacity 1. Both phases carry the same commit scope; nothing else
 * varies per caller.
 */
export function engineerReviewPhases(commitScope: WrfcCommitScope, capacity = 1): PhaseSpec[] {
  return [
    { role: 'engineer', capacity, kind: 'engineer', gate: { scope: commitScope, gates: [] } },
    { role: 'reviewer', capacity, kind: 'review', gate: { scope: commitScope, gates: [] } },
  ];
}

export function fromChainSpec(
  ownerRecord: Pick<AgentRecord, 'id' | 'task'>,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
): CreateWorkstreamInput {
  const commitScope = getWrfcCommitScope(configManager);
  return {
    title: ownerRecord.task,
    items: [{ id: ownerRecord.id, title: ownerRecord.task, task: ownerRecord.task }],
    phases: engineerReviewPhases(commitScope, 1),
  };
}
