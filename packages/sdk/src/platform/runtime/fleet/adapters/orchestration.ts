/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Orchestration-engine fleet adapters (Wave 4, wo701) — Workstream/Phase/
 * WorkItem -> ProcessNode, mirroring adapters/wrfc.ts's chain/subtask
 * pattern: a workstream is a root node (no native cancel of its own, so kill
 * is DERIVED — cascades AgentManager.cancel over every agent any item ever
 * spawned, same shape as adaptChain/cancelAgents), a phase is a pure grouping
 * node (no lifecycle, no usage — same "report nothing" choice adaptSubtask
 * makes, since attributing a work-item's CUMULATIVE usage to whichever phase
 * it currently sits in would double-count across phases), and a work-item is
 * the WRFC-subtask analogue: it delegates interrupt/kill/steer to its
 * current live agent when it has one.
 */
import type { Phase, WorkItem, Workstream } from '../../../orchestration/types.js';
import type { ProcessNode, ProcessState, ProcessUsage } from '../types.js';
import { workItemNodeId } from './agent.js';

/** Workstream node ids are namespaced to avoid colliding with agent/process ids. */
export function workstreamNodeId(workstreamId: string): string {
  return `workstream:${workstreamId}`;
}

/**
 * Phase node ids are namespaced by their owning workstream — phase ids are
 * only unique WITHIN a workstream, so two workstreams' phases must not
 * collide in the flat node list.
 */
export function phaseNodeId(workstreamId: string, phaseId: string): string {
  return `phase:${workstreamId}:${phaseId}`;
}

export { workItemNodeId };

const TERMINAL_ITEM_STATES: ReadonlySet<WorkItem['state']> = new Set(['passed', 'failed']);

/** The work-item's currently-active agent, i.e. the one driving its live phase run. Undefined once terminal or between phases. */
export function activeWorkItemAgentId(item: WorkItem): string | undefined {
  return item.state === 'in-phase' ? item.agentId : undefined;
}

function workItemState(item: WorkItem): ProcessState {
  switch (item.state) {
    case 'passed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'awaiting-capacity':
      return 'queued';
    case 'blocked-budget':
      // Honest "stuck, not progressing" signal reusing an existing state
      // rather than adding a new one (charter: prefer existing-contract
      // reuse). Distinct from 'queued': a queued item WILL be claimed by
      // free capacity; a blocked-budget item will not until its workstream's
      // ceiling rises (or is cleared) via OrchestrationEngine.updateBudget —
      // computeClaims (scheduler.ts) keeps it in the waiting set so that
      // reconsideration is automatic the instant the ceiling changes, but a
      // fixed ceiling on its own never lifts the block (usage only grows).
      return 'stalled';
    case 'in-phase':
      return 'executing-tool';
  }
}

function workstreamState(workstream: Workstream): ProcessState {
  if (workstream.items.length === 0) return 'idle';
  if (workstream.items.some((item) => item.state === 'in-phase')) return 'executing-tool';
  if (workstream.items.some((item) => item.state === 'pending' || item.state === 'awaiting-capacity')) return 'queued';
  if (workstream.items.some((item) => item.state === 'blocked-budget')) return 'stalled';
  return workstream.items.some((item) => item.state === 'failed') ? 'failed' : 'done';
}

function phaseState(workstream: Workstream, phase: Phase): ProcessState {
  const occupants = workstream.items.filter((item) => item.currentPhaseId === phase.id && item.state === 'in-phase');
  if (occupants.length > 0) return 'executing-tool';
  const everVisited = workstream.items.some((item) => (item.visits.get(phase.id) ?? 0) > 0);
  if (!everVisited) return 'idle';
  const allTerminal = workstream.items.every((item) => TERMINAL_ITEM_STATES.has(item.state));
  return allTerminal ? 'done' : 'idle';
}

/** token-count-only rollup over a workstream's items (cost handled separately — see aggregateWorkItemCost). */
function sumWorkItemUsage(items: readonly WorkItem[]): ProcessUsage | undefined {
  if (items.length === 0) return undefined;
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    llmCallCount: 0,
    turnCount: 0,
    toolCallCount: 0,
  };
  let sawReasoning = false;
  for (const item of items) {
    const usage = item.usage;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    if (usage.reasoningTokens !== undefined) {
      sawReasoning = true;
      total.reasoningTokens += usage.reasoningTokens;
    }
    total.llmCallCount += usage.llmCallCount;
    total.turnCount += usage.turnCount;
    total.toolCallCount += usage.toolCallCount;
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheReadTokens: total.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    reasoningTokens: sawReasoning ? total.reasoningTokens : undefined,
    llmCallCount: total.llmCallCount,
    turnCount: total.turnCount,
    toolCallCount: total.toolCallCount,
  };
}

/** Honest cost rollup: all-priced -> 'priced'; none -> null/'unpriced'; mixed -> summed subset, 'estimated'. Mirrors adapters/wrfc.ts aggregateCost. */
function aggregateWorkItemCost(items: readonly WorkItem[]): { costUsd: number | null; costState: ProcessNode['costState'] } {
  const withUsage = items.filter((item) => item.usage.costState !== 'unpriced' || item.usage.inputTokens > 0 || item.usage.outputTokens > 0);
  if (withUsage.length === 0) return { costUsd: null, costState: 'unpriced' };
  const priced = withUsage.filter((item) => item.usage.costState === 'priced' && item.usage.costUsd !== null);
  if (priced.length === 0) return { costUsd: null, costState: 'unpriced' };
  const total = priced.reduce((sum, item) => sum + (item.usage.costUsd as number), 0);
  return { costUsd: total, costState: priced.length === withUsage.length ? 'priced' : 'estimated' };
}

/** WorkItem -> ProcessNode. Delegates interruptible/killable/steerable to its currently-active agent, mirroring adaptSubtask. */
export function adaptWorkItem(item: WorkItem, workstreamId: string, parentId: string, opts: { steerable: boolean }): ProcessNode {
  const state = workItemState(item);
  const killable = !TERMINAL_ITEM_STATES.has(item.state);
  const activeAgentId = activeWorkItemAgentId(item);
  return {
    id: workItemNodeId(item.id),
    kind: 'work-item',
    parentId,
    label: item.title,
    task: item.task,
    state,
    startedAt: item.createdAt,
    completedAt: item.completedAt,
    elapsedMs: Math.max(0, (item.completedAt ?? Date.now()) - item.createdAt),
    usage: item.usage.inputTokens > 0 || item.usage.outputTokens > 0
      ? {
          inputTokens: item.usage.inputTokens,
          outputTokens: item.usage.outputTokens,
          cacheReadTokens: item.usage.cacheReadTokens,
          cacheWriteTokens: item.usage.cacheWriteTokens,
          reasoningTokens: item.usage.reasoningTokens,
          llmCallCount: item.usage.llmCallCount,
          turnCount: item.usage.turnCount,
          toolCallCount: item.usage.toolCallCount,
        }
      : undefined,
    costUsd: item.usage.costUsd,
    costState: item.usage.costState,
    // Blocked-budget items surface their reason (set/cleared by the engine
    // alongside the state transition, types.ts WorkItem.blockedReason) in
    // place of the bare phase id — the phase id alone doesn't tell an
    // operator WHY the item stopped moving.
    currentActivity: item.currentPhaseId
      ? { kind: 'phase', text: item.state === 'blocked-budget' && item.blockedReason ? item.blockedReason : item.currentPhaseId, at: item.createdAt }
      : undefined,
    capabilities: {
      interruptible: activeAgentId !== undefined,
      killable,
      pausable: false,
      resumable: false,
      steerable: activeAgentId !== undefined && opts.steerable,
    },
    sessionRef: activeAgentId ? { agentId: activeAgentId } : undefined,
    raw: { item, workstreamId },
  };
}

/**
 * Phase -> ProcessNode. Deliberately reports NO usage/cost (mirrors
 * adaptSubtask's "report nothing" choice): a work-item's usage is cumulative
 * across every phase it has visited, so attributing it to whichever phase it
 * currently occupies would double-count against both the phase and the
 * workstream total. Real numbers live on the workstream (sums every item
 * exactly once) and the work-item (its own direct total) — never on phase.
 */
export function adaptPhase(phase: Phase, workstream: Workstream): ProcessNode {
  const state = phaseState(workstream, phase);
  return {
    id: phaseNodeId(workstream.id, phase.id),
    kind: 'phase',
    parentId: workstreamNodeId(workstream.id),
    label: `${phase.kind} (${phase.role})`,
    state,
    startedAt: workstream.createdAt,
    completedAt: state === 'done' ? workstream.items.reduce<number | undefined>(
      (latest, item) => (item.completedAt !== undefined && (latest === undefined || item.completedAt > latest) ? item.completedAt : latest),
      undefined,
    ) : undefined,
    elapsedMs: 0,
    usage: undefined,
    costUsd: null,
    costState: 'unpriced',
    currentActivity: undefined,
    // Pure grouping node: no conversation loop, no native single-phase
    // cancel (killing work belongs to the work-items running IN the phase).
    capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false },
    raw: phase,
  };
}

/**
 * Workstream -> ProcessNode. Root node (no parentId). Sums every item's
 * usage/cost exactly once (never through an intermediate phase bucket — see
 * adaptPhase) so this total can never double-count.
 */
export function adaptWorkstream(workstream: Workstream, now: number): ProcessNode {
  const state = workstreamState(workstream);
  const killable = state !== 'done' && state !== 'failed';
  const completedAt = (state === 'done' || state === 'failed')
    ? workstream.items.reduce<number | undefined>(
        (latest, item) => (item.completedAt !== undefined && (latest === undefined || item.completedAt > latest) ? item.completedAt : latest),
        undefined,
      )
    : undefined;
  const { costUsd, costState } = aggregateWorkItemCost(workstream.items);
  return {
    id: workstreamNodeId(workstream.id),
    kind: 'workstream',
    parentId: undefined,
    label: workstream.title,
    state,
    startedAt: workstream.createdAt,
    completedAt,
    elapsedMs: Math.max(0, (completedAt ?? now) - workstream.createdAt),
    usage: sumWorkItemUsage(workstream.items),
    costUsd,
    costState,
    currentActivity: undefined,
    // A workstream is an FSM coordinating work-items, not itself a
    // conversation loop — steer a work-item instead (mirrors wrfc-chain).
    // Kill is DERIVED (no native single-call cancel): cascades
    // AgentManager.cancel over every agent any item ever spawned — see
    // registry.ts killNode's 'workstream' case.
    capabilities: { interruptible: false, killable, pausable: false, resumable: false, steerable: false },
    raw: workstream,
  };
}
