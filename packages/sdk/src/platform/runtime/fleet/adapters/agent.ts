/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { AgentRecord } from '../../../tools/agent/manager.js';
import type {
  ProcessActivity,
  ProcessNode,
  ProcessState,
  ProcessUsage,
} from '../types.js';

/** Chain node ids are namespaced to avoid colliding with agent/process ids. */
export function chainNodeId(chainId: string): string {
  return `chain:${chainId}`;
}

/** Subtask node ids are namespaced to avoid colliding with agent/process ids. */
export function subtaskNodeId(subtaskId: string): string {
  return `subtask:${subtaskId}`;
}

/**
 * One activity side-table entry. Registry-owned; populated from the EXISTING
 * runtime-bus 'agents' channel emitters (no new event contract).
 */
export interface AgentActivityEntry {
  readonly state: Extract<ProcessState, 'thinking' | 'executing-tool' | 'streaming' | 'retrying' | 'queued' | 'done' | 'failed'>;
  readonly activity?: ProcessActivity | undefined;
  /** Epoch ms of the last observed bus event for this agent. */
  readonly at: number;
}

/** Assembly context the agent adapter needs to derive state and edges. */
export interface AgentAdapterContext {
  readonly now: number;
  readonly stalledThresholdMs: number;
  /** Side-table entries keyed by agentId. Empty map when no runtimeBus was provided. */
  readonly activity: ReadonlyMap<string, AgentActivityEntry>;
  /** True when a runtimeBus feeds the side-table — gates the stalled derivation. */
  readonly liveness: boolean;
  /** Agent ids that have a pending shared approval (metadata.agentId match). */
  readonly pendingApprovalAgentIds: ReadonlySet<string>;
  /** Session ids that have a pending shared approval (sessionRef cross-match). */
  readonly pendingApprovalSessionIds: ReadonlySet<string>;
  /** agentId → bound sessionId (from the session broker, when available). */
  readonly sessionIdByAgentId: ReadonlyMap<string, string>;
  /** Raw WrfcChain ids present in this snapshot. */
  readonly chainIds: ReadonlySet<string>;
  /** Raw WrfcSubtask ids present in this snapshot. */
  readonly subtaskIds: ReadonlySet<string>;
  /** orchestrationNodeId → owning agentId, for parentNodeId edge resolution. */
  readonly agentIdByOrchestrationNodeId: ReadonlyMap<string, string>;
  /** All agent ids present in this snapshot. */
  readonly agentIds: ReadonlySet<string>;
  readonly priceUsage?: ((model: string | undefined, usage: ProcessUsage) => number | null) | undefined;
}

/** AgentRecord.usage + toolCallCount → ProcessUsage. */
export function usageFromAgentRecord(record: AgentRecord): ProcessUsage | undefined {
  if (!record.usage) return undefined;
  return {
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    cacheWriteTokens: record.usage.cacheWriteTokens,
    reasoningTokens: record.usage.reasoningTokens,
    llmCallCount: record.usage.llmCallCount,
    turnCount: record.usage.turnCount,
    toolCallCount: record.toolCallCount,
  };
}

/**
 * parentId precedence (brief-mandated, Wave-4 stable):
 * wrfcSubtaskId → `subtask:<id>` else wrfcId → `chain:<id>` else
 * orchestrationNodeId/parentNodeId (resolved to the owning agent) else
 * parentAgentId. Every step falls through when the referenced node is not
 * present in this snapshot, so edges always resolve or the node is a root.
 */
function resolveParentId(record: AgentRecord, ctx: AgentAdapterContext): string | undefined {
  if (record.wrfcSubtaskId && ctx.subtaskIds.has(record.wrfcSubtaskId)) {
    return subtaskNodeId(record.wrfcSubtaskId);
  }
  if (record.wrfcId && ctx.chainIds.has(record.wrfcId)) {
    return chainNodeId(record.wrfcId);
  }
  if (record.parentNodeId) {
    const owner = ctx.agentIdByOrchestrationNodeId.get(record.parentNodeId);
    if (owner && owner !== record.id && ctx.agentIds.has(owner)) return owner;
  }
  if (record.parentAgentId && ctx.agentIds.has(record.parentAgentId)) {
    return record.parentAgentId;
  }
  return undefined;
}

function deriveAgentState(
  record: AgentRecord,
  entry: AgentActivityEntry | undefined,
  sessionId: string | undefined,
  ctx: AgentAdapterContext,
): ProcessState {
  switch (record.status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      // terminationKind distinguishes a graceful interrupt request from a hard
      // kill for display purposes (Wave-3 verb formalization). Records
      // persisted before this field existed have no terminationKind and
      // default to 'killed' — the historical behavior.
      return record.terminationKind === 'interrupt' ? 'interrupted' : 'killed';
    case 'pending':
      return 'queued';
    case 'running':
      break;
  }
  // running — fine-grained derivation.
  if (
    ctx.pendingApprovalAgentIds.has(record.id) ||
    (sessionId !== undefined && ctx.pendingApprovalSessionIds.has(sessionId))
  ) {
    return 'awaiting-approval';
  }
  // Stalled: only derivable when a bus feeds the side-table (headless runtimes
  // degrade to the coarse state, never crash). Baseline is the last observed
  // event, or startedAt when the agent predates the registry.
  //
  // executing-tool is exempt: AGENT_AWAITING_TOOL stamps activity.at once at
  // tool start and no further 'agents' event fires until the tool returns, so
  // a long-running tool call (build, test suite, bash) would otherwise be
  // misread as silence and falsely flip a working agent to 'stalled'. Only
  // thinking/streaming (and other non-tool) silence may stall.
  if (ctx.liveness && entry?.state !== 'executing-tool') {
    const lastActivityAt = entry?.at ?? record.startedAt;
    if (ctx.now - lastActivityAt > ctx.stalledThresholdMs) return 'stalled';
  }
  if (entry && entry.state !== 'done' && entry.state !== 'failed') return entry.state;
  return 'executing-tool';
}

/** AgentRecord → ProcessNode. */
export function adaptAgent(record: AgentRecord, ctx: AgentAdapterContext): ProcessNode {
  const entry = ctx.activity.get(record.id);
  const sessionId = ctx.sessionIdByAgentId.get(record.id);
  const state = deriveAgentState(record, entry, sessionId, ctx);
  const usage = usageFromAgentRecord(record);
  const active = record.status === 'pending' || record.status === 'running';

  let costUsd: number | null = null;
  let costState: ProcessNode['costState'] = 'unpriced';
  if (usage && ctx.priceUsage) {
    let priced: number | null = null;
    try {
      priced = ctx.priceUsage(record.model, usage);
    } catch {
      priced = null;
    }
    if (priced !== null) {
      costUsd = priced;
      costState = 'priced';
    }
  }

  const label = record.wrfcRole ? `${record.template} (${record.wrfcRole})` : record.template;
  const elapsedMs = Math.max(0, (record.completedAt ?? ctx.now) - record.startedAt);

  return {
    id: record.id,
    kind: 'agent',
    parentId: resolveParentId(record, ctx),
    label,
    task: record.task,
    state,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    elapsedMs,
    usage,
    model: record.model,
    provider: record.provider,
    costUsd,
    costState,
    currentActivity: entry?.activity,
    capabilities: { interruptible: active, killable: active, pausable: false },
    sessionRef: { sessionId, agentId: record.id },
    raw: record,
  };
}
