/**
 * ops-control-plane.test.ts — SDK-owned behavioral coverage for
 * OpsControlPlane (runtime/ops/control-plane.ts).
 *
 * This class ships from the SDK but had ZERO SDK-side tests (its only living
 * coverage was a consumer fork suite, now deleted). Covers, against the REAL
 * UnifiedTaskManager + RuntimeStore + RuntimeEventBus:
 *   - task cancel/pause/resume/retry legality per the lifecycle state machine
 *   - rejected-outcome audit events (the specific OPS_TASK_* event AND the
 *     generic OPS_AUDIT) on every illegal action
 *   - cancelAgent state gating (cancellable vs terminal states)
 *   - the can* query helpers the UI renders controls from
 */
import { describe, expect, test } from 'bun:test';
import {
  OpsControlPlane,
  OpsIllegalActionError,
  OpsTargetNotFoundError,
} from '../packages/sdk/src/platform/runtime/ops/control-plane.ts';
import { UnifiedTaskManager } from '../packages/sdk/src/platform/runtime/tasks/manager.ts';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import type { RuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.ts';
import type { RuntimeAgent, AgentLifecycleState } from '../packages/sdk/src/platform/runtime/store/domains/agents.ts';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.ts';

interface OpsEventCapture {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

function makeHarness(): {
  ops: OpsControlPlane;
  tasks: UnifiedTaskManager;
  store: RuntimeStore;
  events: OpsEventCapture[];
  flush: () => Promise<void>;
} {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const tasks = new UnifiedTaskManager(store, bus, 'sess-ops');
  const ops = new OpsControlPlane(tasks, bus, store, 'sess-ops');
  const events: OpsEventCapture[] = [];
  bus.onDomain('ops', (envelope) => {
    events.push({ type: envelope.type, payload: envelope.payload as Record<string, unknown> });
  });
  return {
    ops, tasks, store, events,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

function seedAgent(store: RuntimeStore, id: string, status: AgentLifecycleState): void {
  const agent: RuntimeAgent = {
    id,
    label: `agent ${id}`,
    role: 'engineer' as RuntimeAgent['role'],
    status,
    providerId: 'test-provider',
    modelId: 'test-model',
    childAgentIds: [],
    turnCount: 0,
    toolCallCount: 0,
    latestOutput: '',
    spawnedAt: Date.now(),
  };
  store.setState((state) => ({
    ...state,
    agents: {
      ...state.agents,
      agents: new Map(state.agents.agents).set(id, agent),
    },
  }));
}

function opsEventsOf(events: OpsEventCapture[], type: string): OpsEventCapture[] {
  return events.filter((e) => e.type === type);
}

describe('OpsControlPlane — task cancel legality', () => {
  test('a running cancellable task cancels, with a success audit trail', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'exec', title: 'build', owner: 'test' });
    tasks.startTask(task.id);

    ops.cancelTask(task.id, 'operator said stop');
    await flush();

    expect(tasks.getTask(task.id)!.status).toBe('cancelled');
    const cancelled = opsEventsOf(events, 'OPS_TASK_CANCELLED');
    // The manager's own cancelTask emits its lifecycle event; the ops event we
    // want is the one paired with an OPS_AUDIT carrying the outcome.
    expect(cancelled.some((e) => e.payload['taskId'] === task.id && e.payload['note'] === 'operator said stop')).toBe(true);
    const audits = opsEventsOf(events, 'OPS_AUDIT');
    expect(audits.some((a) => a.payload['action'] === 'task.cancel' && a.payload['outcome'] === 'success' && a.payload['targetId'] === task.id)).toBe(true);
  });

  test('cancelling a terminal (completed) task is REJECTED with both audit events', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'exec', title: 'done already', owner: 'test' });
    tasks.startTask(task.id);
    tasks.completeTask(task.id);
    events.length = 0;

    expect(() => ops.cancelTask(task.id)).toThrow(OpsIllegalActionError);
    await flush();

    // BOTH audit events fire on the rejected action: the specific ops event…
    const rejected = opsEventsOf(events, 'OPS_TASK_CANCELLED');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({ taskId: task.id, reason: 'ops_cancel' });
    // …and the generic OPS_AUDIT carrying the rejected outcome + error text.
    const audits = opsEventsOf(events, 'OPS_AUDIT');
    const audit = audits.find((a) => a.payload['action'] === 'task.cancel' && a.payload['targetId'] === task.id);
    expect(audit!.payload['outcome']).toBe('rejected');
    expect(typeof audit!.payload['errorMessage']).toBe('string');
    // The task was NOT mutated by the rejected action.
    expect(tasks.getTask(task.id)!.status).toBe('completed');
  });

  test('a non-cancellable task rejects cancel even while running', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'daemon', title: 'pinned', owner: 'test', cancellable: false });
    tasks.startTask(task.id);
    events.length = 0;

    expect(() => ops.cancelTask(task.id)).toThrow(OpsIllegalActionError);
    await flush();
    expect(opsEventsOf(events, 'OPS_TASK_CANCELLED')).toHaveLength(1);
    expect(opsEventsOf(events, 'OPS_AUDIT').find((a) => a.payload['action'] === 'task.cancel')!.payload['outcome']).toBe('rejected');
    expect(tasks.getTask(task.id)!.status).toBe('running');
  });

  test('an unknown task id is a not-found error, not an audit event', async () => {
    const { ops, events, flush } = makeHarness();
    expect(() => ops.cancelTask('nope')).toThrow(OpsTargetNotFoundError);
    await flush();
    expect(events).toHaveLength(0);
  });
});

describe('OpsControlPlane — pause/resume legality', () => {
  test('pause is legal only from running; resume only from a resumable state', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'agent', title: 'work', owner: 'test' });
    tasks.startTask(task.id);

    ops.pauseTask(task.id, 'hold');
    expect(tasks.getTask(task.id)!.status).toBe('blocked');

    ops.resumeTask(task.id, 'go');
    expect(tasks.getTask(task.id)!.status).toBe('running');

    await flush();
    expect(opsEventsOf(events, 'OPS_TASK_PAUSED')).toHaveLength(1);
    expect(opsEventsOf(events, 'OPS_TASK_RESUMED')).toHaveLength(1);
    const audits = opsEventsOf(events, 'OPS_AUDIT');
    expect(audits.some((a) => a.payload['action'] === 'task.pause' && a.payload['outcome'] === 'success')).toBe(true);
    expect(audits.some((a) => a.payload['action'] === 'task.resume' && a.payload['outcome'] === 'success')).toBe(true);
  });

  test('pausing a completed task and resuming a completed task are rejected with audits', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'exec', title: 'finished', owner: 'test' });
    tasks.startTask(task.id);
    tasks.completeTask(task.id);
    events.length = 0;

    expect(() => ops.pauseTask(task.id)).toThrow(OpsIllegalActionError);
    expect(() => ops.resumeTask(task.id)).toThrow(OpsIllegalActionError);
    await flush();

    expect(opsEventsOf(events, 'OPS_TASK_PAUSED')).toHaveLength(1);
    expect(opsEventsOf(events, 'OPS_TASK_RESUMED')).toHaveLength(1);
    const rejectedAudits = opsEventsOf(events, 'OPS_AUDIT').filter((a) => a.payload['outcome'] === 'rejected');
    expect(rejectedAudits.map((a) => a.payload['action']).sort()).toEqual(['task.pause', 'task.resume']);
  });
});

describe('OpsControlPlane — retry legality', () => {
  test('a failed task retries back to queued with a success audit', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const task = tasks.createTask({ kind: 'exec', title: 'flaky', owner: 'test' });
    tasks.startTask(task.id);
    tasks.failTask(task.id, { error: 'boom' });

    ops.retryTask(task.id, 'try again');
    await flush();

    expect(tasks.getTask(task.id)!.status).toBe('queued');
    expect(opsEventsOf(events, 'OPS_TASK_RETRIED')).toHaveLength(1);
    expect(opsEventsOf(events, 'OPS_AUDIT').find((a) => a.payload['action'] === 'task.retry')!.payload['outcome']).toBe('success');
  });

  test('a cancelled task is retryable; a running or completed one is not', async () => {
    const { ops, tasks, events, flush } = makeHarness();
    const cancelled = tasks.createTask({ kind: 'exec', title: 'c', owner: 'test' });
    tasks.startTask(cancelled.id);
    tasks.cancelTask(cancelled.id, { reason: 'stop' });
    ops.retryTask(cancelled.id);
    expect(tasks.getTask(cancelled.id)!.status).toBe('queued');

    const running = tasks.createTask({ kind: 'exec', title: 'r', owner: 'test' });
    tasks.startTask(running.id);
    await flush(); // drain the earlier success events before clearing
    events.length = 0;
    expect(() => ops.retryTask(running.id)).toThrow(OpsIllegalActionError);
    await flush();
    expect(opsEventsOf(events, 'OPS_TASK_RETRIED')).toHaveLength(1);
    expect(opsEventsOf(events, 'OPS_AUDIT').find((a) => a.payload['action'] === 'task.retry')!.payload['outcome']).toBe('rejected');
    expect(tasks.getTask(running.id)!.status).toBe('running');
  });
});

describe('OpsControlPlane — cancelAgent state gating', () => {
  const cancellable: AgentLifecycleState[] = ['spawning', 'running', 'awaiting_message', 'awaiting_tool', 'finalizing'];
  const terminal: AgentLifecycleState[] = ['completed', 'failed', 'cancelled'];

  test('every non-terminal state is cancellable; the store transition lands with endedAt', async () => {
    for (const status of cancellable) {
      const { ops, store, events, flush } = makeHarness();
      const id = `agent-${status}`;
      seedAgent(store, id, status);

      expect(ops.canCancelAgent(id)).toBe(true);
      ops.cancelAgent(id, `cancel from ${status}`);
      await flush();

      const record = store.getState().agents.agents.get(id)!;
      expect(record.status).toBe('cancelled');
      expect(typeof record.endedAt).toBe('number');
      expect(opsEventsOf(events, 'OPS_AGENT_CANCELLED')[0]!.payload).toMatchObject({ agentId: id });
      expect(opsEventsOf(events, 'OPS_AUDIT').find((a) => a.payload['action'] === 'agent.cancel')!.payload['outcome']).toBe('success');
    }
  });

  test('every terminal state rejects cancel with both audit events and no mutation', async () => {
    for (const status of terminal) {
      const { ops, store, events, flush } = makeHarness();
      const id = `agent-${status}`;
      seedAgent(store, id, status);

      expect(ops.canCancelAgent(id)).toBe(false);
      expect(() => ops.cancelAgent(id)).toThrow(OpsIllegalActionError);
      await flush();

      expect(store.getState().agents.agents.get(id)!.status).toBe(status);
      expect(opsEventsOf(events, 'OPS_AGENT_CANCELLED')[0]!.payload).toMatchObject({ agentId: id });
      const audit = opsEventsOf(events, 'OPS_AUDIT').find((a) => a.payload['action'] === 'agent.cancel');
      expect(audit!.payload['outcome']).toBe('rejected');
      expect(typeof audit!.payload['errorMessage']).toBe('string');
    }
  });

  test('an unknown agent id is a not-found error', () => {
    const { ops } = makeHarness();
    expect(() => ops.cancelAgent('ghost')).toThrow(OpsTargetNotFoundError);
    expect(ops.canCancelAgent('ghost')).toBe(false);
  });
});

describe('OpsControlPlane — can* query helpers mirror the legality checks', () => {
  test('per-state truth table for a task', () => {
    const { ops, tasks } = makeHarness();
    const task = tasks.createTask({ kind: 'exec', title: 'q', owner: 'test' });

    // queued: cancellable, not pausable/resumable/retryable
    expect(ops.canCancelTask(task.id)).toBe(true);
    expect(ops.canPauseTask(task.id)).toBe(false);
    expect(ops.canRetryTask(task.id)).toBe(false);

    tasks.startTask(task.id);
    expect(ops.canCancelTask(task.id)).toBe(true);
    expect(ops.canPauseTask(task.id)).toBe(true);
    // running -> queued is the retry re-queue edge, so "resume" reads legal
    // from the transition matrix; retry stays failed/cancelled-only.
    expect(ops.canRetryTask(task.id)).toBe(false);

    tasks.blockTask(task.id, 'waiting');
    expect(ops.canResumeTask(task.id)).toBe(true);
    expect(ops.canPauseTask(task.id)).toBe(false);

    tasks.startTask(task.id);
    tasks.failTask(task.id, { error: 'x' });
    expect(ops.canRetryTask(task.id)).toBe(true);
    expect(ops.canCancelTask(task.id)).toBe(false);
    expect(ops.canResumeTask(task.id)).toBe(false);
  });

  test('unknown ids read false everywhere', () => {
    const { ops } = makeHarness();
    expect(ops.canCancelTask('x')).toBe(false);
    expect(ops.canPauseTask('x')).toBe(false);
    expect(ops.canResumeTask('x')).toBe(false);
    expect(ops.canRetryTask('x')).toBe(false);
  });
});
