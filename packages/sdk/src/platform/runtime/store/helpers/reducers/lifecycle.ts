import type { CompactionEvent, PermissionEvent, TaskEvent, AgentEvent, OrchestrationEvent } from '../events.js';
import type { SessionDomainState } from '../../domains/session.js';
import type {
  PermissionDomainState,
  PermissionDecisionMachineState,
  PermissionDecision,
} from '../../domains/permissions.js';
import type { TaskDomainState, RuntimeTask, TaskLifecycleState } from '../../domains/tasks.js';
import type { AgentDomainState, RuntimeAgent, AgentLifecycleState } from '../../domains/agents.js';
import type {
  OrchestrationDomainState,
  OrchestrationGraphRecord,
  OrchestrationNodeRecord,
} from '../../domains/orchestration.js';
import type { PermissionCategory } from '../../../../permissions/manager.js';
import { now, uniq, updateDomainMetadata } from './shared.js';

function permissionMachineStateForEvent(event: PermissionEvent): PermissionDecisionMachineState {
  switch (event.type) {
    case 'PERMISSION_REQUESTED':
      return 'collect_rules';
    case 'RULES_COLLECTED':
      return 'normalize_input';
    case 'INPUT_NORMALIZED':
      return 'evaluate_policy';
    case 'POLICY_EVALUATED':
      return 'evaluate_runtime_mode';
    case 'MODE_EVALUATED':
      return 'evaluate_session_override';
    case 'SESSION_OVERRIDE_EVALUATED':
      return 'final_safety_checks';
    case 'SAFETY_CHECKED':
    case 'DECISION_EMITTED':
      return 'decision_emitted';
  }
}

function inferPermissionCategory(toolName: string): PermissionCategory {
  if (toolName === 'agent' || toolName === 'delegate') return 'delegate';
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') return 'write';
  if (toolName === 'exec' || toolName === 'precision_exec' || toolName === 'bash') return 'execute';
  return 'read';
}

export function updateSessionState(
  domain: SessionDomainState,
  event: CompactionEvent,
): SessionDomainState {
  const base = updateDomainMetadata(domain, event.type);
  switch (event.type) {
    case 'COMPACTION_CHECK':
      return { ...base, compactionState: 'checking_threshold' };
    case 'COMPACTION_MICROCOMPACT':
      return { ...base, compactionState: 'microcompact' };
    case 'COMPACTION_COLLAPSE':
      return { ...base, compactionState: 'collapse', compactionMessageCount: event.messageCount };
    case 'COMPACTION_AUTOCOMPACT':
      return { ...base, compactionState: 'autocompact' };
    case 'COMPACTION_REACTIVE':
      return { ...base, compactionState: 'reactive_compact' };
    case 'COMPACTION_BOUNDARY_COMMIT':
      return { ...base, compactionState: 'boundary_commit' };
    case 'COMPACTION_DONE':
      return { ...base, compactionState: 'done', lastCompactedAt: now() };
    case 'COMPACTION_FAILED':
      return { ...base, compactionState: 'failed', recoveryError: event.error };
    case 'COMPACTION_RESUME_REPAIR':
      return { ...base, wasRepaired: event.repaired, recoveryState: event.safeToResume ? 'ready' : domain.recoveryState };
    case 'COMPACTION_QUALITY_SCORE':
    case 'COMPACTION_STRATEGY_SWITCH':
      return base;
  }
}

export function updatePermissionState(
  domain: PermissionDomainState,
  event: PermissionEvent,
): PermissionDomainState {
  const base = updateDomainMetadata(domain, event.type);
  switch (event.type) {
    case 'PERMISSION_REQUESTED':
      return { ...base, awaitingDecision: true, decisionMachineState: permissionMachineStateForEvent(event), totalChecks: domain.totalChecks + 1 };
    case 'RULES_COLLECTED':
    case 'INPUT_NORMALIZED':
    case 'POLICY_EVALUATED':
    case 'MODE_EVALUATED':
    case 'SESSION_OVERRIDE_EVALUATED':
    case 'SAFETY_CHECKED':
      return { ...base, awaitingDecision: true, decisionMachineState: permissionMachineStateForEvent(event) };
    case 'DECISION_EMITTED':
      return {
        ...base,
        awaitingDecision: false,
        decisionMachineState: permissionMachineStateForEvent(event),
        approvalCount: domain.approvalCount + (event.approved ? 1 : 0),
        denialCount: domain.denialCount + (event.approved ? 0 : 1),
        lastDecision: {
          callId: event.callId,
          toolName: event.tool,
          category: inferPermissionCategory(event.tool),
          machineState: 'decision_emitted',
          outcome: event.approved ? 'approved' : 'denied',
          reason: (event.reasonCode as PermissionDecision['reason']) ?? (event.approved ? 'user_approved' : 'user_denied'),
          sourceLayer: (event.sourceLayer as PermissionDecision['sourceLayer']) ?? (event.source as PermissionDecision['sourceLayer']) ?? 'config_policy',
          persisted: event.persisted ?? false,
          classification: event.classification,
          riskLevel: event.riskLevel as PermissionDecision['riskLevel'],
          summary: event.summary,
          decidedAt: now(),
        },
      };
  }
}

function updateTaskIndexes(tasks: Map<string, RuntimeTask>) {
  const queuedIds: string[] = [];
  const runningIds: string[] = [];
  const blockedIds: string[] = [];
  for (const [taskId, task] of tasks.entries()) {
    if (task.status === 'queued') queuedIds.push(taskId);
    if (task.status === 'running') runningIds.push(taskId);
    if (task.status === 'blocked') blockedIds.push(taskId);
  }
  return { queuedIds, runningIds, blockedIds };
}

function isTerminalTaskStatus(status: TaskLifecycleState): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function countTaskTransition(
  domain: TaskDomainState,
  previous: RuntimeTask | undefined,
  task: RuntimeTask,
): Pick<TaskDomainState, 'totalCreated' | 'totalCompleted' | 'totalFailed' | 'totalCancelled'> {
  let { totalCreated, totalCompleted, totalFailed, totalCancelled } = domain;
  if (!previous) totalCreated += 1;
  if (previous?.status !== task.status) {
    if (task.status === 'completed') totalCompleted += 1;
    else if (task.status === 'failed') totalFailed += 1;
    else if (task.status === 'cancelled') totalCancelled += 1;
  }
  return { totalCreated, totalCompleted, totalFailed, totalCancelled };
}

export function updateTaskState(domain: TaskDomainState, event: TaskEvent): TaskDomainState {
  const tasks = new Map(domain.tasks);
  const existing = tasks.get(event.taskId);
  const timestamp = now();
  if (!existing && event.type !== 'TASK_CREATED') return domain;

  const task: RuntimeTask = existing ?? {
    id: event.taskId,
    kind: 'agentId' in event && event.agentId ? 'agent' : 'exec',
    title: 'description' in event ? event.description : `task:${event.taskId}`,
    description: 'description' in event ? event.description : undefined,
    status: 'queued',
    owner: event.agentId ?? 'runtime',
    cancellable: true,
    childTaskIds: [],
    queuedAt: timestamp,
  };

  if (existing && isTerminalTaskStatus(existing.status) && event.type !== 'TASK_CREATED') {
    return domain;
  }

  switch (event.type) {
    case 'TASK_CREATED':
      tasks.set(event.taskId, task);
      break;
    case 'TASK_STARTED':
      tasks.set(event.taskId, { ...task, status: 'running', startedAt: task.startedAt ?? timestamp });
      break;
    case 'TASK_BLOCKED':
      tasks.set(event.taskId, { ...task, status: 'blocked', error: event.reason });
      break;
    case 'TASK_PROGRESS':
      tasks.set(event.taskId, { ...task, description: event.message ?? task.description });
      break;
    case 'TASK_COMPLETED':
      tasks.set(event.taskId, { ...task, status: 'completed', endedAt: timestamp, result: { durationMs: event.durationMs } });
      break;
    case 'TASK_FAILED':
      tasks.set(event.taskId, { ...task, status: 'failed', endedAt: timestamp, error: event.error });
      break;
    case 'TASK_CANCELLED':
      tasks.set(event.taskId, { ...task, status: 'cancelled', endedAt: timestamp, error: event.reason });
      break;
  }
  const updated = tasks.get(event.taskId);
  if (!updated) return domain;
  const indexes = updateTaskIndexes(tasks);
  const counts = countTaskTransition(domain, existing, updated);
  return {
    ...updateDomainMetadata(domain, event.type),
    tasks,
    ...indexes,
    ...counts,
  };
}

function updateTaskDomainFromRecord(domain: TaskDomainState, task: RuntimeTask, source: string): TaskDomainState {
  const tasks = new Map(domain.tasks);
  const previous = tasks.get(task.id);
  tasks.set(task.id, task);
  const indexes = updateTaskIndexes(tasks);
  const counts = countTaskTransition(domain, previous, task);

  return { ...updateDomainMetadata(domain, source), tasks, ...indexes, ...counts };
}

function transitionTaskDomainRecord(
  domain: TaskDomainState,
  taskId: string,
  status: TaskLifecycleState,
  patch: Partial<RuntimeTask> | undefined,
  source: string,
): TaskDomainState {
  const existing = domain.tasks.get(taskId);
  if (!existing) return domain;
  return updateTaskDomainFromRecord(domain, { ...existing, ...patch, status }, source);
}

function agentStatusForEvent(event: AgentEvent): AgentLifecycleState {
  switch (event.type) {
    case 'AGENT_SPAWNING':
      return 'spawning';
    case 'AGENT_RUNNING':
    case 'AGENT_PROGRESS':
    case 'AGENT_STREAM_DELTA':
      return 'running';
    case 'AGENT_AWAITING_MESSAGE':
      return 'awaiting_message';
    case 'AGENT_AWAITING_TOOL':
      return 'awaiting_tool';
    case 'AGENT_FINALIZING':
      return 'finalizing';
    case 'AGENT_COMPLETED':
      return 'completed';
    case 'AGENT_FAILED':
      return 'failed';
    case 'AGENT_CANCELLED':
      return 'cancelled';
  }
  return assertNeverAgentEvent(event);
}

function assertNeverAgentEvent(event: never): never {
  throw new Error(`Unhandled agent event type: ${String((event as { type?: unknown }).type)}`);
}

function isTerminalAgentStatus(status: AgentLifecycleState): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isWrfcOwnerRevivalEvent(event: AgentEvent): boolean {
  return (
    (event.type === 'AGENT_RUNNING' || event.type === 'AGENT_PROGRESS')
    && event.wrfcRole === 'owner'
    && typeof event.wrfcId === 'string'
    && event.wrfcId.length > 0
  );
}

export function updateAgentState(domain: AgentDomainState, event: AgentEvent): AgentDomainState {
  const agents = new Map(domain.agents);
  const timestamp = now();
  const existing = agents.get(event.agentId);
  if (!existing && event.type !== 'AGENT_SPAWNING') return domain;

  const nextStatus = agentStatusForEvent(event);
  const revivedWrfcOwner = Boolean(existing && isTerminalAgentStatus(existing.status) && isWrfcOwnerRevivalEvent(event));
  if (existing && isTerminalAgentStatus(existing.status) && nextStatus !== existing.status && !revivedWrfcOwner) {
    return domain;
  }

  const agent: RuntimeAgent =
    existing ??
    {
      id: event.agentId,
      label: 'task' in event ? event.task : event.agentId,
      role: 'subagent',
      status: nextStatus,
      providerId: 'unknown',
      modelId: 'unknown',
      childAgentIds: [],
      taskId: event.taskId,
      turnCount: 0,
      toolCallCount: 0,
      latestOutput: '',
      spawnedAt: timestamp,
    };
  agents.set(event.agentId, {
    ...agent,
    status: nextStatus,
    parentAgentId: 'parentAgentId' in event ? event.parentAgentId ?? agent.parentAgentId : agent.parentAgentId,
    wrfcRef: 'wrfcId' in event && event.wrfcId
      ? {
          chainId: event.wrfcId,
          chainRole: event.wrfcRole ?? agent.wrfcRef?.chainRole ?? 'engineer',
          phaseOrder: event.wrfcPhaseOrder ?? agent.wrfcRef?.phaseOrder,
        }
      : agent.wrfcRef,
    taskId: event.taskId ?? agent.taskId,
    latestProgress:
      event.type === 'AGENT_PROGRESS'
        ? event.progress
        : event.type === 'AGENT_AWAITING_TOOL'
          ? `${event.tool}:${event.callId}`
          : agent.latestProgress,
    latestOutput:
      event.type === 'AGENT_STREAM_DELTA'
        ? event.accumulated
        : event.type === 'AGENT_COMPLETED' && event.output !== undefined
          ? event.output
          : agent.latestOutput,
    endedAt:
      event.type === 'AGENT_COMPLETED' || event.type === 'AGENT_FAILED' || event.type === 'AGENT_CANCELLED'
        ? timestamp
        : revivedWrfcOwner
          ? undefined
          : agent.endedAt,
    error: event.type === 'AGENT_FAILED' ? event.error : revivedWrfcOwner ? undefined : agent.error,
    toolCallCount:
      event.type === 'AGENT_COMPLETED' && event.toolCallsMade !== undefined
        ? event.toolCallsMade
        : agent.toolCallCount,
    result:
      event.type === 'AGENT_COMPLETED'
        ? {
            durationMs: event.durationMs,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.toolCallsMade !== undefined ? { toolCallsMade: event.toolCallsMade } : {}),
          }
        : revivedWrfcOwner ? undefined : agent.result,
  });
  const activeAgentIds = [...agents.values()].filter((value) => !['completed', 'failed', 'cancelled'].includes(value.status)).map((value) => value.id);
  const completedCorrection = revivedWrfcOwner && existing?.status === 'completed' ? -1 : 0;
  const failedCorrection = revivedWrfcOwner && existing?.status === 'failed' ? -1 : 0;
  return {
    ...updateDomainMetadata(domain, event.type),
    agents,
    activeAgentIds,
    totalSpawned: domain.totalSpawned + (!existing && event.type === 'AGENT_SPAWNING' ? 1 : 0),
    totalCompleted: Math.max(
      0,
      domain.totalCompleted + completedCorrection + (existing?.status !== 'completed' && nextStatus === 'completed' ? 1 : 0),
    ),
    totalFailed: Math.max(
      0,
      domain.totalFailed + failedCorrection + (existing?.status !== 'failed' && nextStatus === 'failed' ? 1 : 0),
    ),
    peakConcurrency: Math.max(domain.peakConcurrency, activeAgentIds.length),
  };
}

function transitionAgentDomainRecord(
  domain: AgentDomainState,
  agentId: string,
  status: AgentLifecycleState,
  patch: Partial<RuntimeAgent> | undefined,
  source: string,
): AgentDomainState {
  const existing = domain.agents.get(agentId);
  if (!existing) return domain;

  const agents = new Map(domain.agents);
  agents.set(agentId, { ...existing, ...patch, status });
  const activeAgentIds = [...agents.values()].filter((value) => !['completed', 'failed', 'cancelled'].includes(value.status)).map((value) => value.id);

  return {
    ...updateDomainMetadata(domain, source),
    agents,
    activeAgentIds,
    totalCompleted: domain.totalCompleted + (existing.status !== 'completed' && status === 'completed' ? 1 : 0),
    totalFailed: domain.totalFailed + (existing.status !== 'failed' && status === 'failed' ? 1 : 0),
    peakConcurrency: Math.max(domain.peakConcurrency, activeAgentIds.length),
  };
}

function orchestrationGraphStatus(graph: OrchestrationGraphRecord): OrchestrationGraphRecord['status'] {
  const nodes = [...graph.nodes.values()];
  if (nodes.length === 0) return 'planning';
  if (nodes.some((node) => node.status === 'failed')) return 'failed';
  if (nodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node.status === 'running')) return 'running';
  if (nodes.every((node) => node.status === 'cancelled')) return 'cancelled';
  if (nodes.every((node) => node.status === 'completed')) return 'completed';
  if (nodes.every((node) => node.status === 'pending' || node.status === 'ready')) {
    return nodes.some((node) => node.status === 'ready') ? 'ready' : 'planning';
  }
  return 'running';
}

export function updateOrchestrationState(
  domain: OrchestrationDomainState,
  event: OrchestrationEvent,
): OrchestrationDomainState {
  const graphs = new Map(domain.graphs);
  const timestamp = now();
  const existing = 'graphId' in event ? graphs.get(event.graphId) : undefined;

  switch (event.type) {
    case 'ORCHESTRATION_GRAPH_CREATED':
      graphs.set(event.graphId, {
        id: event.graphId,
        title: event.title,
        mode: event.mode,
        status: 'planning',
        nodeOrder: [],
        nodes: new Map(),
        createdAt: timestamp,
      });
      break;
    case 'ORCHESTRATION_NODE_ADDED': {
      if (!existing) return domain;
      const nodes = new Map(existing.nodes);
      const previousParent = event.parentNodeId ? nodes.get(event.parentNodeId) : undefined;
      const nextNode: OrchestrationNodeRecord = {
        id: event.nodeId,
        title: event.title,
        role: event.role,
        status: 'pending',
        parentNodeId: event.parentNodeId,
        childNodeIds: [],
        dependencyNodeIds: event.dependsOn ?? [],
        ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
        ...(event.agentId !== undefined ? { agentId: event.agentId } : {}),
        ...(event.contract !== undefined ? { contract: event.contract } : {}),
      };
      nodes.set(event.nodeId, nextNode);
      if (previousParent) {
        nodes.set(event.parentNodeId!, { ...previousParent, childNodeIds: uniq([...previousParent.childNodeIds, event.nodeId]) });
      }
      const graph: OrchestrationGraphRecord = { ...existing, nodeOrder: uniq([...existing.nodeOrder, event.nodeId]), nodes };
      graph.status = orchestrationGraphStatus(graph);
      graphs.set(event.graphId, graph);
      break;
    }
    case 'ORCHESTRATION_NODE_READY':
    case 'ORCHESTRATION_NODE_STARTED':
    case 'ORCHESTRATION_NODE_PROGRESS':
    case 'ORCHESTRATION_NODE_BLOCKED':
    case 'ORCHESTRATION_NODE_COMPLETED':
    case 'ORCHESTRATION_NODE_FAILED':
    case 'ORCHESTRATION_NODE_CANCELLED':
    case 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED': {
      if (!existing) return domain;
      const nodes = new Map(existing.nodes);
      const nodeId = 'nodeId' in event ? event.nodeId : undefined;
      if (nodeId) {
        const node = nodes.get(nodeId);
        if (!node) return domain;
        const updatedNode: OrchestrationNodeRecord =
          event.type === 'ORCHESTRATION_NODE_READY'
            ? { ...node, status: 'ready' }
            : event.type === 'ORCHESTRATION_NODE_STARTED'
              ? { ...node, status: 'running', startedAt: node.startedAt ?? timestamp, ...(event.taskId !== undefined ? { taskId: event.taskId } : {}), ...(event.agentId !== undefined ? { agentId: event.agentId } : {}) }
              : event.type === 'ORCHESTRATION_NODE_PROGRESS'
                ? { ...node, latestMessage: event.message }
                : event.type === 'ORCHESTRATION_NODE_BLOCKED'
                  ? { ...node, status: 'blocked', error: event.reason }
                  : event.type === 'ORCHESTRATION_NODE_COMPLETED'
                    ? { ...node, status: 'completed', endedAt: timestamp, latestMessage: event.summary ?? node.latestMessage }
                    : event.type === 'ORCHESTRATION_NODE_FAILED'
                      ? { ...node, status: 'failed', endedAt: timestamp, error: event.error }
                      : { ...node, status: 'cancelled', endedAt: timestamp, error: event.reason };
        nodes.set(nodeId, updatedNode);
      }
      const graph: OrchestrationGraphRecord = {
        ...existing,
        nodes,
        ...(event.type === 'ORCHESTRATION_NODE_STARTED' ? { startedAt: existing.startedAt ?? timestamp } : {}),
        ...(event.type === 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED'
          ? {
              lastRecursionGuard: {
                depth: event.depth,
                activeAgents: event.activeAgents,
                reason: event.reason,
                ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
                triggeredAt: timestamp,
              },
            }
          : {}),
      };
      graph.status = orchestrationGraphStatus(graph);
      if (graph.status === 'completed' || graph.status === 'failed' || graph.status === 'cancelled') {
        graph.endedAt = graph.endedAt ?? timestamp;
      }
      graphs.set(graph.id, graph);
      break;
    }
  }

  const activeGraphIds = [...graphs.values()].filter((graph) => !['completed', 'failed', 'cancelled'].includes(graph.status)).map((graph) => graph.id);

  return {
    ...updateDomainMetadata(domain, event.type),
    graphs,
    activeGraphIds,
    totalGraphs: graphs.size,
    totalCompletedGraphs: [...graphs.values()].filter((graph) => graph.status === 'completed').length,
    totalFailedGraphs: [...graphs.values()].filter((graph) => graph.status === 'failed').length,
    recursionGuardTrips: domain.recursionGuardTrips + (event.type === 'ORCHESTRATION_RECURSION_GUARD_TRIGGERED' ? 1 : 0),
  };
}

export { updateTaskDomainFromRecord, transitionTaskDomainRecord, transitionAgentDomainRecord };
