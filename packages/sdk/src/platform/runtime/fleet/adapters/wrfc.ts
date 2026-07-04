/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { WrfcChain, WrfcSubtask } from '../../../agents/wrfc-types.js';
import type { ProcessNode, ProcessState, ProcessUsage } from '../types.js';
import { chainNodeId, subtaskNodeId } from './agent.js';

// 'interrupted' is included: it is only ever produced on an AGENT node
// (deriveAgentState), never on a chain/subtask's own `state`, but a chain
// member agent that was individually interrupted (not via chain cascade,
// which always hard-kills — see registry.ts cancelAgents) must still count
// as terminal here, or it would be misread as "live" below.
const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set(['done', 'failed', 'killed', 'interrupted']);

function chainState(chain: WrfcChain, memberNodes: readonly ProcessNode[]): { state: ProcessState; phase?: string | undefined } {
  switch (chain.state) {
    case 'passed':
      return { state: 'done' };
    case 'failed':
      return { state: 'failed' };
    case 'pending':
      return { state: 'queued' };
    case 'awaiting_gates':
      return { state: 'idle', phase: chain.state };
    default:
      break;
  }
  // Active phase (engineering/integrating/reviewing/fixing/gating/committing).
  // Retrying is DERIVED: a transport retry has been recorded and no member
  // agent is currently live — i.e. the respawn window. Once the replacement
  // agent runs, the chain shows its active phase again.
  const retryCount = chain.transportRetryCount ?? 0;
  const anyMemberLive = memberNodes.some((node) => !TERMINAL_STATES.has(node.state));
  if (retryCount > 0 && !anyMemberLive) {
    return { state: 'retrying', phase: chain.state };
  }
  // CONTROLLER-DRIVEN PHASES: 'gating' (running gate checks) and 'committing'
  // (git commit/merge) are performed by WrfcController itself, never by a
  // member agent — every phase-worker member has already finished its own
  // work by the time the chain advances to either state. "Zero live members"
  // is therefore the NORMAL condition here, not a symptom of a cascade kill,
  // so these two states are excluded from the CHAIN TERMINAL TRUTH check
  // below (enumerated from the WrfcState union in wrfc-types.ts — do not
  // widen this to other active states, where a live member IS expected and
  // its absence legitimately signals a kill).
  const controllerDrivenWithNoLiveMembersByDesign = chain.state === 'gating' || chain.state === 'committing';
  // CHAIN TERMINAL TRUTH: WrfcController has no cancel/abort of its own, so a
  // cascade kill (registry.ts kill('chain:<id>')) only cancels the member
  // agents — chain.state never leaves whatever active phase it was in when
  // killed. Once every known member has reached a terminal state and it's
  // NOT the transport-retry respawn window handled above, NOR one of the
  // controller-driven phases handled above, the chain was terminated out
  // from under its owner: report it terminal instead of a perpetually-running
  // phase (the replay-found "climbing elapsed" leak). `phase` is preserved
  // for display ("killed while engineering").
  if (memberNodes.length > 0 && !anyMemberLive && !controllerDrivenWithNoLiveMembersByDesign) {
    return { state: 'killed', phase: chain.state };
  }
  return { state: 'executing-tool', phase: chain.state };
}

/**
 * Synthetic completedAt for a chain whose terminal state was DERIVED (see
 * chainState above) rather than reported by WrfcController — cascade kill
 * never sets `chain.completedAt`. Freezing to the latest member completedAt
 * (rather than `now`) is what stops elapsedMs from climbing after a kill;
 * every member here is terminal (chainState's caller only reaches this when
 * `state === 'killed'`), and every terminal agent node has a completedAt
 * (set atomically with its terminal status — see agent.ts / manager.ts
 * cancel()), so the max is always defined when memberNodes is non-empty.
 */
function syntheticChainCompletedAt(memberNodes: readonly ProcessNode[]): number | undefined {
  let latest: number | undefined;
  for (const node of memberNodes) {
    if (node.completedAt === undefined) continue;
    if (latest === undefined || node.completedAt > latest) latest = node.completedAt;
  }
  return latest;
}

function subtaskState(subtask: WrfcSubtask): { state: ProcessState; phase?: string | undefined } {
  switch (subtask.state) {
    case 'pending':
      return { state: 'queued' };
    case 'passed':
      return { state: 'done' };
    case 'failed':
      return { state: 'failed' };
    default:
      return { state: 'executing-tool', phase: subtask.state };
  }
}

function sumUsage(nodes: readonly ProcessNode[]): ProcessUsage | undefined {
  const contributors = nodes.filter((node) => node.usage !== undefined);
  if (contributors.length === 0) return undefined;
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
  for (const node of contributors) {
    const usage = node.usage!;
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

/**
 * Aggregate member-agent cost onto the chain, honestly:
 * all contributors priced → 'priced'; none priced → null/'unpriced';
 * mixed → sum of the priced subset, flagged 'estimated'.
 *
 * The owner agent is EXCLUDED from aggregation: it runs no LLM turns itself —
 * its AgentRecord.usage is populated FROM the phase children at completion
 * time (Wave-0/1), so including it would double-count.
 */
function aggregateCost(members: readonly ProcessNode[]): { costUsd: number | null; costState: ProcessNode['costState'] } {
  const withUsage = members.filter((node) => node.usage !== undefined);
  if (withUsage.length === 0) return { costUsd: null, costState: 'unpriced' };
  const priced = withUsage.filter((node) => node.costState === 'priced' && typeof node.costUsd === 'number');
  if (priced.length === 0) return { costUsd: null, costState: 'unpriced' };
  const total = priced.reduce((sum, node) => sum + (node.costUsd as number), 0);
  return { costUsd: total, costState: priced.length === withUsage.length ? 'priced' : 'estimated' };
}

/**
 * The subtask's currently-active member agent, i.e. whichever role is
 * driving its current phase. Undefined when the subtask has no phase
 * currently in flight (pending/passed/failed) — matches subtaskState()'s
 * own phase mapping above.
 */
export function activeSubtaskMemberAgentId(subtask: WrfcSubtask): string | undefined {
  switch (subtask.state) {
    case 'engineering':
      return subtask.engineerAgentId;
    case 'reviewing':
      return subtask.reviewerAgentId;
    case 'fixing':
      return subtask.fixerAgentId;
    default:
      return undefined;
  }
}

/** WrfcSubtask → ProcessNode (child of its chain node). */
export function adaptSubtask(subtask: WrfcSubtask, chain: WrfcChain, opts: { steerable: boolean }): ProcessNode {
  const { state, phase } = subtaskState(subtask);
  const killable = state !== 'done' && state !== 'failed' && state !== 'killed';
  return {
    id: subtaskNodeId(subtask.id),
    kind: 'wrfc-subtask',
    parentId: chainNodeId(chain.id),
    label: subtask.title,
    task: subtask.task,
    state,
    startedAt: undefined,
    completedAt: undefined,
    elapsedMs: 0,
    usage: undefined,
    costUsd: null,
    costState: 'unpriced',
    // Silent source: no phase-transition timestamp exists, so anchor to the
    // chain's creation time to keep the activity stable across queries.
    currentActivity: phase ? { kind: 'phase', text: phase, at: chain.createdAt } : undefined,
    // Steer targets the live member agent driving this subtask's current
    // phase, NOT the subtask node itself (which has no conversation loop).
    capabilities: { interruptible: false, killable, pausable: false, resumable: false, steerable: opts.steerable },
    raw: subtask,
  };
}

/**
 * WrfcChain → ProcessNode. `memberNodes` are the already-adapted agent nodes
 * whose ids appear in chain.allAgentIds, EXCLUDING the owner agent (see
 * aggregateCost). Chain nodes are roots (the owner agent hangs under the
 * chain via its wrfcId edge, not the other way around).
 */
export function adaptChain(chain: WrfcChain, memberNodes: readonly ProcessNode[], now: number): ProcessNode {
  const { state, phase } = chainState(chain, memberNodes);
  const { costUsd, costState } = aggregateCost(memberNodes);
  const killable = state !== 'done' && state !== 'failed' && state !== 'killed';
  // chain.completedAt is authoritative when WrfcController set it (the
  // 'passed'/'failed' clean-terminal cases). `state === 'killed'` is only
  // ever reached via chainState's DERIVED branch (WrfcController never
  // literally sets chain.state to 'killed'), so falling back to the
  // synthetic max(member.completedAt) there — instead of `now` — is what
  // freezes elapsedMs once the chain is recognized as killed.
  const completedAt = chain.completedAt ?? (state === 'killed' ? syntheticChainCompletedAt(memberNodes) : undefined);
  return {
    id: chainNodeId(chain.id),
    kind: 'wrfc-chain',
    parentId: undefined,
    label: `wrfc ${chain.id}`,
    task: chain.task,
    state,
    startedAt: chain.createdAt,
    completedAt,
    elapsedMs: Math.max(0, (completedAt ?? now) - chain.createdAt),
    usage: sumUsage(memberNodes),
    costUsd,
    costState,
    // Silent source: anchored to createdAt (no phase-transition timestamp).
    currentActivity: phase ? { kind: 'phase', text: phase, at: chain.createdAt } : undefined,
    // A wrfc-chain is an FSM coordinating member agents; it has no
    // conversation loop of its own, so it is NEVER steerable — steer the
    // member subtask instead (adaptSubtask, above).
    capabilities: { interruptible: false, killable, pausable: false, resumable: false, steerable: false },
    raw: chain,
  };
}
