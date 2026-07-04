/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Live process registry (W2.1) — one queryable + subscribable aggregation
 * surface over the already-composed runtime managers. ZERO new store state:
 * every query is an aggregate-on-read over the managers' in-memory maps, and
 * the only registry-owned mutable state is the agent activity side-table fed
 * by EXISTING runtime-bus 'agents' events (no new event contract).
 *
 * Pattern precedent: platform/core/orchestrator-context-runtime.ts already
 * aggregates agentManager.list() + wrfcController.listChains() into a
 * read-only context; this module generalizes that into a durable registry.
 */

import type { AgentManager, AgentRecord } from '../../tools/agent/manager.js';
import type { WrfcController } from '../../agents/wrfc-controller.js';
import type { WrfcChain, WrfcSubtask } from '../../agents/wrfc-types.js';
import type { ProcessManager } from '../../tools/shared/process-manager.js';
import type { WatcherRegistry } from '../../watchers/registry.js';
import type {
  ScheduleEntry,
  ScheduleManager,
  TriggerManager,
  WorkflowManager,
} from '../../tools/workflow/index.js';
import type { ApprovalBroker } from '../../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../../control-plane/session-broker.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type {
  FleetQueryFilter,
  FleetSnapshot,
  ProcessKillOptions,
  ProcessNode,
  ProcessRegistry,
  ProcessUsage,
} from './types.js';
import type { AgentActivityEntry, AgentAdapterContext } from './adapters/agent.js';
import { adaptAgent } from './adapters/agent.js';
import { adaptChain, adaptSubtask } from './adapters/wrfc.js';
import { adaptWorkflow } from './adapters/workflow.js';
import { adaptTrigger } from './adapters/trigger.js';
import { adaptSchedule } from './adapters/schedule.js';
import { adaptWatcher } from './adapters/watcher.js';
import { adaptBackgroundProcess } from './adapters/background-process.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Default stalled threshold: running agent with no bus activity for this long → 'stalled'. */
export const DEFAULT_STALLED_THRESHOLD_MS = 20_000;
/** Default coalesced tick interval for subscriber notification. */
export const DEFAULT_TICK_INTERVAL_MS = 750;

/** Injectable timer seam so tests can drive/observe the coalesced tick. */
export interface RegistryTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Narrow structural deps — a pick of each manager's read/control surface, NOT
 * the whole RuntimeServices, so the registry stays testable with stubs and
 * cannot participate in a construction cycle.
 */
export interface ProcessRegistryDeps {
  readonly agentManager: Pick<AgentManager, 'list' | 'cancel'>;
  readonly wrfcController: Pick<WrfcController, 'listChains'>;
  readonly processManager: Pick<ProcessManager, 'list' | 'stop' | 'getStatus'>;
  readonly watcherRegistry: Pick<WatcherRegistry, 'list' | 'stopWatcher'>;
  readonly workflow: {
    readonly workflowManager: Pick<WorkflowManager, 'list' | 'cancel'>;
    readonly triggerManager: Pick<TriggerManager, 'list' | 'remove' | 'disable'>;
    readonly scheduleManager: Pick<ScheduleManager, 'list' | 'remove' | 'disable'>;
  };
  /** Optional: awaiting-approval derivation. Non-control-plane runtimes still build a fleet. */
  readonly approvalBroker?: Pick<ApprovalBroker, 'listApprovals'> | undefined;
  /** Optional: populates ProcessNode.sessionRef.sessionId (Wave-3 tab attach point). */
  readonly sessionBroker?: Pick<SharedSessionBroker, 'listSessions'> | undefined;
  /** Optional: feeds the fine-grained agent activity side-table. Without it the registry degrades to coarse states. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  /** Optional: honest cost pricing. Return null when the model is unknown — NEVER fabricate. */
  readonly priceUsage?: ((model: string | undefined, usage: ProcessUsage) => number | null) | undefined;
  readonly now?: (() => number) | undefined;
  readonly stalledThresholdMs?: number | undefined;
  readonly tickIntervalMs?: number | undefined;
  readonly timers?: RegistryTimers | undefined;
}

const defaultTimers: RegistryTimers = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    // Unref at the creation site so a dangling tick never keeps the process
    // alive if a consumer forgets to dispose. The registry also unrefs the
    // returned handle via unrefHandle() for injected timer impls; this inline
    // unref keeps the raw setInterval site self-contained (invariant guard).
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function unrefHandle(handle: unknown): void {
  if (handle !== null && typeof handle === 'object' && 'unref' in handle) {
    const unref = (handle as { unref: unknown }).unref;
    if (typeof unref === 'function') (unref as () => void).call(handle);
  }
}

/**
 * Change signature over the fields that constitute a MATERIAL change.
 * Deliberately excludes elapsedMs/capturedAt/activity.at — continuously
 * varying derived values must not wake subscribers every tick.
 * Joined with an escaped NUL so no printable field value can collide.
 */
function snapshotSignature(nodes: readonly ProcessNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(
      node.id,
      node.kind,
      node.parentId ?? '',
      node.state,
      node.label,
      String(node.completedAt ?? ''),
      node.usage
        ? `${node.usage.inputTokens}:${node.usage.outputTokens}:${node.usage.toolCallCount}:${node.usage.turnCount}`
        : '',
      node.currentActivity ? `${node.currentActivity.kind}=${node.currentActivity.text}` : '',
      String(node.costUsd ?? ''),
      node.costState,
      node.sessionRef?.sessionId ?? '',
    );
  }
  return parts.join('\u0000');
}

/** Create the live process registry over the already-composed managers. */
export function createProcessRegistry(deps: ProcessRegistryDeps): ProcessRegistry {
  const now = deps.now ?? ((): number => Date.now());
  const stalledThresholdMs = deps.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const timers = deps.timers ?? defaultTimers;

  // ── Activity side-table (the only liveness mechanism, registry-owned) ─────
  const activity = new Map<string, AgentActivityEntry>();
  const busUnsubscribers: Array<() => void> = [];
  let disposed = false;

  function recordActivity(agentId: string, entry: Omit<AgentActivityEntry, 'at'>): void {
    activity.set(agentId, { ...entry, at: now() });
  }

  if (deps.runtimeBus) {
    busUnsubscribers.push(
      deps.runtimeBus.onDomain('agents', (envelope) => {
        const event = envelope.payload;
        const prior = activity.get(event.agentId);
        switch (event.type) {
          case 'AGENT_SPAWNING':
            recordActivity(event.agentId, { state: 'queued' });
            break;
          case 'AGENT_RUNNING':
          case 'AGENT_AWAITING_MESSAGE':
          case 'AGENT_FINALIZING':
            recordActivity(event.agentId, { state: 'thinking', activity: prior?.activity });
            break;
          case 'AGENT_AWAITING_TOOL':
            recordActivity(event.agentId, {
              state: 'executing-tool',
              activity: { kind: 'tool', text: event.tool, toolName: event.tool, at: now() },
            });
            break;
          case 'AGENT_STREAM_DELTA':
            recordActivity(event.agentId, { state: 'streaming', activity: prior?.activity });
            break;
          case 'AGENT_PROGRESS':
            // progress is already `Turn N · ToolName` (orchestrator-runner).
            recordActivity(event.agentId, {
              state: 'executing-tool',
              activity: { kind: 'phase', text: event.progress, at: now() },
            });
            break;
          case 'AGENT_COMPLETED':
            recordActivity(event.agentId, { state: 'done', activity: prior?.activity });
            break;
          case 'AGENT_FAILED':
            recordActivity(event.agentId, { state: 'failed', activity: prior?.activity });
            break;
          default:
            break;
        }
      }),
    );
    busUnsubscribers.push(
      deps.runtimeBus.on(
        'STREAM_RETRY',
        (envelope: RuntimeEventEnvelope<'STREAM_RETRY', Extract<TurnEvent, { type: 'STREAM_RETRY' }>>) => {
          const agentId = envelope.agentId;
          if (!agentId) return;
          const prior = activity.get(agentId);
          recordActivity(agentId, { state: 'retrying', activity: prior?.activity });
        },
      ),
    );
  }

  // ── Query assembly (aggregate-on-read, all O(n) in-memory scans) ──────────

  function collectPendingApprovals(): { agentIds: Set<string>; sessionIds: Set<string> } {
    const agentIds = new Set<string>();
    const sessionIds = new Set<string>();
    if (!deps.approvalBroker) return { agentIds, sessionIds };
    try {
      for (const approval of deps.approvalBroker.listApprovals(200)) {
        if (approval.status !== 'pending') continue;
        const metaAgentId = approval.metadata['agentId'];
        if (typeof metaAgentId === 'string' && metaAgentId.length > 0) agentIds.add(metaAgentId);
        if (approval.sessionId) sessionIds.add(approval.sessionId);
      }
    } catch (error) {
      logger.warn('[fleet] approval cross-reference failed', { error: summarizeError(error) });
    }
    return { agentIds, sessionIds };
  }

  function collectSessionBindings(): Map<string, string> {
    const byAgentId = new Map<string, string>();
    if (!deps.sessionBroker) return byAgentId;
    try {
      for (const session of deps.sessionBroker.listSessions(500)) {
        if (session.activeAgentId) byAgentId.set(session.activeAgentId, session.id);
        if (session.lastAgentId && !byAgentId.has(session.lastAgentId)) {
          byAgentId.set(session.lastAgentId, session.id);
        }
      }
    } catch (error) {
      logger.warn('[fleet] session binding scan failed', { error: summarizeError(error) });
    }
    return byAgentId;
  }

  function assemble(): { capturedAt: number; nodes: ProcessNode[] } {
    const capturedAt = now();
    const agents: AgentRecord[] = deps.agentManager.list();
    const chains: WrfcChain[] = deps.wrfcController.listChains();

    const chainIds = new Set<string>(chains.map((chain) => chain.id));
    const subtaskIds = new Set<string>();
    for (const chain of chains) {
      for (const subtask of chain.subtasks ?? []) subtaskIds.add(subtask.id);
    }
    const agentIds = new Set<string>(agents.map((record) => record.id));
    const agentIdByOrchestrationNodeId = new Map<string, string>();
    for (const record of agents) {
      if (record.orchestrationNodeId) agentIdByOrchestrationNodeId.set(record.orchestrationNodeId, record.id);
    }
    const { agentIds: pendingApprovalAgentIds, sessionIds: pendingApprovalSessionIds } = collectPendingApprovals();
    const sessionIdByAgentId = collectSessionBindings();

    const agentCtx: AgentAdapterContext = {
      now: capturedAt,
      stalledThresholdMs,
      activity,
      liveness: deps.runtimeBus !== undefined,
      pendingApprovalAgentIds,
      pendingApprovalSessionIds,
      sessionIdByAgentId,
      chainIds,
      subtaskIds,
      agentIdByOrchestrationNodeId,
      agentIds,
      priceUsage: deps.priceUsage,
    };

    const nodes: ProcessNode[] = [];
    const agentNodeById = new Map<string, ProcessNode>();
    for (const record of agents) {
      const node = adaptAgent(record, agentCtx);
      agentNodeById.set(node.id, node);
      nodes.push(node);
    }

    for (const chain of chains) {
      // Members exclude the owner: its usage is populated FROM phase children
      // at completion time, so including it would double-count (see wrfc.ts).
      const memberNodes: ProcessNode[] = [];
      for (const agentId of chain.allAgentIds) {
        if (agentId === chain.ownerAgentId) continue;
        const node = agentNodeById.get(agentId);
        if (node) memberNodes.push(node);
      }
      nodes.push(adaptChain(chain, memberNodes, capturedAt));
      for (const subtask of chain.subtasks ?? []) {
        nodes.push(adaptSubtask(subtask, chain));
      }
    }

    for (const instance of deps.workflow.workflowManager.list()) {
      nodes.push(adaptWorkflow(instance, capturedAt));
    }
    for (const trigger of deps.workflow.triggerManager.list()) {
      nodes.push(adaptTrigger(trigger));
    }
    for (const schedule of deps.workflow.scheduleManager.list()) {
      nodes.push(adaptSchedule(schedule));
    }
    for (const watcher of deps.watcherRegistry.list()) {
      nodes.push(adaptWatcher(watcher, capturedAt));
    }
    for (const summary of deps.processManager.list()) {
      const record = deps.processManager.getStatus(summary.id);
      if (record) nodes.push(adaptBackgroundProcess(record, capturedAt));
    }

    return { capturedAt, nodes };
  }

  function query(filter?: FleetQueryFilter): FleetSnapshot {
    const { capturedAt, nodes } = assemble();
    let selected: readonly ProcessNode[] = nodes;
    if (filter?.kinds && filter.kinds.length > 0) {
      const kinds = new Set(filter.kinds);
      selected = selected.filter((node) => kinds.has(node.kind));
    }
    if (filter?.states && filter.states.length > 0) {
      const states = new Set(filter.states);
      selected = selected.filter((node) => states.has(node.state));
    }
    return { capturedAt, nodes: selected };
  }

  function getNode(id: string): ProcessNode | null {
    const { nodes } = assemble();
    return nodes.find((node) => node.id === id) ?? null;
  }

  // ── Coalesced tick + subscription ──────────────────────────────────────────

  const listeners = new Set<(snapshot: FleetSnapshot) => void>();
  let tickHandle: unknown = null;
  let lastSignature: string | null = null;

  function tick(): void {
    if (listeners.size === 0) return;
    const snapshot = query();
    const signature = snapshotSignature(snapshot.nodes);
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        logger.warn('[fleet] subscriber threw', { error: summarizeError(error) });
      }
    }
  }

  function startTicking(): void {
    if (tickHandle !== null) return;
    tickHandle = timers.setInterval(tick, tickIntervalMs);
    // Never pin the event loop: an idle runtime must be able to exit even if
    // a consumer forgot to dispose (mirrors ScheduleManager.destroy hygiene).
    unrefHandle(tickHandle);
  }

  function stopTicking(): void {
    if (tickHandle === null) return;
    timers.clearInterval(tickHandle);
    tickHandle = null;
    lastSignature = null;
  }

  function subscribe(listener: (snapshot: FleetSnapshot) => void): () => void {
    if (disposed) return () => undefined;
    listeners.add(listener);
    startTicking();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) stopTicking();
    };
  }

  // ── Control dispatch (existing manager paths only) ─────────────────────────

  function cancelAgents(agentIds: readonly (string | undefined)[]): string[] {
    const affected: string[] = [];
    for (const agentId of agentIds) {
      if (agentId && deps.agentManager.cancel(agentId)) affected.push(agentId);
    }
    return affected;
  }

  /** Primitive per-kind kill. Returns the node ids actually acted on. */
  function killNode(node: ProcessNode): string[] {
    switch (node.kind) {
      case 'agent':
        return deps.agentManager.cancel(node.id) ? [node.id] : [];
      case 'background-process':
        return deps.processManager.stop(node.id) ? [node.id] : [];
      case 'watcher':
        return deps.watcherRegistry.stopWatcher(node.id) !== null ? [node.id] : [];
      case 'workflow':
        return deps.workflow.workflowManager.cancel(node.id) ? [node.id] : [];
      case 'trigger':
        return deps.workflow.triggerManager.remove(node.id) ? [node.id] : [];
      case 'schedule': {
        const entry = node.raw as ScheduleEntry;
        return deps.workflow.scheduleManager.remove(entry.name) ? [node.id] : [];
      }
      case 'wrfc-chain': {
        // DERIVED, not native: WrfcController exposes no public cancel/abort,
        // so chain kill cascades AgentManager.cancel over the member agents.
        const chain = node.raw as WrfcChain;
        const affected = cancelAgents(chain.allAgentIds);
        return affected.length > 0 ? [node.id, ...affected] : [];
      }
      case 'wrfc-subtask': {
        const subtask = node.raw as WrfcSubtask;
        const affected = cancelAgents([subtask.engineerAgentId, subtask.reviewerAgentId, subtask.fixerAgentId]);
        return affected.length > 0 ? [node.id, ...affected] : [];
      }
      default:
        return [];
    }
  }

  function kill(id: string, opts?: ProcessKillOptions): readonly string[] {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target) return [];
    const affected = new Set<string>();
    const targets: ProcessNode[] = [target];
    if (opts?.cascade) {
      // Children first, depth-first, so leaves stop before their parents.
      const byParent = new Map<string, ProcessNode[]>();
      for (const node of nodes) {
        if (!node.parentId) continue;
        const siblings = byParent.get(node.parentId) ?? [];
        siblings.push(node);
        byParent.set(node.parentId, siblings);
      }
      const stack = [target];
      const descendants: ProcessNode[] = [];
      const seen = new Set<string>([target.id]);
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const child of byParent.get(current.id) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          descendants.push(child);
          stack.push(child);
        }
      }
      targets.unshift(...descendants.reverse());
    }
    for (const node of targets) {
      for (const affectedId of killNode(node)) affected.add(affectedId);
    }
    return [...affected];
  }

  function interrupt(id: string): boolean {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target) return false;
    switch (target.kind) {
      case 'agent':
        return deps.agentManager.cancel(target.id);
      case 'trigger':
        return deps.workflow.triggerManager.disable(target.id);
      case 'schedule': {
        const entry = target.raw as ScheduleEntry;
        return deps.workflow.scheduleManager.disable(entry.name);
      }
      default:
        return false;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopTicking();
    for (const unsubscribe of busUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.warn('[fleet] bus unsubscribe failed on dispose', { error: summarizeError(error) });
      }
    }
    busUnsubscribers.length = 0;
    listeners.clear();
    activity.clear();
  }

  return { query, getNode, subscribe, interrupt, kill, dispose };
}
