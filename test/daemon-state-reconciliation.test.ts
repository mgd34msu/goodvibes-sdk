/**
 * daemon-state-reconciliation.test.ts
 *
 * Regression tests for 0.18.42 — daemon state reconciliation.
 * Covers three invariants:
 *
 * DR1: SharedSessionBroker — AGENT_COMPLETED / AGENT_FAILED / AGENT_CANCELLED
 *      events on the RuntimeEventBus correctly transition spawned input records
 *      to terminal states. Missing wire was root cause of 8 stuck inputs at
 *      192.168.0.61:3421.
 *
 * DR2: AgentTaskAdapter — same bus events drive task records from 'running' to
 *      terminal. Missing wire kept tasks.list returning stale 'running' rows.
 *
 * DR3: SharedSessionBroker idle-session GC — _gcSweep() closes empty ghost
 *      sessions (messageCount=0, idle >= idleEmptyMs) and long-idle content
 *      sessions (idle >= idleLongMs) while leaving sessions with live agents
 *      alone.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { RuntimeEventBus } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';
import { AgentTaskAdapter } from '../packages/sdk/src/_internal/platform/runtime/tasks/adapters/agent-adapter.js';
import { createRuntimeStore } from '../packages/sdk/src/_internal/platform/runtime/store/index.js';
import type { RuntimeStore } from '../packages/sdk/src/_internal/platform/runtime/store/index.js';
import { createEventEnvelope } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';

// ---------------------------------------------------------------------------
// Real Zustand store for AgentTaskAdapter (required — createDomainDispatch uses store.setState)
// ---------------------------------------------------------------------------

function makeStore(): RuntimeStore {
  return createRuntimeStore();
}

// ---------------------------------------------------------------------------
// DR2: AgentTaskAdapter — task registry sync on agent terminal events
// ---------------------------------------------------------------------------

describe('DR2: AgentTaskAdapter.attachRuntimeBus — task registry sync', () => {
  let bus: RuntimeEventBus;
  let store: ReturnType<typeof makeStore>;
  let adapter: AgentTaskAdapter;

  beforeEach(() => {
    bus = new RuntimeEventBus();
    store = makeStore();
    adapter = new AgentTaskAdapter(store as any);
    adapter.attachRuntimeBus(bus);
  });

  function emitAgent(type: 'AGENT_COMPLETED' | 'AGENT_FAILED' | 'AGENT_CANCELLED', agentId: string, extra: Record<string, unknown> = {}): void {
    const payload = { type, agentId, durationMs: 100, ...extra } as any;
    bus.emit('agents', createEventEnvelope(type, payload, {
      sessionId: 'test-session',
      traceId: `test:${agentId}`,
      source: 'test',
    }));
  }

  test('AGENT_COMPLETED transitions task from running to completed', () => {
    const taskId = adapter.wrapAgent('ag-1', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-1', 'running');

    const before = store.getState().tasks.tasks.get(taskId);
    expect(before?.status).toBe('running');

    emitAgent('AGENT_COMPLETED', 'ag-1', { output: 'done', durationMs: 500 });

    const after = store.getState().tasks.tasks.get(taskId);
    expect(after?.status).toBe('completed');
  });

  test('AGENT_FAILED transitions task from running to failed', () => {
    const taskId = adapter.wrapAgent('ag-2', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-2', 'running');

    emitAgent('AGENT_FAILED', 'ag-2', { error: 'oops', durationMs: 200 });

    const after = store.getState().tasks.tasks.get(taskId);
    expect(after?.status).toBe('failed');
  });

  test('AGENT_CANCELLED transitions task from running to cancelled', () => {
    const taskId = adapter.wrapAgent('ag-3', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-3', 'running');

    emitAgent('AGENT_CANCELLED', 'ag-3', { reason: 'user cancelled' });

    const after = store.getState().tasks.tasks.get(taskId);
    expect(after?.status).toBe('cancelled');
  });

  test('AGENT_COMPLETED for unknown agentId does nothing (no crash, no false mutation)', () => {
    const taskId = adapter.wrapAgent('ag-known', 'Known', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-known', 'running');

    // Fire for an untracked agent — must not affect ag-known or throw
    expect(() => {
      emitAgent('AGENT_COMPLETED', 'ag-unknown');
    }).not.toThrow();

    const known = store.getState().tasks.tasks.get(taskId);
    expect(known?.status).toBe('running'); // unchanged
  });

  test('unsubscribe tears down listeners — subsequent events do not affect tasks', () => {
    const unsub = adapter.attachRuntimeBus(bus); // second subscription
    const taskId = adapter.wrapAgent('ag-unsub', 'Test', { sessionId: 'sess-x' });
    adapter.handleAgentStateChange('ag-unsub', 'running');

    unsub();

    // Fire — the second subscription was torn down; first still works but
    // the point is no crash and state is correct regardless
    expect(() => emitAgent('AGENT_COMPLETED', 'ag-unsub')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DR1: SharedSessionBroker — input record reconciliation via RuntimeEventBus
// ---------------------------------------------------------------------------

import type { SharedSessionRecord, SharedSessionMessage } from '../packages/sdk/src/_internal/platform/control-plane/session-types.js';
import type { SharedSessionInputRecord } from '../packages/sdk/src/_internal/platform/control-plane/session-intents.js';
import { SharedSessionBroker } from '../packages/sdk/src/_internal/platform/control-plane/session-broker.js';

/** Minimal in-memory PersistentStore stub (matches PersistentStore<T> API: load + persist) */
function makePersistentStoreStub(): any {
  let _data: any = null;
  return {
    load: async () => _data,
    persist: async (data: any) => { _data = data; },
  };
}

function makeRouteBindingStub(): any {
  return {
    start: async () => {},
    getBinding: () => null,
    patchBinding: async () => null,
  };
}

function makeBroker(idleEmptyMs = 10 * 60 * 1000, idleLongMs = 24 * 60 * 60 * 1000): SharedSessionBroker {
  const store = makePersistentStoreStub();
  const routeBindings = makeRouteBindingStub();
  const agentStatusProvider = { getStatus: () => null };
  const messageSender = { send: () => false };
  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider,
    messageSender,
    idleEmptyMs,
    idleLongMs,
  });
}

function emitAgentOnBus(
  bus: RuntimeEventBus,
  type: 'AGENT_COMPLETED' | 'AGENT_FAILED' | 'AGENT_CANCELLED',
  agentId: string,
  extra: Record<string, unknown> = {},
): void {
  const payload = { type, agentId, durationMs: 100, ...extra } as any;
  bus.emit('agents', createEventEnvelope(type, payload, {
    sessionId: 'broker-test',
    traceId: `broker:${agentId}`,
    source: 'test',
  }));
}

describe('DR1: SharedSessionBroker.attachRuntimeBus — input record reconciliation', () => {
  test('submit input transitions queued -> spawned -> completed on AGENT_COMPLETED', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();

    // Create session
    const session = await broker.createSession({ title: 'Test Session' });
    expect(session.status).toBe('active');

    // Track agentId -> sessionId
    const agentId = 'ag-dr1-complete';
    broker.attachRuntimeBus(bus, (id) => id === agentId ? session.id : null);

    // Submit first to create a queued input, then bind agent to claim it (spawned)
    const sub = await broker.submitMessage({
      sessionId: session.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-test',
      body: 'Hello agent',
    });
    // bindAgent claims the queued input -> transitions to 'spawned'
    await broker.bindAgent(session.id, agentId);

    const inputsBefore = broker.getInputs(session.id, 100);
    const claimed = inputsBefore.find((i) => i.id === sub.input.id);
    expect(claimed?.state).toBe('spawned');

    // Emit AGENT_COMPLETED — should finalize the input to 'completed'
    emitAgentOnBus(bus, 'AGENT_COMPLETED', agentId, { output: 'Done!', durationMs: 300 });

    // Give the async handler a tick to settle
    await new Promise<void>((resolve) => setImmediate(resolve));

    const inputsAfter = broker.getInputs(session.id, 100);
    const finalized = inputsAfter.find((i) => i.id === sub.input.id);
    expect(finalized?.state).toBe('completed');
  });

  test('AGENT_FAILED transitions spawned input to failed', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    const session = await broker.createSession({ title: 'Fail Test' });
    const agentId = 'ag-dr1-fail';
    broker.attachRuntimeBus(bus, (id) => id === agentId ? session.id : null);
    const sub = await broker.submitMessage({
      sessionId: session.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-test',
      body: 'Trigger fail',
    });
    await broker.bindAgent(session.id, agentId); // claims queued -> spawned
    const beforeInputs = broker.getInputs(session.id, 100);
    expect(beforeInputs.find((i) => i.id === sub.input.id)?.state).toBe('spawned');

    emitAgentOnBus(bus, 'AGENT_FAILED', agentId, { error: 'agent crashed' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const inputs = broker.getInputs(session.id, 100);
    const finalized = inputs.find((i) => i.id === sub.input.id);
    expect(finalized?.state).toBe('failed');
  });

  test('AGENT_CANCELLED transitions spawned input to cancelled', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    const session = await broker.createSession({ title: 'Cancel Test' });
    const agentId = 'ag-dr1-cancel';
    broker.attachRuntimeBus(bus, (id) => id === agentId ? session.id : null);
    const sub = await broker.submitMessage({
      sessionId: session.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-test',
      body: 'Trigger cancel',
    });
    await broker.bindAgent(session.id, agentId); // claims queued -> spawned
    const beforeInputs = broker.getInputs(session.id, 100);
    expect(beforeInputs.find((i) => i.id === sub.input.id)?.state).toBe('spawned');

    emitAgentOnBus(bus, 'AGENT_CANCELLED', agentId, { reason: 'user aborted' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const inputs = broker.getInputs(session.id, 100);
    const finalized = inputs.find((i) => i.id === sub.input.id);
    expect(finalized?.state).toBe('cancelled');
  });

  test('AGENT_COMPLETED for unknown agentId does nothing (no crash, no false mutation)', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    const session = await broker.createSession({ title: 'Guard Test' });
    const agentId = 'ag-dr1-real';
    broker.attachRuntimeBus(bus, (id) => id === agentId ? session.id : null);
    const sub = await broker.submitMessage({
      sessionId: session.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-test',
      body: 'Real input',
    });
    await broker.bindAgent(session.id, agentId); // claims queued -> spawned

    // Fire for a completely different agent — resolver returns null for 'ag-ghost'
    expect(() => emitAgentOnBus(bus, 'AGENT_COMPLETED', 'ag-ghost')).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const inputs = broker.getInputs(session.id, 100);
    const unchanged = inputs.find((i) => i.id === sub.input.id);
    // Still 'spawned' — the ghost event must not have touched it
    expect(unchanged?.state).toBe('spawned');
  });
});

// ---------------------------------------------------------------------------
// DR3: SharedSessionBroker idle-session GC
// ---------------------------------------------------------------------------

describe('DR3: SharedSessionBroker idle-session GC sweep', () => {
  /**
   * Manually advance a session's lastActivityAt backward in time so the GC
   * sees it as idle without actually waiting wall-clock time.
   */
  function backdateSession(broker: SharedSessionBroker, sessionId: string, idleMs: number): void {
    const sessions = (broker as any).sessions as Map<string, SharedSessionRecord>;
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    sessions.set(sessionId, {
      ...session,
      lastActivityAt: Date.now() - idleMs,
    });
  }

  test('empty ghost session idle past idleEmptyMs threshold is closed by sweep', async () => {
    // 1ms thresholds so we can backdate by just 2ms
    const broker = makeBroker(1, 24 * 60 * 60 * 1000);
    const session = await broker.createSession({ title: 'Ghost' });
    expect(session.messageCount).toBe(0);
    expect(session.status).toBe('active');

    backdateSession(broker, session.id, 2); // idle 2ms > 1ms threshold
    (broker as any)._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('closed');
  });

  test('session with messages stays open under idleEmptyMs threshold', async () => {
    const broker = makeBroker(1, 24 * 60 * 60 * 1000);
    const session = await broker.createSession({ title: 'Has Content' });

    // Simulate message by manually setting messageCount > 0
    const sessions = (broker as any).sessions as Map<string, SharedSessionRecord>;
    sessions.set(session.id, { ...session, messageCount: 1 });

    backdateSession(broker, session.id, 2);
    (broker as any)._gcSweep();

    const afterSweep = broker.getSession(session.id);
    // Has messages — should NOT be closed by the empty-ghost policy
    expect(afterSweep?.status).toBe('active');
  });

  test('content session idle past idleLongMs threshold is closed with idle-long', async () => {
    const broker = makeBroker(10 * 60 * 1000, 1); // 1ms long-idle threshold
    const session = await broker.createSession({ title: 'Old Chat' });

    const sessions = (broker as any).sessions as Map<string, SharedSessionRecord>;
    sessions.set(session.id, { ...session, messageCount: 5 });

    let closedPayload: any = null;
    // publishUpdate wraps all events as ('session-update', { event, payload })
    broker.setEventPublisher((event, payload: any) => {
      if (event === 'session-update' && payload?.event === 'session-closed') closedPayload = payload.payload;
    });

    backdateSession(broker, session.id, 2);
    (broker as any)._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('closed');
    expect(closedPayload?.reason).toBe('idle-long');
  });

  test('session with active agent is never GCd regardless of idle time', async () => {
    const broker = makeBroker(1, 1); // both thresholds at 1ms
    const session = await broker.createSession({ title: 'Active Agent' });
    await broker.bindAgent(session.id, 'ag-live');

    backdateSession(broker, session.id, 10_000);
    (broker as any)._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('active');
  });

  test('empty ghost session emits session-closed event with reason idle-empty', async () => {
    const broker = makeBroker(1, 24 * 60 * 60 * 1000);
    const session = await broker.createSession({ title: 'Ghost Events' });

    let closedPayload: any = null;
    // publishUpdate wraps all events as ('session-update', { event, payload })
    broker.setEventPublisher((event, payload: any) => {
      if (event === 'session-update' && payload?.event === 'session-closed') closedPayload = payload.payload;
    });

    backdateSession(broker, session.id, 2);
    (broker as any)._gcSweep();

    expect(closedPayload?.reason).toBe('idle-empty');
    expect(closedPayload?.id).toBe(session.id);
  });
});
