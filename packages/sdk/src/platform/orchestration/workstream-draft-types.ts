// ---------------------------------------------------------------------------
// workstream-draft-types.ts, the not-yet-launched proposal's data shape
//
// Held separately from workstream-services.ts so the durable draft store
// (workstream-draft-store.ts) has a type to persist WITHOUT importing back into
// the service construction module, that back-edge would form an import cycle
// the architecture check rejects. workstream-services.ts re-exports both types,
// so a caller can import them from either place.
// ---------------------------------------------------------------------------

import type { CreateWorkstreamInput } from './engine.js';
import type { DecompositionGate } from '../core/adaptive-planner.js';
import type { PlanProposal } from '../core/plan-proposal.js';

/**
 * Honest provenance for how a draft's decomposition was produced. Derived from
 * the decomposition service's outcome so the draft render can state plainly
 * whether a planning agent decomposed the goal, or the heuristic path did (and
 * if so, why).
 */
export interface WorkstreamDraftProvenance {
  readonly kind: 'agent' | 'heuristic-configured' | 'gate-declined' | 'fallback';
  readonly itemCount: number;
  readonly agentCostUsd?: number | undefined;
  readonly agentTokens?: number | undefined;
  readonly elapsedMs?: number | undefined;
  readonly fallbackReason?: string | undefined;
}

/** A not-yet-launched workstream proposal. Facade-owned (the engine has no draft concept) and journaled to disk via workstream-draft-store.ts so it survives a restart. See workstream-services.ts's header doc. */
export interface WorkstreamDraft {
  readonly id: string;
  task: string;
  spec: CreateWorkstreamInput;
  readonly gate: DecompositionGate;
  /** The engine-agnostic decomposition proposal (model- or heuristic-produced). */
  proposal: PlanProposal;
  /** How that proposal came to be, for honest rendering. */
  provenance: WorkstreamDraftProvenance;
  approved: boolean;
  readonly createdAt: number;
}
