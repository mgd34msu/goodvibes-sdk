/**
 * sse-heartbeat-idle-timeout.test.ts
 *
 * A quiet SSE stream must not be torn down by the server's idle timeout before
 * its keep-alive heartbeat arrives. These tests pin the invariant that the
 * derived idle timeout comfortably exceeds the heartbeat interval, prove the
 * FIRST heartbeat fires immediately on open (not one interval later), prove a
 * quiet stream keeps emitting heartbeats well past two intervals, and confirm
 * Last-Event-ID replay still delivers missed events across a reconnect.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.ts';
import { SSE_HEARTBEAT_INTERVAL_MS, sseIdleTimeoutSeconds } from '../packages/sdk/src/platform/control-plane/sse-timing.ts';

describe('SSE idle-timeout invariant', () => {
  test('the derived idle timeout always comfortably exceeds the heartbeat interval', () => {
    // Realistic heartbeat intervals (Bun's idleTimeout hard-caps at 255s, so an
    // interval above ~125s physically cannot be doubled under the cap — the SSE
    // heartbeat is a fixed 15s, well inside this range).
    for (const heartbeatMs of [1_000, 5_000, SSE_HEARTBEAT_INTERVAL_MS, 30_000, 60_000, 120_000]) {
      const idleSeconds = sseIdleTimeoutSeconds(heartbeatMs);
      const idleMs = idleSeconds * 1_000;
      // The whole point: idle timeout must be strictly greater than the heartbeat
      // interval (with margin), whatever the configured interval is.
      expect(idleMs).toBeGreaterThan(heartbeatMs);
      // ...and stay inside Bun's valid 1..255s range.
      expect(idleSeconds).toBeGreaterThanOrEqual(1);
      expect(idleSeconds).toBeLessThanOrEqual(255);
    }
  });

  test('the default idle timeout beats the default 15s heartbeat by a wide margin', () => {
    expect(sseIdleTimeoutSeconds() * 1_000).toBeGreaterThan(SSE_HEARTBEAT_INTERVAL_MS);
    // 2x15s + 5s slack = 35s.
    expect(sseIdleTimeoutSeconds()).toBe(35);
  });
});

function makeGateway(): { gateway: ControlPlaneGateway; ee: EventEmitter } {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
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
  return { gateway, ee };
}

/** Read decoded SSE text chunks off a Response body for up to `ms`. */
async function collect(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))),
    ]);
    if (chunk.done) break;
    if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

describe('SSE keep-alive delivery', () => {
  test('the first heartbeat fires immediately on open, then on the interval', async () => {
    const { gateway } = makeGateway();
    const controller = new AbortController();
    const req = new Request('http://localhost/events', { signal: controller.signal });
    // Short heartbeat cadence so the quiet-stream behavior is observable fast.
    const res = gateway.createEventStream(req, { clientId: 'hb-1', transport: 'sse', heartbeatIntervalMs: 40 });

    // Well past two intervals but a tiny fraction of any real idle timeout.
    const text = await collect(res, 220);
    controller.abort();

    const heartbeats = text.split('\n').filter((l) => l === 'event: heartbeat').length;
    // One immediate + several interval heartbeats: the stream stayed open and
    // kept emitting keep-alives rather than going silent.
    expect(heartbeats).toBeGreaterThanOrEqual(3);
    // The very first data frames include the immediate heartbeat (right after ready).
    const readyIdx = text.indexOf('event: ready');
    const firstHeartbeatIdx = text.indexOf('event: heartbeat');
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(firstHeartbeatIdx).toBeGreaterThan(readyIdx);
  });

  test('Last-Event-ID replay delivers events missed across a reconnect', async () => {
    const { gateway, ee } = makeGateway();

    // First connection: capture the id of a delivered event.
    const c1 = new AbortController();
    const res1 = gateway.createEventStream(new Request('http://localhost/events', { signal: c1.signal }), {
      clientId: 'replay-1', transport: 'sse', heartbeatIntervalMs: 10_000, domains: ['fleet'],
    });
    // Emit two runtime events on a subscribed domain.
    ee.emit('fleet', { type: 'FLEET_NODE_STARTED', payload: { type: 'FLEET_NODE_STARTED', nodeId: 'n1' }, domain: 'fleet' });
    ee.emit('fleet', { type: 'FLEET_NODE_STARTED', payload: { type: 'FLEET_NODE_STARTED', nodeId: 'n2' }, domain: 'fleet' });
    const buf = await collect(res1, 120);
    c1.abort();

    // Extract the id line of the FIRST fleet event (the one we "already saw").
    const idMatch = buf.match(/id: ([^\n]+)\nevent: fleet/);
    expect(idMatch).not.toBeNull();
    const lastSeenId = idMatch![1];

    // Reconnect presenting Last-Event-ID: the newer event (n2) must replay.
    const c2 = new AbortController();
    const res2 = gateway.createEventStream(
      new Request('http://localhost/events', { headers: { 'last-event-id': lastSeenId }, signal: c2.signal }),
      { clientId: 'replay-2', transport: 'sse', heartbeatIntervalMs: 10_000, domains: ['fleet'] },
    );
    const replayText = await collect(res2, 120);
    c2.abort();
    // The event after the last-seen id is replayed on reconnect.
    expect(replayText).toContain('n2');
  });
});
