/**
 * obs-14-async-event-bus.test.ts
 *
 * OBS-14: RuntimeEventBus dispatch is asynchronous via queueMicrotask.
 * Verifies:
 * - A slow subscriber does not block the emitter (returns immediately).
 * - A throwing subscriber does not cascade to other subscribers.
 * - All subscribers eventually receive the event after microtask drain.
 */

import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '../packages/sdk/src/_internal/platform/runtime/events/index.ts';
import type { SessionEvent } from '../packages/sdk/src/_internal/platform/runtime/events/session.ts';

function makeEnvelope() {
  const payload = { type: 'SESSION_CREATED', sessionId: 'sess-obs-14' } as SessionEvent;
  return createEventEnvelope('SESSION_CREATED', payload, {
    sessionId: 'sess-obs-14',
    traceId: 'obs-14',
    source: 'test',
  });
}

describe('OBS-14: RuntimeEventBus async dispatch via queueMicrotask', () => {
  test('emit returns synchronously before subscriber fires', () => {
    const bus = new RuntimeEventBus();
    let fired = false;

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      fired = true;
    });

    bus.emit('session', makeEnvelope());

    // Synchronously after emit — handler has not fired yet (queued as microtask)
    expect(fired).toBe(false);
  });

  test('subscriber fires after awaiting Promise.resolve()', async () => {
    const bus = new RuntimeEventBus();
    let fired = false;

    bus.on<SessionEvent>('SESSION_CREATED', () => {
      fired = true;
    });

    bus.emit('session', makeEnvelope());
    await Promise.resolve(); // drain microtask queue

    expect(fired).toBe(true);
  });

  test('throwing subscriber does not prevent other subscribers from receiving the event', async () => {
    const bus = new RuntimeEventBus();
    const received: string[] = [];

    // First subscriber throws
    bus.on<SessionEvent>('SESSION_CREATED', () => {
      throw new Error('subscriber-crash');
    });

    // Second subscriber records receipt
    bus.on<SessionEvent>('SESSION_CREATED', () => {
      received.push('second');
    });

    // Third subscriber also records receipt
    bus.on<SessionEvent>('SESSION_CREATED', () => {
      received.push('third');
    });

    bus.emit('session', makeEnvelope());
    await Promise.resolve();
    // Give all microtasks a chance (each handler is its own microtask)
    await Promise.resolve();
    await Promise.resolve();

    // Both non-throwing subscribers should have received the event
    expect(received).toContain('second');
    expect(received).toContain('third');
  });

  test('domain subscriber receives event after microtask drain', async () => {
    const bus = new RuntimeEventBus();
    let domainFired = false;

    bus.onDomain('session', () => {
      domainFired = true;
    });

    bus.emit('session', makeEnvelope());
    await Promise.resolve();

    expect(domainFired).toBe(true);
  });

  test('multiple subscribers all fire after microtask drain', async () => {
    const bus = new RuntimeEventBus();
    const order: number[] = [];

    bus.on<SessionEvent>('SESSION_CREATED', () => order.push(1));
    bus.on<SessionEvent>('SESSION_CREATED', () => order.push(2));
    bus.on<SessionEvent>('SESSION_CREATED', () => order.push(3));

    bus.emit('session', makeEnvelope());
    // Three microtasks to drain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(order.sort()).toEqual([1, 2, 3]);
  });
});
