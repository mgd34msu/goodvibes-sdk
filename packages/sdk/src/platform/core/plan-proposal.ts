/**
 * Plan proposal types + pure assembler.
 *
 * This module turns a loose decomposition (produced by an LLM planning agent,
 * or handed in directly by a caller) into a validated, typed `PlanProposal`.
 * It is intentionally free of I/O and LLM calls: no filesystem access, no
 * agent spawning, no network. It exists so `AdaptivePlanner` can stay a
 * synchronous, deterministic, side-effect-free scorer while still producing
 * a rich, structured artifact that an orchestration engine can render for
 * human approval and (once approved) instantiate.
 *
 * A `PlanProposal` is DATA. It is never instantiated on its own — approval
 * flows through the existing `ProjectPlanningState.executionApproved` gate
 * (see `planProposalToPlanningState` below), and durable persistence reuses
 * `ExecutionPlanManager` (see `planProposalToExecutionPlanItems` below).
 * Neither adapter performs any I/O itself; they only shape data for callers
 * that do.
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionStrategy } from './adaptive-planner.js';
import type { PlanItem } from './execution-plan.js';
import type {
  ProjectPlanningDependency,
  ProjectPlanningState,
  ProjectPlanningTask,
} from '../knowledge/project-planning/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Archetypes a work item can suggest for its executing agent. Open-ended by design. */
export type WorkItemArchetype = 'engineer' | 'reviewer' | 'tester' | 'researcher' | 'integrator' | string;

/**
 * A single unit of work inside a proposal.
 *
 * Field shapes deliberately mirror three existing types so downstream bridges
 * are near-1:1 maps rather than translations:
 *   - knowledge `ProjectPlanningTask` (approval-render bridge)
 *   - knowledge `ProjectWorkPlanTask` (phaseId/dependency naming)
 *   - core `PlanItem` (persistence bridge)
 */
export interface WorkItem {
  id: string;
  title: string;
  brief: string;
  phaseId: string;
  dependsOn: string[];
  suggestedArchetype?: WorkItemArchetype | undefined;
  likelyFiles?: string[] | undefined;
  verification?: string[] | undefined;
  canRunConcurrently?: boolean | undefined;
  needsReview?: boolean | undefined;
  /**
   * Best-of-N: run this item as N sibling attempts in isolated worktrees and
   * HOLD the merge for a winner pick instead of auto-merging (the orchestration
   * engine's best-of-N — platform/orchestration/attempts.ts). Previously the
   * plan format constrained this OUT (every item was single-attempt); the engine
   * now supports it, so a planner may propose it. CONSTRAINT: a best-of-N item is
   * a LEAF — it declares no dependencies and nothing depends on it (the winner is
   * chosen by pick, not by the dependency graph). Omitted/1 ⇒ an ordinary single
   * item. Only honored under `worktree` workstream isolation.
   */
  attempts?: number | undefined;
  /** Best-of-N: allow a judge proposal to auto-pick this item's winner (opt-in; default: a human picks). */
  autoAcceptWinner?: boolean | undefined;
}

export interface Phase {
  id: string;
  title: string;
  description?: string | undefined;
  order: number;
}

/** Where a proposal's decomposition came from. */
export type PlanProposalSource = 'planner-agent' | 'single-item-fallback' | 'caller-supplied';

/**
 * Honest provenance for how a proposal's work items were produced.
 *
 * - `'agent'`     — a read-only planning agent decomposed the goal, and its
 *   output validated cleanly (possibly after one repair attempt).
 * - `'heuristic'` — the deterministic single-item path produced the proposal,
 *   either because `planner.decomposition` is configured to `'heuristic'`, the
 *   planner's gate declined to decompose, or the agent path failed and fell
 *   back. `fallbackReason` is set only in the failure case, never when the
 *   heuristic path was chosen deliberately by config or gate.
 */
export type DecomposedBy = 'agent' | 'heuristic';

/** Token usage reported by a planning-decomposition agent run. */
export interface DecompositionAgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly totalTokens: number;
}

export interface PlanProposal {
  id: string;
  task: string;
  strategy: ExecutionStrategy;
  rationale: string;
  phases: Phase[];
  workItems: WorkItem[];
  createdAt: number;
  source: PlanProposalSource;
  /**
   * Provenance overlay set by the decomposition service (plan-decomposition.ts).
   * Absent on proposals produced directly by `assemblePlanProposal` /
   * `singleItemProposal`, which stay byte-compatible with pre-provenance tests.
   */
  decomposedBy?: DecomposedBy | undefined;
  /** Token usage of the planning agent (present when the agent path ran, even on fallback). */
  agentUsage?: DecompositionAgentUsage | undefined;
  /** Estimated dollar cost of the planning agent run, when a pricing lookup was available. */
  agentCostUsd?: number | undefined;
  /** Wall-clock time the planning agent ran, in ms (present when the agent path ran). */
  elapsedMs?: number | undefined;
  /**
   * Why the agent path fell back to the heuristic path. Set ONLY on honest
   * failure fallbacks (spawn error, timeout, cancellation, or output that was
   * still malformed after one repair attempt) — never when `'heuristic'` was
   * chosen by config or by the planner's decompose gate.
   */
  fallbackReason?: string | undefined;
}

/** The loose JSON shape a planning agent (or a caller) emits, pre-validation. */
export interface RawDecompositionPhase {
  title: string;
  description?: string | undefined;
}

export interface RawDecompositionWorkItem {
  title: string;
  brief: string;
  phase: string;
  dependsOn?: string[] | undefined;
  suggestedArchetype?: string | undefined;
  likelyFiles?: string[] | undefined;
  verification?: string[] | undefined;
  canRunConcurrently?: boolean | undefined;
  needsReview?: boolean | undefined;
  /** Best-of-N sibling attempts (see WorkItem.attempts). Omitted/1 ⇒ single item. */
  attempts?: number | undefined;
  /** Best-of-N: allow a judge proposal to auto-pick this item's winner (opt-in). */
  autoAcceptWinner?: boolean | undefined;
}

export interface RawDecomposition {
  phases: RawDecompositionPhase[];
  workItems: RawDecompositionWorkItem[];
}

/** Kinds of honest-partial issues `assemblePlanProposal` can flag without throwing. */
export type PlanProposalIssueKind = 'dangling-dependency' | 'dependency-cycle' | 'unresolved-phase';

export interface PlanProposalIssue {
  readonly kind: PlanProposalIssueKind;
  readonly workItemTitle: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeKey(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Detect dependency cycles in a resolved work-item graph without ever
 * looping forever: each id is visited at most once per traversal state
 * (`visiting` blocks re-entry into an in-progress path; `done` short-circuits
 * repeat visits from other roots).
 */
function detectCycleTitles(workItems: readonly WorkItem[]): string[] {
  const byId = new Map(workItems.map((item) => [item.id, item] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();

  const visit = (id: string, stack: readonly string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(id);
      const cycle = cycleStart === -1 ? stack : stack.slice(cycleStart);
      for (const cycleId of cycle) cyclic.add(cycleId);
      return;
    }
    state.set(id, 'visiting');
    const item = byId.get(id);
    if (item) {
      for (const dep of item.dependsOn) {
        visit(dep, [...stack, id]);
      }
    }
    state.set(id, 'done');
  };

  for (const item of workItems) visit(item.id, []);
  return workItems.filter((item) => cyclic.has(item.id)).map((item) => item.title);
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Turn a raw decomposition into a validated, typed `PlanProposal`.
 *
 * Never throws. Malformed input degrades to an honest partial result: an
 * unresolved phase reference lands its work item in a synthesized "Unphased"
 * bucket; an unresolved dependency reference is dropped; a dependency cycle
 * is flagged but left in place (no silent edge removal). Every problem is
 * reported via the returned `issues` list rather than an exception.
 *
 * Dependency resolution mirrors `ExecutionPlanManager.replaceItems` exactly:
 * a dep that already looks like a UUID passes through unchecked, otherwise
 * it is resolved by case-insensitive title match, otherwise it is dropped.
 *
 * `source` defaults to `'planner-agent'` (the expected majority caller —
 * `AdaptivePlanner.proposeWorkstream`). Pass `'caller-supplied'` when a
 * non-agent caller hands in its own decomposition directly.
 */
export function assemblePlanProposal(
  task: string,
  strategy: ExecutionStrategy,
  raw: RawDecomposition,
  source: Extract<PlanProposalSource, 'planner-agent' | 'caller-supplied'> = 'planner-agent',
): { proposal: PlanProposal; issues: PlanProposalIssue[] } {
  const issues: PlanProposalIssue[] = [];

  // Pass 1: assign phase ids + stable order, index by normalized title.
  const phaseByTitle = new Map<string, Phase>();
  const phases: Phase[] = raw.phases.map((rawPhase, index) => {
    const phase: Phase = {
      id: randomUUID(),
      title: rawPhase.title,
      order: index,
      ...(rawPhase.description ? { description: rawPhase.description } : {}),
    };
    phaseByTitle.set(normalizeKey(rawPhase.title), phase);
    return phase;
  });

  let unphased: Phase | null = null;
  const resolvePhaseId = (title: string): { id: string; matched: boolean } => {
    const found = phaseByTitle.get(normalizeKey(title));
    if (found) return { id: found.id, matched: true };
    if (!unphased) {
      unphased = { id: randomUUID(), title: 'Unphased', order: phases.length };
      phases.push(unphased);
    }
    return { id: unphased.id, matched: false };
  };

  // Pass 2: assign work-item ids, index by normalized title (for dep resolution).
  const idByTitle = new Map<string, string>();
  const provisional = raw.workItems.map((rawItem) => {
    const id = randomUUID();
    idByTitle.set(normalizeKey(rawItem.title), id);
    return { id, rawItem };
  });

  const workItems: WorkItem[] = provisional.map(({ id, rawItem }) => {
    const { id: phaseId, matched } = resolvePhaseId(rawItem.phase);
    if (!matched) {
      issues.push({
        kind: 'unresolved-phase',
        workItemTitle: rawItem.title,
        message: `Work item "${rawItem.title}" referenced unknown phase "${rawItem.phase}"; placed in "Unphased".`,
      });
    }
    return {
      id,
      title: rawItem.title,
      brief: rawItem.brief,
      phaseId,
      dependsOn: [],
      ...(rawItem.suggestedArchetype ? { suggestedArchetype: rawItem.suggestedArchetype } : {}),
      ...(rawItem.likelyFiles ? { likelyFiles: rawItem.likelyFiles } : {}),
      ...(rawItem.verification ? { verification: rawItem.verification } : {}),
      ...(rawItem.canRunConcurrently !== undefined ? { canRunConcurrently: rawItem.canRunConcurrently } : {}),
      ...(rawItem.needsReview !== undefined ? { needsReview: rawItem.needsReview } : {}),
      ...(rawItem.attempts !== undefined ? { attempts: rawItem.attempts } : {}),
      ...(rawItem.autoAcceptWinner !== undefined ? { autoAcceptWinner: rawItem.autoAcceptWinner } : {}),
    } satisfies WorkItem;
  });

  // Pass 3: resolve dependsOn — UUID passthrough, else case-insensitive title lookup, else drop.
  for (let i = 0; i < workItems.length; i++) {
    const rawDeps = raw.workItems[i]?.dependsOn;
    if (!rawDeps || rawDeps.length === 0) continue;
    const item = workItems[i]!;
    const resolved: string[] = [];
    for (const dep of rawDeps) {
      if (UUID_RE.test(dep)) {
        resolved.push(dep);
        continue;
      }
      const depId = idByTitle.get(normalizeKey(dep));
      if (depId) {
        resolved.push(depId);
      } else {
        issues.push({
          kind: 'dangling-dependency',
          workItemTitle: item.title,
          message: `Work item "${item.title}" depends on unresolved item "${dep}"; dependency dropped.`,
        });
      }
    }
    item.dependsOn = resolved;
  }

  // Pass 4: flag (do not silently fix) dependency cycles.
  for (const title of detectCycleTitles(workItems)) {
    issues.push({
      kind: 'dependency-cycle',
      workItemTitle: title,
      message: `Work item "${title}" is part of a dependency cycle.`,
    });
  }

  const proposal: PlanProposal = {
    id: randomUUID(),
    task,
    strategy,
    rationale: `Decomposed "${task}" into ${phases.length} phase(s) and ${workItems.length} work item(s) for ${strategy} execution.`,
    phases,
    workItems,
    createdAt: Date.now(),
    source,
  };

  return { proposal, issues };
}

/**
 * The honest fallback: one phase ("Execute"), one work item whose title and
 * brief both equal the task text, no dependencies. Used whenever decomposition
 * was not warranted (see `AdaptivePlanner.shouldDecompose`) or no raw
 * decomposition is available yet.
 */
export function singleItemProposal(task: string): PlanProposal {
  const phaseId = randomUUID();
  return {
    id: randomUUID(),
    task,
    strategy: 'single',
    rationale: `No decomposition applied; running "${task}" as a single work item.`,
    phases: [{ id: phaseId, title: 'Execute', order: 0 }],
    workItems: [{
      id: randomUUID(),
      title: task,
      brief: task,
      phaseId,
      dependsOn: [],
    }],
    createdAt: Date.now(),
    source: 'single-item-fallback',
  };
}

// ---------------------------------------------------------------------------
// Approval-seam adapter: PlanProposal -> ProjectPlanningState
// ---------------------------------------------------------------------------

/**
 * Project a `PlanProposal` into the existing `/plan approve` seam. This is
 * data-only — no store is written here. The caller feeds the result into
 * `ProjectPlanningService.upsertState` (or an equivalent), which is what
 * actually persists it and evaluates readiness.
 *
 * Direction convention for the emitted `ProjectPlanningDependency` records
 * (this type has no prior producer in the codebase to inherit a convention
 * from, so it is fixed here): `fromTaskId` depends on `toTaskId`, i.e. the
 * edge reads "fromTaskId depends on toTaskId" the same way `WorkItem.dependsOn`
 * reads "this item depends on these ids".
 *
 * `ProjectPlanningTask` has no first-class phase concept, so phase
 * membership is preserved in `metadata` rather than dropped silently.
 *
 * `executionApproved` is always `false` here — approval is a separate,
 * explicit step owned by `/plan approve` (planning-runtime.ts), never implied
 * by proposing.
 */
export function planProposalToPlanningState(proposal: PlanProposal): Partial<ProjectPlanningState> {
  const phaseTitleById = new Map(proposal.phases.map((phase) => [phase.id, phase.title] as const));

  const tasks: ProjectPlanningTask[] = proposal.workItems.map((item) => ({
    id: item.id,
    title: item.title,
    why: item.brief,
    status: 'pending',
    ...(item.dependsOn.length > 0 ? { dependencies: item.dependsOn } : {}),
    ...(item.likelyFiles ? { likelyFiles: item.likelyFiles } : {}),
    ...(item.verification ? { verification: item.verification } : {}),
    ...(item.canRunConcurrently !== undefined ? { canRunConcurrently: item.canRunConcurrently } : {}),
    ...(item.needsReview !== undefined ? { needsReview: item.needsReview } : {}),
    ...(item.suggestedArchetype ? { recommendedAgent: item.suggestedArchetype } : {}),
    metadata: {
      phaseId: item.phaseId,
      ...(phaseTitleById.has(item.phaseId) ? { phaseTitle: phaseTitleById.get(item.phaseId) } : {}),
    },
  }));

  const dependencies: ProjectPlanningDependency[] = proposal.workItems.flatMap((item) =>
    item.dependsOn.map((toTaskId) => ({ fromTaskId: item.id, toTaskId })),
  );

  const scope = proposal.phases.length > 0
    ? `Phases: ${proposal.phases.map((phase) => phase.title).join(', ')}`
    : undefined;

  return {
    goal: proposal.task,
    ...(scope ? { scope } : {}),
    ...(proposal.rationale ? { assumptions: [proposal.rationale] } : {}),
    tasks,
    dependencies,
    executionApproved: false,
  };
}

// ---------------------------------------------------------------------------
// Persistence adapter: PlanProposal -> ExecutionPlanManager's PlanItem shape
// ---------------------------------------------------------------------------

/**
 * Project a `PlanProposal` into the plain items `ExecutionPlanManager` deals
 * in. This is a deliberately lossy projection: `PlanItem` has no room for
 * verification/likelyFiles/suggestedArchetype, and those stay in the
 * full-fidelity `ProjectPlanningState` render above. It exists purely so a
 * caller can hand a proposal's items to `ExecutionPlanManager` without
 * re-deriving the phase/description/dependency shape by hand.
 *
 * Dependencies are expressed as WORK ITEM TITLES, not ids, because
 * `ExecutionPlanManager.create()` does not resolve dependency references —
 * only `ExecutionPlanManager.replaceItems()` does, by case-insensitive
 * description match. The intended call sequence at instantiation is
 * therefore:
 *
 *   const plan = planManager.create(title, []);
 *   const { items } = planProposalToExecutionPlanItems(proposal);
 *   planManager.replaceItems(plan.id, items);
 *
 * which reuses `replaceItems`' existing dependency resolver end-to-end
 * instead of re-implementing dependency resolution here. This module defines
 * no scheduler of its own — ready-to-run item selection stays
 * `ExecutionPlanManager.getNextItems`'s job.
 */
export function planProposalToExecutionPlanItems(
  proposal: PlanProposal,
): { title: string; items: Array<Omit<PlanItem, 'id' | 'status'>> } {
  const phaseTitleById = new Map(proposal.phases.map((phase) => [phase.id, phase.title] as const));
  const titleById = new Map(proposal.workItems.map((item) => [item.id, item.title] as const));

  const items: Array<Omit<PlanItem, 'id' | 'status'>> = proposal.workItems.map((item) => ({
    phase: phaseTitleById.get(item.phaseId) ?? 'Unphased',
    description: item.title,
    ...(item.dependsOn.length > 0
      ? { dependencies: item.dependsOn.map((depId) => titleById.get(depId) ?? depId) }
      : {}),
  }));

  return { title: proposal.task, items };
}
