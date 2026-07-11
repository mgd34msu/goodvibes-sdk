/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Proposal → workstream assembly (BIG-3 item 1) — the final stage of the
 * WRFC→orchestration migration. `fromPlanProposal()` maps an APPROVED
 * PlanProposal (platform/core/plan-proposal.ts, produced by the BIG-2 planner
 * decomposition pipeline) into a `CreateWorkstreamInput` the engine can run
 * directly, so `/workstream launch` executes the REAL multi-item plan instead
 * of flattening it through the `fromChainSpec` compat path.
 *
 * The mapping, one honest step at a time:
 *  - ONE work item per proposal work item. The proposal item's `title` becomes
 *    the work item's title and its `brief` becomes the work item's `task` — the
 *    prompt/context the phase agents actually run against (the phase-runner
 *    prepends "Work item: <title>" to review/fix prompts, so both survive into
 *    the agent's context). The proposal item's id is preserved so provenance,
 *    dependencies, and fleet nodes all line up 1:1.
 *  - Every item runs the SAME standard role-phase pipeline — engineer→review,
 *    the exact `engineerReviewPhases` template `fromChainSpec` uses
 *    (controller-compat.ts). The only per-assembly parameter is phase
 *    `capacity`: it defaults to the item count so independent items run
 *    concurrently (bounded only by their dependencies), where a single compat
 *    chain stays at capacity 1. Callers may cap concurrency via `opts.capacity`.
 *  - Inter-item dependencies carry over verbatim: `workItem.dependsOn` (already
 *    resolved to item ids by assemblePlanProposal) becomes the engine work
 *    item's `dependsOn`, which the scheduler gates the claim path on (an item
 *    is not claimable until every dependency reaches 'passed'; see the
 *    'blocked-dependency' state and applyDependencyGates).
 *  - Workstream-level provenance records where the plan came from
 *    (decomposedBy, proposalId, strategy, agent cost/elapsed).
 *  - Best-of-N (attempts.ts): a proposal item's `attempts`/`autoAcceptWinner`
 *    carry through to the engine work-item spec. Previously the plan format
 *    constrained best-of-N OUT (every item was single-attempt); the engine now
 *    supports it, so the planner may propose it and a consumer's plan format may
 *    re-enable the field. A best-of-N item may be NON-LEAF: it may declare its own
 *    `dependsOn` (each attempt inherits it) and other items may depend on it (they
 *    gate on the group's picked-and-merged winner — see WorkItemSpec.attempts and
 *    scheduler.ts dependencyStatus). Only expanded under `worktree` isolation.
 *
 * ASSERT-AT-ASSEMBLY (BIG-3 item 2): even though `assemblePlanProposal` already
 * rejects dangling dependencies and cycles, this function re-checks both and
 * THROWS on violation rather than quietly building a broken workstream — a
 * dangling dependency would gate an item on nothing, and a cycle would deadlock
 * every item in it forever in 'blocked-dependency'. Belt-and-braces, because a
 * caller could hand us a hand-built or mutated proposal that never went through
 * the assembler.
 */
import type { ConfigManager } from '../config/manager.js';
import { getWrfcCommitScope } from '../agents/wrfc-config.js';
import type { PlanProposal } from '../core/plan-proposal.js';
import { engineerReviewPhases } from './controller-compat.js';
import type { CreateWorkstreamInput } from './engine.js';
import type { WorkItemSpec, WorkstreamProvenance } from './types.js';

export interface FromPlanProposalOptions {
  /**
   * Per-phase capacity for the engineer/review phases. Defaults to the number
   * of work items, so all independent items can run concurrently (dependencies
   * still gate the rest). Set a lower value to cap concurrency; clamped to at
   * least 1.
   */
  readonly capacity?: number | undefined;
}

/** Throws if any item's `dependsOn` references an unknown item, or if the dependency graph contains a cycle. */
function assertAcyclicAndResolved(proposal: PlanProposal): void {
  const ids = new Set(proposal.workItems.map((wi) => wi.id));
  const byId = new Map(proposal.workItems.map((wi) => [wi.id, wi] as const));

  for (const wi of proposal.workItems) {
    for (const dep of wi.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(
          `fromPlanProposal: work item "${wi.title}" (${wi.id}) depends on unknown item id "${dep}" — the proposal is not internally consistent`,
        );
      }
    }
  }

  // Iterative DFS cycle detection over ids (white/grey/black).
  const state = new Map<string, 'visiting' | 'done'>();
  const onCycle = (id: string): never => {
    const title = byId.get(id)?.title ?? id;
    throw new Error(`fromPlanProposal: dependency cycle detected involving work item "${title}" (${id}) — cannot assemble a workstream that would deadlock`);
  };
  const visit = (start: string): void => {
    const stack: Array<{ id: string; deps: string[]; i: number }> = [{ id: start, deps: byId.get(start)?.dependsOn ?? [], i: 0 }];
    state.set(start, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.i >= frame.deps.length) {
        state.set(frame.id, 'done');
        stack.pop();
        continue;
      }
      const next = frame.deps[frame.i++]!;
      const seen = state.get(next);
      if (seen === 'visiting') onCycle(next);
      if (seen === 'done') continue;
      state.set(next, 'visiting');
      stack.push({ id: next, deps: byId.get(next)?.dependsOn ?? [], i: 0 });
    }
  };
  for (const wi of proposal.workItems) {
    if (!state.has(wi.id)) visit(wi.id);
  }
}

/**
 * Assemble a `CreateWorkstreamInput` from an approved multi-item PlanProposal.
 * See the module doc for the full mapping and the assembly-time assertions.
 */
export function fromPlanProposal(
  proposal: PlanProposal,
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
  opts: FromPlanProposalOptions = {},
): CreateWorkstreamInput {
  assertAcyclicAndResolved(proposal);

  const commitScope = getWrfcCommitScope(configManager);
  const capacity = Math.max(1, opts.capacity ?? proposal.workItems.length);

  const items: WorkItemSpec[] = proposal.workItems.map((wi) => ({
    id: wi.id,
    title: wi.title,
    // The brief IS the actionable prompt context; the engineer phase runs it
    // verbatim as the item's task, and review/fix phases see it alongside the
    // title (buildPhaseTask, phase-runner.ts).
    task: wi.brief,
    ...(wi.dependsOn.length > 0 ? { dependsOn: [...wi.dependsOn] } : {}),
    // Best-of-N carries through to the engine, which expands an attempts:N item
    // into N sibling attempts and holds the merge for a winner pick (attempts.ts).
    // Only honored under worktree isolation. May be non-leaf: dependents gate on
    // the group's picked-and-merged winner (scheduler.ts dependencyStatus).
    ...(wi.attempts !== undefined ? { attempts: wi.attempts } : {}),
    ...(wi.autoAcceptWinner !== undefined ? { autoAcceptWinner: wi.autoAcceptWinner } : {}),
  }));

  const provenance: WorkstreamProvenance = {
    ...(proposal.decomposedBy ? { decomposedBy: proposal.decomposedBy } : {}),
    proposalId: proposal.id,
    strategy: proposal.strategy,
    ...(proposal.agentCostUsd !== undefined ? { agentCostUsd: proposal.agentCostUsd } : {}),
    ...(proposal.elapsedMs !== undefined ? { elapsedMs: proposal.elapsedMs } : {}),
  };

  return {
    title: proposal.task,
    phases: engineerReviewPhases(commitScope, capacity),
    items,
    provenance,
  };
}
