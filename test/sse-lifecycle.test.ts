import { describe, expect, test } from 'bun:test';

/**
 * SSE subscriber lifecycle — verifies that STREAM_SUBSCRIBER_CONNECTED
 * and STREAM_SUBSCRIBER_DISCONNECTED events are emittable and structurally correct.
 */
describe('sse lifecycle', () => {

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

  // production wiring — ControlPlaneGateway.createEventStream fires connected/disconnected.
  test('createEventStream emits STREAM_SUBSCRIBER_CONNECTED on connect and DISCONNECTED on abort', async () => {
    const { EventEmitter } = await import('node:events');
    const { ControlPlaneGateway } = await import('../packages/sdk/src/platform/control-plane/gateway.js');

    // Build a minimal EventEmitter bus that satisfies RuntimeEventBus duck-typing.
    const ee = new EventEmitter();
    const bus = Object.assign(ee, {
      emit: ee.emit.bind(ee),
      onDomain: (domain: string, handler: (e: unknown) => void) => {
        ee.on(domain, handler);
        return () => ee.removeListener(domain, handler);
      },
    }) as unknown as Parameters<InstanceType<typeof ControlPlaneGateway>['attachRuntime']>[0]['runtimeBus'];

    const gateway = new ControlPlaneGateway({
      runtimeBus: bus as NonNullable<typeof bus>,
      featureFlags: { isEnabled: () => true } as unknown as Parameters<typeof ControlPlaneGateway>[0]['featureFlags'],
    });

    const transportEvents: { type: string }[] = [];
    ee.on('transport', (envelope: { payload: { type: string } }) => {
      transportEvents.push({ type: envelope.payload.type });
    });

    const controller = new AbortController();
    const req = new Request('http://localhost/events', { signal: controller.signal });
    gateway.createEventStream(req, { clientId: 'test-sse-001', transport: 'sse' });

    // Allow microtasks to flush (ReadableStream start callback is sync, but give it a tick)
    await new Promise<void>((r) => setTimeout(r, 0));

    const connected = transportEvents.find((e) => e.type === 'STREAM_SUBSCRIBER_CONNECTED');
    expect(connected).toBeDefined();
    expect(connected!.type).toBe('STREAM_SUBSCRIBER_CONNECTED');

    // Abort signal triggers teardown
    controller.abort();
    await new Promise<void>((r) => setTimeout(r, 0));

    const disconnected = transportEvents.find((e) => e.type === 'STREAM_SUBSCRIBER_DISCONNECTED');
    expect(disconnected).toBeDefined();
    expect(disconnected!.type).toBe('STREAM_SUBSCRIBER_DISCONNECTED');
  });

  test('sseSubscribers gauge supports set/get', async () => {
    const { sseSubscribers } = await import('../packages/sdk/src/platform/runtime/metrics.js');
    const before = sseSubscribers.value();
    sseSubscribers.set(3);
    expect(sseSubscribers.value()).toBe(3);
    sseSubscribers.set(2);
    expect(sseSubscribers.value()).toBe(2);
    sseSubscribers.set(before); // restore to avoid polluting subsequent tests
  });
});
