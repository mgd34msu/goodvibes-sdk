import { describe, expect, test } from 'bun:test';

/**
 * OBS-18: Retry/backoff/reconnect events — verifies that TRANSPORT_RETRY_SCHEDULED
 * and TRANSPORT_RETRY_EXECUTED event types exist in the TransportEvent union and
 * that the corresponding emitter functions are exported.
 */
describe('obs-18 retry events', () => {
  test('TRANSPORT_RETRY_SCHEDULED is a valid TransportEvent type', async () => {
    // TypeScript validates the discriminated union at compile time.
    // At runtime we verify the emitter functions are exported.
    const mod = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    expect(typeof mod.emitTransportRetryScheduled).toBe('function');
  });

  test('TRANSPORT_RETRY_EXECUTED emitter is exported', async () => {
    const { emitTransportRetryExecuted } = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    expect(typeof emitTransportRetryExecuted).toBe('function');
  });

  test('emitTransportRetryScheduled emits on the transport channel', async () => {
    const { emitTransportRetryScheduled } = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    const { EventEmitter } = await import('node:events');
    const bus = new EventEmitter() as Parameters<typeof emitTransportRetryScheduled>[0];
    const events: unknown[] = [];
    bus.on('transport', (e: unknown) => events.push(e));
    emitTransportRetryScheduled(bus, { source: 'test', traceId: 'trace-1' } as Parameters<typeof emitTransportRetryScheduled>[1], {
      transportId: 'tcp-1',
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 1000,
      reason: 'connection refused',
    });
    expect(events.length).toBe(1);
    const envelope = events[0] as { payload: { type: string; backoffMs: number } };
    expect(envelope.payload.type).toBe('TRANSPORT_RETRY_SCHEDULED');
    expect(envelope.payload.backoffMs).toBe(1000);
  });

  test('emitTransportRetryExecuted emits on the transport channel', async () => {
    const { emitTransportRetryExecuted } = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    const { EventEmitter } = await import('node:events');
    const bus = new EventEmitter() as Parameters<typeof emitTransportRetryExecuted>[0];
    const events: unknown[] = [];
    bus.on('transport', (e: unknown) => events.push(e));
    emitTransportRetryExecuted(bus, { source: 'test', traceId: 'trace-1' } as Parameters<typeof emitTransportRetryExecuted>[1], {
      transportId: 'tcp-1',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(events.length).toBe(1);
    const envelope = events[0] as { payload: { type: string; attempt: number } };
    expect(envelope.payload.type).toBe('TRANSPORT_RETRY_EXECUTED');
    expect(envelope.payload.attempt).toBe(2);
  });
});
