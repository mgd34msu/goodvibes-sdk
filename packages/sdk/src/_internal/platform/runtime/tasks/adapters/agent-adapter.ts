/**
 * AgentTaskAdapter — bridges agent sessions (AgentOrchestrator / WRFC agents)
 * into the unified RuntimeTask registry.
 *
 * Each running agent gets a corresponding RuntimeTask of kind 'agent'. The
 * adapter maps agent lifecycle state strings to task lifecycle transitions.
 */

import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../../store/index.js';
import type { RuntimeStore, DomainDispatch } from '../../store/index.js';
import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { AgentLifecycleState } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/agents';
import type { RuntimeEventBus } from '../../events/index.js';

/** Owner context for an agent task. */
export interface AgentOwner {
  /** Session ID that spawned this agent. */
  sessionId: string;
}

/** Terminal agent lifecycle states that map to terminal task states. */
const TERMINAL_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/** Active (non-terminal, non-queued) agent states that map to 'running'. */
const RUNNING_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'running',
  'awaiting_message',
  'awaiting_tool',
  'finalizing',
]);

/**
 * Maps an agent lifecycle state string to a RuntimeTask lifecycle state.
 *
 * @param state - Agent lifecycle state from AgentLifecycleState.
 * @returns Corresponding task lifecycle state.
 */
function mapAgentStateToTask(
  state: AgentLifecycleState,
): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' {
  if (state === 'spawning') return 'queued';
  if (RUNNING_STATES.has(state)) return 'running';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  return 'running'; // fallback for unknown states
}

/**
 * Bridges agent sessions into the RuntimeTask registry.
 *
 * @example
 * ```ts
 * const adapter = new AgentTaskAdapter(store);
 * const taskId = adapter.wrapAgent('agent_1', 'Fix the linting errors', { sessionId: 'sess_1' });
 * adapter.handleAgentStateChange('agent_1', 'running');
 * adapter.handleAgentStateChange('agent_1', 'completed');
 * ```
 */
export class AgentTaskAdapter {
  /** Maps agent ID → task ID. */
  private readonly _agentToTask = new Map<string, string>();
  /** Maps task ID → agent ID. */
  private readonly _taskToAgent = new Map<string, string>();

  private readonly _dispatch: DomainDispatch;
  /** m3: idempotency guard — prevent double-wiring the bus */
  private _busAttached = false;

  constructor(private readonly _store: RuntimeStore) {
    this._dispatch = createDomainDispatch(_store);
  }

  // ── Runtime bus wiring ──────────────────────────────────────────────────────

  /**
   * Subscribe to AGENT_COMPLETED / AGENT_FAILED / AGENT_CANCELLED events on the
   * RuntimeEventBus and propagate them into the task registry.
   *
   * This is the authoritative wire that ensures task records reach terminal state
   * once their backing agent finishes — without it, tasks stay stuck in 'running'
   * indefinitely (the bug observed in daemon state at 192.168.0.61:3421).
   *
   * @param bus - The active RuntimeEventBus instance.
   * @returns An unsubscribe function that removes all three listeners.
   */
  attachRuntimeBus(bus: RuntimeEventBus): () => void {
    // m3: idempotent — second call is a no-op with a warning
    if (this._busAttached) {
      console.warn('[AgentTaskAdapter] attachRuntimeBus called more than once — ignoring duplicate call');
      return () => {};
    }
    this._busAttached = true;
    const onCompleted = bus.on<{ type: 'AGENT_COMPLETED'; agentId: string; taskId?: string; durationMs: number; output?: string }>(
      'AGENT_COMPLETED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const taskId = this._agentToTask.get(envelope.payload.agentId);
        if (taskId === undefined) return; // not a tracked agent — no-op
        this.handleAgentStateChange(envelope.payload.agentId, 'completed');
      },
    );
    const onFailed = bus.on<{ type: 'AGENT_FAILED'; agentId: string; taskId?: string; error: string; durationMs: number }>(
      'AGENT_FAILED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const taskId = this._agentToTask.get(envelope.payload.agentId);
        if (taskId === undefined) return;
        this.handleAgentStateChange(envelope.payload.agentId, 'failed');
      },
    );
    const onCancelled = bus.on<{ type: 'AGENT_CANCELLED'; agentId: string; taskId?: string; reason?: string }>(
      'AGENT_CANCELLED',
      (envelope) => {
        // m2: runtime type guard
        if (typeof envelope.payload?.agentId !== 'string') return;
        const taskId = this._agentToTask.get(envelope.payload.agentId);
        if (taskId === undefined) return;
        this.handleAgentStateChange(envelope.payload.agentId, 'cancelled');
      },
    );
    return () => {
      onCompleted();
      onFailed();
      onCancelled();
      this._busAttached = false;
    };
  }

  /**
   * M2: Reconcile adapter state on daemon restart.
   *
   * Any task in the runtime store with status 'running' at startup is marked
   * 'aborted' (mapped to 'cancelled') with reason 'daemon-restart', since
   * we cannot know if the backing agent is still alive.
   *
   * Call this from composition after attaching the bus.
   */
  reconcileOnRestart(): void {
    const tasks = this._store.getState().tasks.tasks;
    const stale: string[] = [];
    for (const [taskId, task] of tasks.entries()) {
      if (task.kind === 'agent' && task.status === 'running') {
        stale.push(taskId);
      }
    }
    for (const taskId of stale) {
      this._dispatch.transitionRuntimeTask(
        taskId,
        'cancelled',
        {
          endedAt: Date.now(),
          error: 'daemon-restart',
        },
        'agent-adapter-restart',
      );
      // Clean up reverse-lookup mappings if present
      const agentId = this._taskToAgent.get(taskId);
      if (agentId) {
        this._agentToTask.delete(agentId);
        this._taskToAgent.delete(taskId);
      }
    }
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Wrap an agent session as a RuntimeTask.
   *
   * @param agentId - Unique agent ID from the agent system.
   * @param task - Human-readable description of what the agent is doing.
   * @param owner - Session that spawned this agent.
   * @returns The new task ID.
   */
  wrapAgent(agentId: string, task: string, owner: AgentOwner): string {
    // Idempotent: return existing task ID if already wrapped
    const existing = this._agentToTask.get(agentId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = Date.now();

    const runtimeTask: RuntimeTask = {
      id: taskId,
      kind: 'agent',
      title: task.length > 80 ? `${task.slice(0, 77)}...` : task,
      description: task,
      status: 'queued',
      owner: agentId,
      cancellable: true,
      childTaskIds: [],
      queuedAt: now,
      correlationId: owner.sessionId,
    };

    this._agentToTask.set(agentId, taskId);
    this._taskToAgent.set(taskId, agentId);

    this._upsertTask(runtimeTask);
    return taskId;
  }

  /**
   * Handle an agent lifecycle state change and transition the task accordingly.
   *
   * @param agentId - The agent whose state changed.
   * @param state - New agent lifecycle state (AgentLifecycleState string).
   */
  handleAgentStateChange(agentId: string, state: AgentLifecycleState): void {
    const taskId = this._agentToTask.get(agentId);
    if (taskId === undefined) return;

    const agentState = state;
    const taskStatus = mapAgentStateToTask(agentState);

    this._transitionTask(taskId, taskStatus, {
      isTerminal: TERMINAL_STATES.has(agentState),
      error: agentState === 'failed' ? `Agent ${agentId} failed` : undefined,
    });

    // Clean up mappings once terminal
    if (TERMINAL_STATES.has(agentState)) {
      this._agentToTask.delete(agentId);
      this._taskToAgent.delete(taskId);
    }
  }

  /**
   * Cancel an agent task by task ID.
   * Marks the task as cancelled in the store. The caller is responsible for
   * actually stopping the agent session.
   *
   * @param taskId - The RuntimeTask ID to cancel.
   */
  cancelAgent(taskId: string): void {
    const agentId = this._taskToAgent.get(taskId);
    if (agentId === undefined) return;

    this._transitionTask(taskId, 'cancelled', { isTerminal: true });
    this._agentToTask.delete(agentId);
    this._taskToAgent.delete(taskId);
  }

  /**
   * Reconcile adapter state with an external agent registry snapshot.
   *
   * @param activeAgents - Current snapshot of active agents: agentId → task description.
   * @param owner - Default owner context for auto-wrapped agents.
   */
  sync(activeAgents: ReadonlyMap<string, string>, owner: AgentOwner = { sessionId: 'system' }): void {
    const liveIds = new Set(activeAgents.keys());

    // Wrap newly discovered agents
    for (const [agentId, task] of activeAgents.entries()) {
      if (!this._agentToTask.has(agentId)) {
        this.wrapAgent(agentId, task, owner);
      }
    }

    // Mark stale tracked agents as cancelled
    const staleAgentIds: string[] = [];
    for (const [agentId] of this._agentToTask.entries()) {
      if (!liveIds.has(agentId)) staleAgentIds.push(agentId);
    }
    for (const agentId of staleAgentIds) {
      const taskId = this._agentToTask.get(agentId)!;
      this._transitionTask(taskId, 'cancelled', { isTerminal: true });
      this._agentToTask.delete(agentId);
      this._taskToAgent.delete(taskId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _upsertTask(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'agent-adapter');
  }

  private _transitionTask(
    taskId: string,
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
    opts: { isTerminal?: boolean; error?: string },
  ): void {
    const current = this._store.getState().tasks.tasks.get(taskId);
    const timestamp = Date.now();
    this._dispatch.transitionRuntimeTask(
      taskId,
      status,
      {
        startedAt: status === 'running' && current?.startedAt === undefined ? timestamp : current?.startedAt,
        endedAt: opts.isTerminal ? timestamp : current?.endedAt,
        error: opts.error,
      },
      'agent-adapter',
    );
  }
}
