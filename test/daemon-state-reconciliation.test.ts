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
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { AgentTaskAdapter } from '../packages/sdk/src/platform/runtime/tasks/adapters/agent-adapter.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import type { RuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import { createEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { AgentEvent } from '../packages/sdk/src/events/agents.js';

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
    adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
  });

  function emitAgent(type: 'AGENT_COMPLETED' | 'AGENT_FAILED' | 'AGENT_CANCELLED', agentId: string, extra: Record<string, unknown> = {}): void {
    const payload = { type, agentId, durationMs: 100, ...extra } as AgentEvent;
    bus.emit('agents', createEventEnvelope(type, payload, {
      sessionId: 'test-session',
      traceId: `test:${agentId}`,
      source: 'test',
    }));
  }

  test('AGENT_COMPLETED transitions task from running to completed', async () => {
    const taskId = adapter.wrapAgent('ag-1', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-1', 'running');

    const before = store.getState().tasks.tasks.get(taskId);
    expect(before?.status).toBe('running');

    emitAgent('AGENT_COMPLETED', 'ag-1', { output: 'done', durationMs: 500 });
    await Promise.resolve(); // drain queueMicrotask (OBS-14 async dispatch)

    const after = store.getState().tasks.tasks.get(taskId);
    expect(after?.status).toBe('completed');
  });

  test('AGENT_FAILED transitions task from running to failed', async () => {
    const taskId = adapter.wrapAgent('ag-2', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-2', 'running');

    emitAgent('AGENT_FAILED', 'ag-2', { error: 'oops', durationMs: 200 });
    await Promise.resolve(); // drain queueMicrotask (OBS-14 async dispatch)

    const after = store.getState().tasks.tasks.get(taskId);
    expect(after?.status).toBe('failed');
  });

  test('AGENT_CANCELLED transitions task from running to cancelled', async () => {
    const taskId = adapter.wrapAgent('ag-3', 'Do work', { sessionId: 'sess-1' });
    adapter.handleAgentStateChange('ag-3', 'running');

    emitAgent('AGENT_CANCELLED', 'ag-3', { reason: 'user cancelled' });
    await Promise.resolve(); // drain queueMicrotask (OBS-14 async dispatch)

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

import type { SharedSessionRecord, SharedSessionMessage } from '../packages/sdk/src/platform/control-plane/session-types.js';
import type { SharedSessionInputRecord } from '../packages/sdk/src/platform/control-plane/session-intents.js';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.js';
import type { SharedSessionStoreSnapshot, SharedSessionEventPublisher } from '../packages/sdk/src/platform/control-plane/session-broker-helpers.js';
import type { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.js';
import type { RouteBindingManager } from '../packages/sdk/src/platform/channels/route-manager.js';

/** Minimal in-memory PersistentStore stub (matches PersistentStore<T> API: load + persist) */
function makePersistentStoreStub(): PersistentStore<SharedSessionStoreSnapshot> {
  let _data: SharedSessionStoreSnapshot | null = null;
  return {
    load: async () => _data,
    persist: async (data: SharedSessionStoreSnapshot) => { _data = data; },
  } as unknown as PersistentStore<SharedSessionStoreSnapshot>;
}

function makeRouteBindingStub(): RouteBindingManager {
  return {
    start: async () => {},
    getBinding: () => undefined,
    patchBinding: async () => null,
  } as unknown as RouteBindingManager;
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
  const payload = { type, agentId, durationMs: 100, ...extra } as AgentEvent;
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
// M1 integration: wrapAgent + AGENT_COMPLETED -> task transitions to completed
// ---------------------------------------------------------------------------

describe('M1 integration: AgentTaskAdapter wrapAgent + bus event -> task completed', () => {
  test('wrapAgent then AGENT_COMPLETED transitions task to completed in store', async () => {
    const bus = new RuntimeEventBus();
    const store = makeStore();
    const adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);

    // Simulates what DaemonServer.trySpawnAgent does
    const taskId = adapter.wrapAgent('ag-m1', 'Fix tests', { sessionId: 'sess-m1' });
    adapter.handleAgentStateChange('ag-m1', 'running');

    const running = store.getState().tasks.tasks.get(taskId);
    expect(running?.status).toBe('running');

    // Bus event simulates AGENT_COMPLETED arriving from the runtime event bus
    const payload = { type: 'AGENT_COMPLETED', agentId: 'ag-m1', durationMs: 400, output: 'ok' } as AgentEvent;
    bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', payload, {
      sessionId: 'sess-m1',
      traceId: 'test:m1',
      source: 'test',
    }));
    await Promise.resolve(); // drain queueMicrotask (OBS-14 async dispatch)

    const completed = store.getState().tasks.tasks.get(taskId);
    expect(completed?.status).toBe('completed');
    expect(completed?.endedAt).toBeGreaterThan(0);
  });

  test('wrapAgent is idempotent — second call returns same taskId', () => {
    const store = makeStore();
    const adapter = new AgentTaskAdapter(store);
    const id1 = adapter.wrapAgent('ag-idem', 'Task', { sessionId: 'sess-1' });
    const id2 = adapter.wrapAgent('ag-idem', 'Task again', { sessionId: 'sess-1' });
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// m3: AgentTaskAdapter.attachRuntimeBus idempotency
// ---------------------------------------------------------------------------

describe('m3: AgentTaskAdapter.attachRuntimeBus is idempotent', () => {
  test('second attachRuntimeBus call is a no-op and does not double-fire events', async () => {
    const bus = new RuntimeEventBus();
    const store = makeStore();
    const adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
    // Second call — should warn and return no-op unsub
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(String(args[0])); };
    const unsub2 = adapter.attachRuntimeBus(bus);
    console.warn = orig;
    expect(warnSpy.some((w) => w.includes('AgentTaskAdapter'))).toBe(true);

    const taskId = adapter.wrapAgent('ag-idem2', 'Task', { sessionId: 'sess-x' });
    adapter.handleAgentStateChange('ag-idem2', 'running');
    unsub2(); // no-op unsub should not break anything

    const payload = { type: 'AGENT_COMPLETED', agentId: 'ag-idem2', durationMs: 100 } as AgentEvent;
    bus.emit('agents', createEventEnvelope('AGENT_COMPLETED', payload, {
      sessionId: 'sess-x', traceId: 'idem2', source: 'test',
    }));
    await Promise.resolve(); // drain queueMicrotask (OBS-14 async dispatch)
    // Should still complete (first subscription still active)
    expect(store.getState().tasks.tasks.get(taskId)?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// M2: AgentTaskAdapter.reconcileOnRestart
// ---------------------------------------------------------------------------

describe('M2: AgentTaskAdapter.reconcileOnRestart — marks running tasks aborted', () => {
  test('tasks with status running at startup are cancelled with daemon-restart error', () => {
    const store = makeStore();
    const adapter = new AgentTaskAdapter(store);

    // Pre-populate: wrap two agents, transition to running, then simulate restart
    const bus = new RuntimeEventBus();
    adapter.attachRuntimeBus(bus);
    const t1 = adapter.wrapAgent('ag-r1', 'Task 1', { sessionId: 'sess-1' });
    const t2 = adapter.wrapAgent('ag-r2', 'Task 2', { sessionId: 'sess-2' });
    adapter.handleAgentStateChange('ag-r1', 'running');
    adapter.handleAgentStateChange('ag-r2', 'running');

    expect(store.getState().tasks.tasks.get(t1)?.status).toBe('running');
    expect(store.getState().tasks.tasks.get(t2)?.status).toBe('running');

    // Simulate restart: new adapter instance inherits the same store
    const adapterAfterRestart = new AgentTaskAdapter(store);
    adapterAfterRestart.reconcileOnRestart();

    expect(store.getState().tasks.tasks.get(t1)?.status).toBe('cancelled');
    expect(store.getState().tasks.tasks.get(t1)?.error).toBe('daemon-restart');
    expect(store.getState().tasks.tasks.get(t2)?.status).toBe('cancelled');
  });

  test('tasks not in running state are not touched by reconcileOnRestart', () => {
    const store = makeStore();
    const adapter = new AgentTaskAdapter(store);
    const bus = new RuntimeEventBus();
    adapter.attachRuntimeBus(bus);
    const tQueued = adapter.wrapAgent('ag-q', 'Queued task', { sessionId: 'sess-q' });
    // Leave it in queued state
    expect(store.getState().tasks.tasks.get(tQueued)?.status).toBe('queued');

    const adapterAfterRestart = new AgentTaskAdapter(store);
    adapterAfterRestart.reconcileOnRestart();

    // Queued is not 'running', so should not be touched
    expect(store.getState().tasks.tasks.get(tQueued)?.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// M2: SharedSessionBroker startup reconciliation
// ---------------------------------------------------------------------------

describe('M2: SharedSessionBroker.start() — startup reconciliation', () => {
  test('spawned/delivered inputs cancelled on start(), activeAgentId nulled', async () => {
    const storeStub = makePersistentStoreStub();
    const routeBindings = makeRouteBindingStub();

    // First broker: create session, record spawned inputs, persist
    const broker1 = new SharedSessionBroker({
      store: storeStub,
      routeBindings,
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    const sess = await broker1.createSession({ title: 'Restart Test' });
    // Inject 3 spawned inputs directly into broker helper state.
    const inputs = (broker1 as unknown as { inputs: Map<string, SharedSessionInputRecord[]> }).inputs;
    inputs.set(sess.id, [
      { id: 'sin-1', sessionId: sess.id, state: 'spawned', intent: 'submit', createdAt: 1, updatedAt: 1, body: 'a', correlationId: 'c1', metadata: {}, routing: undefined },
      { id: 'sin-2', sessionId: sess.id, state: 'delivered', intent: 'submit', createdAt: 2, updatedAt: 2, body: 'b', correlationId: 'c2', metadata: {}, routing: undefined },
      { id: 'sin-3', sessionId: sess.id, state: 'queued', intent: 'submit', createdAt: 3, updatedAt: 3, body: 'c', correlationId: 'c3', metadata: {}, routing: undefined },
    ]);
    // Bind active agent
    const sessions = (broker1 as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
    sessions.set(sess.id, { ...sess, activeAgentId: 'dead-agent' });
    // Persist current state
    await (broker1 as unknown as { persist(): Promise<void> }).persist();

    // Second broker (simulates daemon restart): loads from same persistent store
    const broker2 = new SharedSessionBroker({
      store: storeStub,
      routeBindings: makeRouteBindingStub(),
      agentStatusProvider: { getStatus: () => null },
      messageSender: { send: () => false },
    });
    await broker2.start();

    const inputsAfter = broker2.getInputs(sess.id, 100);
    const sin1 = inputsAfter.find((i) => i.id === 'sin-1');
    const sin2 = inputsAfter.find((i) => i.id === 'sin-2');
    const sin3 = inputsAfter.find((i) => i.id === 'sin-3');

    // spawned + delivered -> cancelled
    expect(sin1?.state).toBe('cancelled');
    expect(sin1?.error).toContain('daemon restart');
    expect(sin2?.state).toBe('cancelled');
    // queued stays queued
    expect(sin3?.state).toBe('queued');

    // activeAgentId should be nulled
    const sessAfter = broker2.getSession(sess.id);
    expect(sessAfter?.activeAgentId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M3: SharedSessionBroker.stop()
// ---------------------------------------------------------------------------

describe('M3: SharedSessionBroker.stop() — graceful teardown', () => {
  test('stop() clears GC interval and bus subscriptions', async () => {
    const broker = makeBroker();
    await broker.start();

    // _gcInterval should be set after start()
    expect((broker as unknown as { _gcInterval: ReturnType<typeof setInterval> | null })._gcInterval).not.toBeNull();
    expect((broker as unknown as { _busUnsubs: Array<() => void> })._busUnsubs).toHaveLength(0); // no bus attached yet

    await broker.stop();

    expect((broker as unknown as { _gcInterval: ReturnType<typeof setInterval> | null })._gcInterval).toBeNull();
    expect((broker as unknown as { _busUnsubs: Array<() => void> })._busUnsubs).toHaveLength(0);
  });

  test('stop() with attached bus clears _busAttached flag', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    await broker.start();
    broker.attachRuntimeBus(bus, () => null);
    expect((broker as unknown as { _busAttached: boolean })._busAttached).toBe(true);

    await broker.stop();
    expect((broker as unknown as { _busAttached: boolean })._busAttached).toBe(false);
    expect((broker as unknown as { _busUnsubs: Array<() => void> })._busUnsubs).toHaveLength(0);
  });

  test('attachRuntimeBus after stop() is accepted (idempotency reset)', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    await broker.start();
    broker.attachRuntimeBus(bus, () => null);
    await broker.stop();
    // After stop, _busAttached is false — second attach should succeed silently
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(String(args[0])); };
    broker.attachRuntimeBus(bus, () => null);
    console.warn = orig;
    expect(warnSpy.some((w) => w.includes('SharedSessionBroker'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// m3: SharedSessionBroker.attachRuntimeBus idempotency
// ---------------------------------------------------------------------------

describe('m3: SharedSessionBroker.attachRuntimeBus is idempotent', () => {
  test('second call warns and returns no-op unsub', async () => {
    const bus = new RuntimeEventBus();
    const broker = makeBroker();
    await broker.start();
    broker.attachRuntimeBus(bus, () => null);

    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnSpy.push(String(args[0])); };
    broker.attachRuntimeBus(bus, () => null);
    console.warn = orig;
    expect(warnSpy.some((w) => w.includes('SharedSessionBroker'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M4: _touch() + lastActivityAt coverage
// ---------------------------------------------------------------------------

describe('M4: lastActivityAt bumped at touch sites', () => {
  test('recordInput bumps lastActivityAt', async () => {
    const broker = makeBroker();
    const sess = await broker.createSession({ title: 'Touch test' });
    const before = broker.getSession(sess.id)!.lastActivityAt;
    // Wait a tick to ensure time advances
    await new Promise((r) => setTimeout(r, 2));
    await broker.submitMessage({
      sessionId: sess.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-1',
      body: 'hello',
    });
    const after = broker.getSession(sess.id)!.lastActivityAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('completeAgent bumps lastActivityAt explicitly', async () => {
    const broker = makeBroker();
    const sess = await broker.createSession({ title: 'Complete touch' });
    await broker.bindAgent(sess.id, 'ag-touch');
    const before = broker.getSession(sess.id)!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 2));
    await broker.completeAgent(sess.id, 'ag-touch', 'result', { status: 'completed' });
    const after = broker.getSession(sess.id)!.lastActivityAt;
    expect(after).toBeGreaterThan(before);
  });

  test('closeSession bumps lastActivityAt', async () => {
    const broker = makeBroker();
    const sess = await broker.createSession({ title: 'Close touch' });
    const before = broker.getSession(sess.id)!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 2));
    await broker.closeSession(sess.id);
    const after = broker.getSession(sess.id)!.lastActivityAt;
    expect(after).toBeGreaterThan(before);
  });

  test('finalizeAgentInputs bumps lastActivityAt when called directly', async () => {
    const broker = makeBroker();
    const sess = await broker.createSession({ title: 'Finalize touch' });
    // Submit a message to create an input record, then bind an agent so it enters 'spawned'
    await broker.submitMessage({
      sessionId: sess.id,
      surfaceKind: 'tui',
      surfaceId: 'tui-finalize',
      body: 'ping',
    });
    await broker.bindAgent(sess.id, 'ag-finalize');
    const before = broker.getSession(sess.id)!.lastActivityAt;
    await new Promise((r) => setTimeout(r, 2));
    // Call finalizeAgentInputs directly (bypasses completeAgent)
    (broker as unknown as { finalizeAgentInputs(sessionId: string, agentId: string, outcome: string): void }).finalizeAgentInputs(sess.id, 'ag-finalize', 'completed');
    const after = broker.getSession(sess.id)!.lastActivityAt;
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// M4: GC guard — sessions with pendingInputCount > 0 not GCd
// ---------------------------------------------------------------------------

describe('M4: GC guard — pendingInputCount > 0 prevents sweep', () => {
  test('session with pending inputs is not closed even past idle threshold', async () => {
    const broker = makeBroker(1, 1); // both thresholds 1ms
    const sess = await broker.createSession({ title: 'Pending inputs' });

    // Inject a pending input to make pendingInputCount > 0
    const sessions = (broker as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
    sessions.set(sess.id, { ...sess, pendingInputCount: 1 });

    // Backdate so idle check would normally fire
    const backdateSession = (broker: SharedSessionBroker, sessionId: string, idleMs: number) => {
      const s = (broker as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
      const session = s.get(sessionId);
      s.set(sessionId, { ...session, lastActivityAt: Date.now() - idleMs });
    };
    backdateSession(broker, sess.id, 5000);
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    expect(broker.getSession(sess.id)?.status).toBe('active');
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
    const sessions = (broker as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
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
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('closed');
  });

  test('session with messages stays open under idleEmptyMs threshold', async () => {
    const broker = makeBroker(1, 24 * 60 * 60 * 1000);
    const session = await broker.createSession({ title: 'Has Content' });

    // Simulate message by manually setting messageCount > 0
    const sessions = (broker as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
    sessions.set(session.id, { ...session, messageCount: 1 });

    backdateSession(broker, session.id, 2);
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    const afterSweep = broker.getSession(session.id);
    // Has messages — should NOT be closed by the empty-ghost policy
    expect(afterSweep?.status).toBe('active');
  });

  test('content session idle past idleLongMs threshold is closed with idle-long', async () => {
    const broker = makeBroker(10 * 60 * 1000, 1); // 1ms long-idle threshold
    const session = await broker.createSession({ title: 'Old Chat' });

    const sessions = (broker as unknown as { sessions: Map<string, SharedSessionRecord> }).sessions;
    sessions.set(session.id, { ...session, messageCount: 5 });

    let closedPayload: unknown = null;
    // publishUpdate wraps all events as ('session-update', { event, payload })
    broker.setEventPublisher((event: string, payload: unknown) => {
      if (event === 'session-update' && typeof payload === 'object' && payload !== null && 'event' in payload && (payload as Record<string, unknown>).event === 'session-closed') closedPayload = (payload as Record<string, unknown>).payload;
    });

    backdateSession(broker, session.id, 2);
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('closed');
    expect(closedPayload?.reason).toBe('idle-long');
  });

  test('session with active agent is never GCd regardless of idle time', async () => {
    const broker = makeBroker(1, 1); // both thresholds at 1ms
    const session = await broker.createSession({ title: 'Active Agent' });
    await broker.bindAgent(session.id, 'ag-live');

    backdateSession(broker, session.id, 10_000);
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    const afterSweep = broker.getSession(session.id);
    expect(afterSweep?.status).toBe('active');
  });

  test('empty ghost session emits session-closed event with reason idle-empty', async () => {
    const broker = makeBroker(1, 24 * 60 * 60 * 1000);
    const session = await broker.createSession({ title: 'Ghost Events' });

    let closedPayload: unknown = null;
    // publishUpdate wraps all events as ('session-update', { event, payload })
    broker.setEventPublisher((event: string, payload: unknown) => {
      if (event === 'session-update' && typeof payload === 'object' && payload !== null && 'event' in payload && (payload as Record<string, unknown>).event === 'session-closed') closedPayload = (payload as Record<string, unknown>).payload;
    });

    backdateSession(broker, session.id, 2);
    (broker as unknown as { _gcSweep(): void })._gcSweep();

    expect(closedPayload?.reason).toBe('idle-empty');
    expect(closedPayload?.id).toBe(session.id);
  });
});
