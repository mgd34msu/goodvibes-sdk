/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { WrfcChain, WrfcSubtask } from '../../../agents/wrfc-types.js';
import type { ProcessNode, ProcessState, ProcessUsage } from '../types.js';
import { chainNodeId, subtaskNodeId } from './agent.js';

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set(['done', 'failed', 'killed']);

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
  return { state: 'executing-tool', phase: chain.state };
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

/** WrfcSubtask → ProcessNode (child of its chain node). */
export function adaptSubtask(subtask: WrfcSubtask, chain: WrfcChain): ProcessNode {
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
    capabilities: { interruptible: false, killable, pausable: false },
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
  return {
    id: chainNodeId(chain.id),
    kind: 'wrfc-chain',
    parentId: undefined,
    label: `wrfc ${chain.id}`,
    task: chain.task,
    state,
    startedAt: chain.createdAt,
    completedAt: chain.completedAt,
    elapsedMs: Math.max(0, (chain.completedAt ?? now) - chain.createdAt),
    usage: sumUsage(memberNodes),
    costUsd,
    costState,
    // Silent source: anchored to createdAt (no phase-transition timestamp).
    currentActivity: phase ? { kind: 'phase', text: phase, at: chain.createdAt } : undefined,
    capabilities: { interruptible: false, killable, pausable: false },
    raw: chain,
  };
}
