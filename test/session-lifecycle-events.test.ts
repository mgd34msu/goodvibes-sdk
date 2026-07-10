/**
 * session-lifecycle-events.test.ts
 *
 * The SharedSessionBroker collapses every lifecycle signal onto a single `session-update`
 * wire event whose real name lives in `payload.event`. Before this item that channel was
 * UNDECLARED in the contract (advertisement ≠ reality). These tests prove:
 *   - the contract now declares `control.session_update` (wireEvents:['session-update'],
 *     discriminated `event` enum)
 *   - an authenticated SSE client sees each lifecycle event end-to-end via the REAL broker
 *     → gateway.publishEvent → live client path
 *   - the un-domained broadcast reaches a client subscribed to ZERO domains (pins the
 *     webui's subscription assumption)
 *   - with the gateway flag OFF the broadcast is DROPPED, not buffered (no phantom)
 *   - the intent→event mapping is contract-aligned so a broker rename fails loudly
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { SharedSessionBroker } from '../packages/sdk/src/platform/control-plane/session-broker.js';
import { PersistentStore } from '../packages/sdk/src/platform/state/persistent-store.js';
import { RouteBindingManager } from '../packages/sdk/src/platform/channels/index.js';
import { buildOperatorContract } from '../packages/sdk/src/platform/control-plane/operator-contract.js';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.js';
import {
  SESSION_UPDATE_WIRE_EVENTS,
  SESSION_UPDATE_INTENT_MAP,
} from '../packages/sdk/src/platform/control-plane/method-catalog-events.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeBroker(): SharedSessionBroker {
  const store = new PersistentStore<never>(':memory:' as string);
  const routeBindings = {
    start: async () => {},
    stop: async () => {},
    list: () => [],
    find: () => null,
    bind: async () => ({}),
    unbind: async () => {},
    patch: async () => null,
    patchBinding: async () => null,
    getBinding: () => null,
  } as unknown as RouteBindingManager;
  return new SharedSessionBroker({
    store,
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: async () => {} },
  } as unknown as ConstructorParameters<typeof SharedSessionBroker>[0]);
}

function makeGateway(enabled = true): ControlPlaneGateway {
  const bus = new RuntimeEventBus();
  const featureFlags = createFeatureFlagManager();
  if (!enabled) featureFlags.loadFromConfig({ flags: { 'control-plane-gateway': 'disabled' } });
  return new ControlPlaneGateway({ runtimeBus: bus, featureFlags });
}

interface ParsedFrame { readonly event: string; readonly data: unknown }

/**
 * Reads SSE frames off a live gateway stream until `predicate` matches or the deadline
 * passes. Returns the matching frame or null.
 */
async function readUntil(
  res: Response,
  predicate: (frame: ParsedFrame) => boolean,
  timeoutMs = 2000,
): Promise<ParsedFrame | null> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        const frame: ParsedFrame = { event, data: data ? JSON.parse(data) : undefined };
        if (predicate(frame)) return frame;
      }
    }
    return null;
  } finally {
    reader.releaseLock();
    await res.body?.cancel().catch(() => {});
  }
}

const isSessionUpdate = (lifecycle: string) => (frame: ParsedFrame): boolean =>
  frame.event === 'session-update'
  && typeof frame.data === 'object'
  && frame.data !== null
  && (frame.data as { event?: string }).event === lifecycle;

// ---------------------------------------------------------------------------
// Contract declaration
// ---------------------------------------------------------------------------

describe('S2c — the session-update channel is contract-declared', () => {
  test('control.session_update is present with wireEvents and a discriminated event enum', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const descriptor = contract.operator.events.find((e) => e.id === 'control.session_update');
    expect(descriptor).toBeDefined();
    expect(descriptor!.wireEvents).toEqual(['session-update']);
    expect(descriptor!.transport).toContain('sse');
    const schema = descriptor!.outputSchema as { properties: { event: { enum: string[] } } };
    expect(schema.properties.event.enum).toContain('session-created');
    expect(schema.properties.event.enum).toContain('session-closed');
    expect(schema.properties.event.enum).toEqual([...SESSION_UPDATE_WIRE_EVENTS]);
  });
});

// ---------------------------------------------------------------------------
// S2c re-point — session mutators reference the session_update descriptor
//
// S2 deferred wiring the sessions.* methods' `events:[...]` to control.session_update
// (the descriptor lives in method-catalog-events.ts, the sessions catalog in the
// S1-owned method-catalog-control-core.ts). Post-merge that re-point is in place:
// every write:sessions method that drives a broker `session-update` broadcast now
// advertises the channel it produces, and every advertised event id resolves.
// ---------------------------------------------------------------------------

describe('S2c re-point — session mutators advertise control.session_update', () => {
  test('every method.events id resolves to a declared event descriptor (referential integrity)', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const declared = new Set(contract.operator.events.map((e) => e.id));
    const dangling: Array<{ method: string; event: string }> = [];
    for (const method of contract.operator.methods) {
      for (const eventId of method.events ?? []) {
        if (!declared.has(eventId)) dangling.push({ method: method.id, event: eventId });
      }
    }
    expect(dangling).toEqual([]);
  });

  test('every ACTUAL broker emit site is a declared wire discriminant (source introspection)', () => {
    // Introspect the real emit sites in the broker source rather than trusting a
    // hand-kept list: extract every publishUpdate(...) / publishInputLifecycleEvent(...)
    // event name, expand the dynamic `session-input-${state}` site over the
    // finalizeable input states, and assert each is declared in the enum. A future
    // emit of an undeclared name (e.g. a new session-input-<state>) fails here.
    const brokerSrc = readFileSync(
      new URL('../packages/sdk/src/platform/control-plane/session-broker.ts', import.meta.url),
      'utf-8',
    );
    const declared = new Set<string>(SESSION_UPDATE_WIRE_EVENTS);
    // finalizeAgentInputs can only transition to these states (see its signature).
    const finalizeStates = ['completed', 'failed', 'cancelled'];
    const emitted = new Set<string>();
    const literalRe = /publish(?:Update|InputLifecycleEvent)\(\s*[`'"]([^`'"]+)[`'"]/g;
    for (const match of brokerSrc.matchAll(literalRe)) {
      const raw = match[1]!;
      if (raw.includes('${')) {
        // Dynamic `session-input-${finalized.state}` → expand over finalize states.
        const prefix = raw.slice(0, raw.indexOf('${'));
        for (const state of finalizeStates) emitted.add(`${prefix}${state}`);
      } else {
        emitted.add(raw);
      }
    }
    // Sanity: we actually found the discriminated emit names.
    expect(emitted.has('session-created')).toBe(true);
    expect(emitted.has('session-input-completed')).toBe(true);
    expect(emitted.has('session-input-failed')).toBe(true);

    const undeclared = [...emitted].filter((event) => !declared.has(event));
    expect(undeclared).toEqual([]);
  });

  test('every write:sessions method advertises the broadcast channel it drives', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const writeSessionMethods = contract.operator.methods.filter(
      (m) => m.id.startsWith('sessions.') && (m.scopes ?? []).includes('write:sessions'),
    );
    // Sanity: the merge really did fold in the write-side session surface (create,
    // register, close, reopen, messages.create, steer, followUp, inputs.cancel).
    expect(writeSessionMethods.length).toBeGreaterThanOrEqual(8);
    // Every write:sessions method must advertise at least one event channel — a
    // session mutator that broadcasts nothing is the silent-drift defect this gate
    // exists to catch.
    const advertisesNothing = writeSessionMethods
      .filter((m) => (m.events ?? []).length === 0)
      .map((m) => m.id);
    expect(advertisesNothing).toEqual([]);
    // The session-LIFECYCLE mutators drive the broker `session-update` broadcast and
    // must advertise control.session_update. sessions.permissionMode.set is the one
    // write:sessions mutator that drives a DIFFERENT channel: a permission-mode change
    // flows through the runtime.permissions domain (PERMISSION_MODE_CHANGED via the
    // config-change binding — see permissions/mode-change-emitter.ts), NOT a
    // session-update broadcast, so it honestly advertises that channel instead.
    // Forcing it to claim control.session_update would be the over-claim the read-only
    // test just below guards against.
    const RUNTIME_CHANNEL_MUTATORS: Readonly<Record<string, string>> = {
      'sessions.permissionMode.set': 'runtime.permissions',
    };
    const missing = writeSessionMethods
      .filter((m) => !(m.id in RUNTIME_CHANNEL_MUTATORS))
      .filter((m) => !(m.events ?? []).includes('control.session_update'))
      .map((m) => m.id);
    expect(missing).toEqual([]);
    // Each runtime-channel mutator advertises its real channel (referential
    // integrity for the id is already enforced above), never session_update.
    for (const [methodId, channel] of Object.entries(RUNTIME_CHANNEL_MUTATORS)) {
      const method = writeSessionMethods.find((m) => m.id === methodId);
      expect(method).toBeDefined();
      expect(method!.events ?? []).toContain(channel);
      expect(method!.events ?? []).not.toContain('control.session_update');
    }
  });

  test('read-only session methods do NOT over-claim the mutation channel', () => {
    const contract = buildOperatorContract(new GatewayMethodCatalog());
    const readClaimingUpdate = contract.operator.methods
      .filter((m) => m.id.startsWith('sessions.') && (m.scopes ?? []).includes('read:sessions'))
      .filter((m) => (m.events ?? []).includes('control.session_update'))
      .map((m) => m.id);
    expect(readClaimingUpdate).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end broadcast through the real broker
// ---------------------------------------------------------------------------

describe('S2c — SSE client sees each lifecycle event end-to-end', () => {
  test('created + closed reach an authenticated SSE client via the real broker', async () => {
    const gateway = makeGateway(true);
    const broker = makeBroker();
    broker.setEventPublisher((event, payload) => gateway.publishEvent(event, payload));

    // Subscribe on the default domains (matches production createControlPlaneEventStream).
    const stream = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      principalId: 'shared-token',
      scopes: ['read:sessions'],
    });
    expect(stream.status).toBe(200);

    const createdPromise = readUntil(stream, isSessionUpdate('session-created'));
    await broker.createSession({ id: 'lifecycle-session' });
    const created = await createdPromise;
    expect(created).not.toBeNull();
    expect((created!.data as { payload: { id: string } }).payload.id).toBe('lifecycle-session');

    // Reopen the same stream for the close event (previous read cancelled the body).
    const closeStream = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      principalId: 'shared-token',
      scopes: ['read:sessions'],
    });
    const closedPromise = readUntil(closeStream, isSessionUpdate('session-closed'));
    await broker.closeSession('lifecycle-session');
    const closed = await closedPromise;
    expect(closed).not.toBeNull();
    expect((closed!.data as { payload: { id: string } }).payload.id).toBe('lifecycle-session');
  });

  test('deleteSession fires session-deleted on the same channel', async () => {
    const gateway = makeGateway(true);
    const broker = makeBroker();
    broker.setEventPublisher((event, payload) => gateway.publishEvent(event, payload));

    await broker.createSession({ id: 'lifecycle-delete-session' });
    await broker.closeSession('lifecycle-delete-session');

    const stream = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      principalId: 'shared-token',
      scopes: ['read:sessions'],
    });
    const deletedPromise = readUntil(stream, isSessionUpdate('session-deleted'));
    const result = await broker.deleteSession('lifecycle-delete-session');
    expect(result).toBe('deleted');
    const deleted = await deletedPromise;
    expect(deleted).not.toBeNull();
    expect((deleted!.data as { payload: { sessionId: string } }).payload.sessionId).toBe('lifecycle-delete-session');
  });

  test('a steer-class frame (session-input-delivered) carries on the same channel', async () => {
    // Driving the full steer state machine needs an active agent; here we assert the wire
    // channel carries the steered discriminant that SESSION_UPDATE_INTENT_MAP.steered names,
    // proving a subscriber can switch on payload.event for steer invalidation.
    const gateway = makeGateway(true);
    const stream = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      principalId: 'shared-token',
      scopes: ['read:sessions'],
    });
    const framePromise = readUntil(stream, isSessionUpdate('session-input-delivered'));
    gateway.publishEvent('session-update', {
      event: 'session-input-delivered',
      payload: { sessionId: 'lifecycle-session', inputId: 'in-1' },
      createdAt: Date.now(),
    });
    const frame = await framePromise;
    expect(frame).not.toBeNull();
    expect(SESSION_UPDATE_INTENT_MAP.steered).toContain('session-input-delivered');
  });
});

// ---------------------------------------------------------------------------
// Un-domained broadcast + honest drop when OFF
// ---------------------------------------------------------------------------

describe('S2c — broadcast reach and honest failure modes', () => {
  test('a client subscribed to ZERO domains still receives session-update', async () => {
    const gateway = makeGateway(true);
    const stream = gateway.createEventStream(new Request('http://localhost/stream'), {
      clientKind: 'web',
      domains: [], // subscribe to nothing
      principalId: 'shared-token',
      scopes: ['read:sessions'],
    });
    const framePromise = readUntil(stream, isSessionUpdate('session-created'));
    gateway.publishEvent('session-update', {
      event: 'session-created',
      payload: { id: 's1' },
      createdAt: Date.now(),
    });
    expect(await framePromise).not.toBeNull();
  });

  test('with the flag OFF publishEvent drops the broadcast (no phantom buffering)', () => {
    const gateway = makeGateway(false);
    expect(() => gateway.publishEvent('session-update', { event: 'session-created', payload: { id: 's1' }, createdAt: Date.now() })).not.toThrow();
    expect(gateway.listRecentEvents()).toEqual([]);
    const snapshot = gateway.getSnapshot() as { disabled?: boolean };
    expect(snapshot.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mapping guard — a broker rename must fail loudly
// ---------------------------------------------------------------------------

describe('S2c — intent→event mapping stays contract-aligned', () => {
  test('every mapped invalidation event is a declared wire discriminant', () => {
    for (const [intent, events] of Object.entries(SESSION_UPDATE_INTENT_MAP)) {
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(SESSION_UPDATE_WIRE_EVENTS).toContain(event);
      }
    }
  });

  test('created/updated/steered/closed/deleted intents are all covered', () => {
    expect(Object.keys(SESSION_UPDATE_INTENT_MAP).sort()).toEqual(['closed', 'created', 'deleted', 'steered', 'updated']);
  });
});
