import { describe, expect, test } from 'bun:test';

/**
 * OBS-19: SSE subscriber lifecycle — verifies that STREAM_SUBSCRIBER_CONNECTED
 * and STREAM_SUBSCRIBER_DISCONNECTED events are emittable and structurally correct.
 */
describe('obs-19 sse lifecycle', () => {
  test('emitStreamSubscriberConnected is exported from transport emitters', async () => {
    const mod = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    expect(typeof mod.emitStreamSubscriberConnected).toBe('function');
  });

  test('emitStreamSubscriberDisconnected is exported from transport emitters', async () => {
    const mod = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    expect(typeof mod.emitStreamSubscriberDisconnected).toBe('function');
  });

  test('emitStreamSubscriberConnected emits correct payload', async () => {
    const { emitStreamSubscriberConnected } = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    const { EventEmitter } = await import('node:events');
    const bus = new EventEmitter() as Parameters<typeof emitStreamSubscriberConnected>[0];
    const events: unknown[] = [];
    bus.on('transport', (e: unknown) => events.push(e));
    emitStreamSubscriberConnected(bus, { source: 'test', traceId: 'trace-1' } as Parameters<typeof emitStreamSubscriberConnected>[1], {
      streamId: 'stream-abc',
      subscriberId: 'sub-001',
      streamType: 'events',
    });
    expect(events.length).toBe(1);
    const envelope = events[0] as { payload: { type: string; streamId: string; subscriberId: string } };
    expect(envelope.payload.type).toBe('STREAM_SUBSCRIBER_CONNECTED');
    expect(envelope.payload.streamId).toBe('stream-abc');
    expect(envelope.payload.subscriberId).toBe('sub-001');
  });

  test('emitStreamSubscriberDisconnected emits optional reason', async () => {
    const { emitStreamSubscriberDisconnected } = await import('../packages/sdk/src/platform/runtime/emitters/transport.js');
    const { EventEmitter } = await import('node:events');
    const bus = new EventEmitter() as Parameters<typeof emitStreamSubscriberDisconnected>[0];
    const events: unknown[] = [];
    bus.on('transport', (e: unknown) => events.push(e));
    emitStreamSubscriberDisconnected(bus, { source: 'test', traceId: 'trace-2' } as Parameters<typeof emitStreamSubscriberDisconnected>[1], {
      streamId: 'stream-abc',
      subscriberId: 'sub-001',
      streamType: 'events',
      reason: 'client closed',
    });
    const envelope = events[0] as { payload: { type: string; reason?: string } };
    expect(envelope.payload.type).toBe('STREAM_SUBSCRIBER_DISCONNECTED');
    expect(envelope.payload.reason).toBe('client closed');
  });

  test('sseSubscribers gauge can be set to track connected/disconnected', async () => {
    const { sseSubscribers } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    sseSubscribers.set(3);
    expect(sseSubscribers.value()).toBe(3);
    sseSubscribers.set(2);
    expect(sseSubscribers.value()).toBe(2);
  });
});
