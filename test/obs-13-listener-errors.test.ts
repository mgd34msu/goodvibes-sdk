/**
 * obs-13-listener-errors.test.ts
 *
 * OBS-13: Listener error counter + OPS_LISTENER_MISBEHAVING dedup emission.
 * Verifies:
 * - Throwing listener increments listener_errors_total counter.
 * - Throwing listener emits OPS_LISTENER_MISBEHAVING OpsEvent on first error.
 * - Same listener throwing multiple times: counter increments each time,
 *   but OPS_LISTENER_MISBEHAVING is emitted only once (dedup-gated).
 * - Non-throwing listener: no counter increment, no OpsEvent emitted.
 */

import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.ts';
import type { SessionEvent } from '../packages/sdk/src/events/session.js';
import type { OpsEvent } from '../packages/sdk/src/events/ops.js';
import type { RuntimeEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.ts';

function makeSessionEnvelope() {
  const payload = { type: 'SESSION_CREATED', sessionId: 'sess-obs-13' } as SessionEvent;
  return createEventEnvelope('SESSION_CREATED', payload, {
    sessionId: 'sess-obs-13',
    traceId: 'obs-13',
    source: 'test',
  });
}

/** Drain N microtask ticks. */
async function drainMicrotasks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('OBS-13: listener_errors_total counter', () => {
  test('throwing listener increments listener_errors_total', async () => {
    const { listenerErrorsTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const bus = new RuntimeEventBus();

    const before = listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' });

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('obs-13-crash');
    });

    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks();

    expect(listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' })).toBe(before + 1);
  });

  test('non-throwing listener does not increment listener_errors_total', async () => {
    const { listenerErrorsTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const bus = new RuntimeEventBus();

    const before = listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' });

    bus.on<SessionEvent>('SESSION_CREATED', () => { /* no-op */ });

    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks();

    expect(listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' })).toBe(before);
  });

  test('counter increments once per throw, even for same listener throwing multiple times', async () => {
    const { listenerErrorsTotal } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const bus = new RuntimeEventBus();

    const before = listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' });

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('obs-13-repeated');
    });

    // Emit three times — each emit triggers one catch, so counter should go up by 3.
    bus.emit('session', makeSessionEnvelope());
    bus.emit('session', makeSessionEnvelope());
    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks(10);

    expect(listenerErrorsTotal.value({ event_type: 'SESSION_CREATED' })).toBe(before + 3);
  });
});

describe('OBS-13: OPS_LISTENER_MISBEHAVING OpsEvent emission', () => {
  test('throwing listener causes OPS_LISTENER_MISBEHAVING to be emitted', async () => {
    const bus = new RuntimeEventBus();
    const opsEvents: RuntimeEventEnvelope<'OPS_LISTENER_MISBEHAVING', OpsEvent>[] = [];

    bus.on<OpsEvent>(
      'OPS_LISTENER_MISBEHAVING',
      (env) => { opsEvents.push(env as RuntimeEventEnvelope<'OPS_LISTENER_MISBEHAVING', OpsEvent>); }
    );

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('misbehave-first');
    });

    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks(8);

    expect(opsEvents.length).toBe(1);
    expect(opsEvents[0]!.payload.type).toBe('OPS_LISTENER_MISBEHAVING');
    const payload = opsEvents[0]!.payload as Extract<OpsEvent, { type: 'OPS_LISTENER_MISBEHAVING' }>;
    expect(payload.eventType).toBe('SESSION_CREATED');
    expect(payload.errorMessage).toBe('misbehave-first');
    expect(payload.errorCount).toBe(1);
  });

  test('same listener throwing multiple times emits OPS_LISTENER_MISBEHAVING only once (dedup)', async () => {
    const bus = new RuntimeEventBus();
    const opsEvents: RuntimeEventEnvelope<'OPS_LISTENER_MISBEHAVING', OpsEvent>[] = [];

    bus.on<OpsEvent>(
      'OPS_LISTENER_MISBEHAVING',
      (env) => { opsEvents.push(env as RuntimeEventEnvelope<'OPS_LISTENER_MISBEHAVING', OpsEvent>); }
    );

    // Register one listener that will always throw.
    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('misbehave-repeat');
    });

    // Emit 5 times from the same listener — dedup should suppress after the first.
    for (let i = 0; i < 5; i++) {
      bus.emit('session', makeSessionEnvelope());
    }
    await drainMicrotasks(20);

    // Only one OPS_LISTENER_MISBEHAVING should have been emitted (first-occurrence dedup).
    expect(opsEvents.length).toBe(1);
  });

  test('non-throwing listener does not emit OPS_LISTENER_MISBEHAVING', async () => {
    const bus = new RuntimeEventBus();
    const opsEvents: unknown[] = [];

    bus.on<OpsEvent>('OPS_LISTENER_MISBEHAVING', (env) => { opsEvents.push(env); });

    bus.on<SessionEvent>('SESSION_CREATED', () => { /* well-behaved */ });

    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks(5);

    expect(opsEvents.length).toBe(0);
  });

  test('OPS_LISTENER_MISBEHAVING is also observable via onDomain(ops)', async () => {
    const bus = new RuntimeEventBus();
    const domainEvents: unknown[] = [];

    bus.onDomain('ops', (env) => { domainEvents.push(env); });

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('domain-obs-check');
    });

    bus.emit('session', makeSessionEnvelope());
    await drainMicrotasks(8);

    expect(domainEvents.length).toBeGreaterThanOrEqual(1);
    const found = (domainEvents as Array<{ payload: { type: string } }>).some(
      (e) => e.payload.type === 'OPS_LISTENER_MISBEHAVING'
    );
    expect(found).toBe(true);
  });
});
