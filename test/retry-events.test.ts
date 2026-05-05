import { describe, expect, test } from 'bun:test';

/**
 * Retry/backoff/reconnect events — verifies that TRANSPORT_RETRY_SCHEDULED
 * and TRANSPORT_RETRY_EXECUTED event types exist in the TransportEvent union and
 * that the corresponding emitter functions are exported.
 */
describe('retry events', () => {

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

  // production wiring — createHttpJsonTransport fires callbacks in the retry loop.
  test('createHttpJsonTransport onRetryScheduled fires when retry loop triggers', async () => {
    const { createHttpJsonTransport } = await import('../packages/transport-http/src/http-core.js');
    const scheduledEvents: { attempt: number; maxAttempts: number; backoffMs: number; reason: string }[] = [];
    const executedEvents: { attempt: number; maxAttempts: number }[] = [];
    let callCount = 0;
    const transport = createHttpJsonTransport({
      baseUrl: 'https://example.com',
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      onRetryScheduled: (info) => { scheduledEvents.push(info); },
      onRetryExecuted: (info) => { executedEvents.push(info); },
    });
    await transport.requestJson('/api/test');
    expect(scheduledEvents.length).toBe(1);
    expect(scheduledEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 2, reason: 'http-503' });
    expect(executedEvents.length).toBe(1);
    expect(executedEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
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
