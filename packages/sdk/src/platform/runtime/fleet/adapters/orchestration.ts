/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Orchestration-engine fleet adapters — Workstream/Phase/
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
import { mergeCostSource, mergePricingAsOf, mergeWorkItemUsage } from '../../../orchestration/types.js';
import type { Phase, WorkItem, WorkItemCostSource, WorkItemUsage, Workstream } from '../../../orchestration/types.js';
import type { ProcessCostState, ProcessNode, ProcessState, ProcessUsage } from '../types.js';
import { workItemNodeId } from './agent.js';

/**
 * Live in-flight usage of a work-item's currently-active agent, read from that
 * agent's fleet node at snapshot time. Overlaid onto the
 * item's phase-boundary-committed `item.usage` so a RUNNING phase shows real,
 * growing numbers instead of n/a until it completes.
 */
export interface LiveItemUsage {
  readonly usage?: ProcessUsage | undefined;
  readonly costUsd?: number | null | undefined;
  readonly costState?: ProcessCostState | undefined;
  readonly costSource?: WorkItemCostSource | undefined;
  readonly pricingAsOf?: string | undefined;
}

/** True once a ProcessUsage carries any non-zero count worth surfacing. */
function hasAnyUsage(u: ProcessUsage | undefined): boolean {
  return u !== undefined && (
    u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0 || u.cacheWriteTokens > 0
    || u.llmCallCount > 0 || u.turnCount > 0 || u.toolCallCount > 0
  );
}

/**
 * True when a committed WorkItemUsage carries no real data yet (the untouched
 * emptyWorkItemUsage placeholder — zero counts, unpriced, no cost). Such a
 * placeholder must NOT be folded into a live overlay: merging an 'unpriced'
 * zero into a priced overlay would honestly-but-uselessly degrade the result to
 * 'estimated' and drop it from the priced cost rollup (aggregateWorkItemCost),
 * re-introducing the very n/a this overlay removes. When committed is empty the
 * overlay stands alone.
 */
function isEmptyCommittedUsage(u: WorkItemUsage): boolean {
  return u.costUsd === null && !hasAnyUsage(u);
}

/** Convert a live overlay into WorkItemUsage shape, or undefined when it carries nothing real yet. */
function liveOverlayUsage(live: LiveItemUsage | undefined): WorkItemUsage | undefined {
  if (!live) return undefined;
  const u = live.usage;
  const hasCost = live.costUsd !== undefined && live.costUsd !== null;
  if (!hasAnyUsage(u) && !hasCost) return undefined;
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    cacheWriteTokens: u?.cacheWriteTokens ?? 0,
    reasoningTokens: u?.reasoningTokens,
    llmCallCount: u?.llmCallCount ?? 0,
    turnCount: u?.turnCount ?? 0,
    toolCallCount: u?.toolCallCount ?? 0,
    costUsd: live.costUsd ?? null,
    costState: live.costState ?? (hasCost ? 'priced' : 'unpriced'),
    costSource: live.costSource,
    pricingAsOf: live.pricingAsOf,
  };
}

/**
 * The usage the fleet DISPLAYS for a work-item: its committed phase-boundary
 * total, plus — only while it is actively 'in-phase' — the live in-flight
 * usage of its current agent. The overlay is applied ONLY for an 'in-phase'
 * item, which is exactly the window in which `item.usage` does NOT yet include
 * the running phase (the engine folds that in at completion — see
 * runItemPhase), so committed + live never double-counts and the two hand off
 * atomically at the phase boundary. Because both operands only ever grow and
 * merge through {@link mergeWorkItemUsage}, presence is MONOTONE: once usage
 * has appeared for an item it never blinks back to n/a.
 */
export function displayWorkItemUsage(item: WorkItem, live: LiveItemUsage | undefined): WorkItemUsage {
  const overlay = item.state === 'in-phase' ? liveOverlayUsage(live) : undefined;
  if (!overlay) return item.usage;
  // First-phase window: no committed usage yet, so the live overlay is the
  // whole truth — don't let the empty 'unpriced' placeholder degrade it.
  if (isEmptyCommittedUsage(item.usage)) return overlay;
  return mergeWorkItemUsage(item.usage, overlay);
}

/**
 * Resolve each item's active-agent in-flight usage ONCE, keyed by item id, so
 * the workstream rollup and the per-item nodes share one overlay resolution.
 * displayWorkItemUsage applies the overlay only while an item is 'in-phase',
 * so this never double-counts committed usage. Cost provenance travels with
 * the live cost — the dollars and their source are copied together.
 */
export function collectLiveItemUsage(
  workstream: Workstream,
  agentNodeById: ReadonlyMap<string, ProcessNode>,
): Map<string, LiveItemUsage> {
  const liveByItemId = new Map<string, LiveItemUsage>();
  for (const item of workstream.items) {
    const activeAgentId = activeWorkItemAgentId(item);
    const activeAgentNode = activeAgentId ? agentNodeById.get(activeAgentId) : undefined;
    if (activeAgentNode) {
      liveByItemId.set(item.id, {
        usage: activeAgentNode.usage,
        costUsd: activeAgentNode.costUsd ?? null,
        costState: activeAgentNode.costState,
        costSource: activeAgentNode.costSource,
        pricingAsOf: activeAgentNode.pricingAsOf,
      });
    }
  }
  return liveByItemId;
}

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
  // A merge conflict overrides the coarse pipeline state: the item's phases
  // may have passed, but its work has NOT landed — reporting 'done' would be
  // dishonest. 'stalled' is the existing "stuck, not progressing" state; the
  // needsAttention 'conflict' marker carries the waiting-on-human meaning.
  if (item.mergeState === 'conflict') return 'stalled';
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
    case 'blocked-dependency':
      // Same "stuck, not progressing" signal as blocked-budget, for the same
      // reason (BIG-3 item 2): the item is out of the claimable set until every
      // dependency reaches 'passed'. Distinct from 'queued' (which WILL be
      // claimed by free capacity) — a dependency-blocked item waits on other
      // items, or on engine.retryItem reviving a failed dependency. blockedReason
      // carries the honest 'waiting on: …' / 'dependency failed: …' detail.
      return 'stalled';
    case 'in-phase':
      return 'executing-tool';
    case 'held-merge':
      // A best-of-N attempt that PASSED and is parked awaiting the winner pick
      // (see attempts.ts). 'paused' reads as "done its work, held, not
      // progressing on its own" — distinct from 'done' (a merged/terminal item)
      // and from 'queued'/'stalled' (still trying to advance). A human (or the
      // judge auto-accept) resolves it via fleet.attempts.pick.
      return 'paused';
  }
}

/**
 * The best-of-N groups in this workstream that are READY for the winner pick:
 * every sibling settled (held-merge or failed) and at least one held
 * candidate. Pure over the items — the same readiness the attempts
 * coordinator computes, derived here so the snapshot needs no engine access.
 */
export function readyAttemptGroupIds(workstream: Workstream): ReadonlySet<string> {
  const byGroup = new Map<string, WorkItem[]>();
  for (const item of workstream.items) {
    if (!item.attemptGroupId) continue;
    const members = byGroup.get(item.attemptGroupId) ?? [];
    members.push(item);
    byGroup.set(item.attemptGroupId, members);
  }
  const ready = new Set<string>();
  for (const [groupId, members] of byGroup) {
    const allSettled = members.every((member) => member.state === 'held-merge' || member.state === 'failed');
    const anyHeld = members.some((member) => member.state === 'held-merge');
    // A group whose pick already landed has a merged/passed winner — no longer ready.
    const anyPicked = members.some((member) => member.attemptWinner === true);
    if (allSettled && anyHeld && !anyPicked) ready.add(groupId);
  }
  return ready;
}

function workstreamState(workstream: Workstream): ProcessState {
  if (workstream.items.length === 0) return 'idle';
  if (workstream.items.some((item) => item.state === 'in-phase')) return 'executing-tool';
  if (workstream.items.some((item) => item.state === 'pending' || item.state === 'awaiting-capacity')) return 'queued';
  if (workstream.items.some((item) => item.state === 'blocked-budget' || item.state === 'blocked-dependency')) return 'stalled';
  // Unresolved merge conflicts and undecided best-of-N picks keep the
  // workstream honest: its work has NOT all landed, so it is neither done nor
  // failed — it is waiting (conflict = stuck; ready pick = parked on a human).
  if (workstream.items.some((item) => item.mergeState === 'conflict')) return 'stalled';
  if (workstream.items.some((item) => item.state === 'held-merge')) return 'paused';
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

/**
 * token-count-only rollup over a workstream's per-item DISPLAY usages (cost
 * handled separately — see aggregateWorkItemCost). Takes resolved display
 * usages (committed + any live overlay) rather than raw items so the workstream
 * total reflects live in-flight work, not just phase-boundary snapshots
 * (the live-usage overlay contract).
 */
function sumWorkItemUsage(usages: readonly WorkItemUsage[]): ProcessUsage | undefined {
  if (usages.length === 0) return undefined;
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
  for (const usage of usages) {
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

/** Honest cost rollup: all-priced -> 'priced'; none -> null/'unpriced'; mixed -> summed subset, 'estimated'. Mirrors adapters/wrfc.ts aggregateCost. Operates on resolved display usages (committed + live overlay). Provenance folds through the shared merge rules (single source or 'mixed'; oldest as-of date). */
function aggregateWorkItemCost(usages: readonly WorkItemUsage[]): { costUsd: number | null; costState: ProcessNode['costState']; costSource: ProcessNode['costSource']; pricingAsOf: string | undefined } {
  const withUsage = usages.filter((usage) => usage.costState !== 'unpriced' || usage.inputTokens > 0 || usage.outputTokens > 0);
  if (withUsage.length === 0) return { costUsd: null, costState: 'unpriced', costSource: undefined, pricingAsOf: undefined };
  const priced = withUsage.filter((usage) => usage.costState === 'priced' && usage.costUsd !== null);
  if (priced.length === 0) return { costUsd: null, costState: 'unpriced', costSource: undefined, pricingAsOf: undefined };
  const total = priced.reduce((sum, usage) => sum + (usage.costUsd as number), 0);
  const costSource = priced.reduce<WorkItemCostSource | undefined>((merged, usage) => mergeCostSource(merged, usage.costSource), undefined);
  const pricingAsOf = priced.reduce<string | undefined>((merged, usage) => mergePricingAsOf(merged, usage.pricingAsOf), undefined);
  return { costUsd: total, costState: priced.length === withUsage.length ? 'priced' : 'estimated', costSource, pricingAsOf };
}

/**
 * WorkItem -> ProcessNode. Delegates interruptible/killable/steerable to its
 * currently-active agent, mirroring adaptSubtask. `opts.live` supplies the
 * currently-active agent's in-flight usage so a running phase shows real,
 * growing numbers instead of n/a until it completes; omit it
 * (or pass undefined) for the committed-only view.
 */
export function adaptWorkItem(item: WorkItem, workstreamId: string, parentId: string, opts: { steerable: boolean; live?: LiveItemUsage | undefined; readyGroups?: ReadonlySet<string> | undefined }): ProcessNode {
  const state = workItemState(item);
  const killable = !TERMINAL_ITEM_STATES.has(item.state);
  const activeAgentId = activeWorkItemAgentId(item);
  const usage = displayWorkItemUsage(item, opts.live);
  // A merge conflict is a first-class waiting-on-human condition: the item's
  // kept tree needs a human resolution before its work can land. Same
  // classification the approval block uses, so glyph/count/jump/push all
  // inherit for free (emit-bridge + push fan out on needsAttention).
  const conflictAttention = item.mergeState === 'conflict'
    ? { reason: 'conflict' as const, detail: item.blockedReason ?? 'merge conflict' }
    : undefined;
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
    usage: usage.inputTokens > 0 || usage.outputTokens > 0
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
          llmCallCount: usage.llmCallCount,
          turnCount: usage.turnCount,
          toolCallCount: usage.toolCallCount,
        }
      : undefined,
    costUsd: usage.costUsd,
    costState: usage.costState,
    ...(usage.costSource !== undefined ? { costSource: usage.costSource } : {}),
    ...(usage.pricingAsOf !== undefined ? { pricingAsOf: usage.pricingAsOf } : {}),
    // Blocked items surface their reason (set/cleared by the engine alongside
    // the state transition, types.ts WorkItem.blockedReason) in place of the
    // bare phase id — the phase id alone doesn't tell an operator WHY the item
    // stopped moving. Covers both budget blocks and dependency blocks (BIG-3
    // item 2: 'waiting on: …' / 'dependency failed: …').
    currentActivity: item.currentPhaseId
      ? {
          kind: 'phase',
          text: (item.state === 'blocked-budget' || item.state === 'blocked-dependency') && item.blockedReason
            ? item.blockedReason
            : item.currentPhaseId,
          at: item.createdAt,
        }
      : undefined,
    capabilities: {
      interruptible: activeAgentId !== undefined,
      killable,
      pausable: false,
      resumable: false,
      steerable: activeAgentId !== undefined && opts.steerable,
    },
    ...(conflictAttention ? { needsAttention: conflictAttention } : {}),
    sessionRef: activeAgentId ? { agentId: activeAgentId } : undefined,
    // Best-of-N sibling grouping (attempts.ts) — surfaced so the fleet renders the
    // N siblings as one group, marks held candidates, and flags a READY group
    // (all settled, pick actionable now via fleet.attempts.list/pick).
    attemptGroup: item.attemptGroupId
      ? {
          groupId: item.attemptGroupId,
          index: item.attemptIndex ?? 0,
          total: item.attemptTotal ?? 1,
          held: item.state === 'held-merge',
          ready: opts.readyGroups?.has(item.attemptGroupId) ?? false,
        }
      : undefined,
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
 * Workstream -> ProcessNode. Root node (no parentId). Sums every item's DISPLAY
 * usage/cost (committed total + any live in-flight overlay, resolved once per
 * item) exactly once — never through an intermediate phase bucket (see
 * adaptPhase) — so this total can never double-count and never shows n/a while
 * an item is actively producing usage. `liveByItemId` supplies
 * the active agents' in-flight usage keyed by item id; omit it for the
 * committed-only view.
 */
export function adaptWorkstream(workstream: Workstream, now: number, liveByItemId?: ReadonlyMap<string, LiveItemUsage>): ProcessNode {
  const state = workstreamState(workstream);
  const killable = state !== 'done' && state !== 'failed';
  // ONE waiting-on-human flag per ready best-of-N group, carried on the
  // workstream node (the pick is one decision over N siblings — flagging every
  // held sibling would inflate the attention count N-fold for one act).
  const readyGroups = readyAttemptGroupIds(workstream);
  const pickAttention = readyGroups.size > 0
    ? {
        reason: 'pick' as const,
        detail: readyGroups.size === 1
          ? 'best-of-N pick ready'
          : `${readyGroups.size} best-of-N picks ready`,
      }
    : undefined;
  const completedAt = (state === 'done' || state === 'failed')
    ? workstream.items.reduce<number | undefined>(
        (latest, item) => (item.completedAt !== undefined && (latest === undefined || item.completedAt > latest) ? item.completedAt : latest),
        undefined,
      )
    : undefined;
  const displayUsages = workstream.items.map((item) => displayWorkItemUsage(item, liveByItemId?.get(item.id)));
  const { costUsd, costState, costSource, pricingAsOf } = aggregateWorkItemCost(displayUsages);
  return {
    id: workstreamNodeId(workstream.id),
    kind: 'workstream',
    parentId: undefined,
    label: workstream.title,
    state,
    startedAt: workstream.createdAt,
    completedAt,
    elapsedMs: Math.max(0, (completedAt ?? now) - workstream.createdAt),
    usage: sumWorkItemUsage(displayUsages),
    costUsd,
    costState,
    ...(costSource !== undefined ? { costSource } : {}),
    ...(pricingAsOf !== undefined ? { pricingAsOf } : {}),
    currentActivity: undefined,
    ...(pickAttention ? { needsAttention: pickAttention } : {}),
    // A workstream is an FSM coordinating work-items, not itself a
    // conversation loop — steer a work-item instead (mirrors wrfc-chain).
    // Kill is DERIVED (no native single-call cancel): cascades
    // AgentManager.cancel over every agent any item ever spawned — see
    // registry.ts killNode's 'workstream' case.
    capabilities: { interruptible: false, killable, pausable: false, resumable: false, steerable: false },
    raw: workstream,
  };
}
