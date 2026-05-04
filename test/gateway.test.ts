/**
 * gateway.test.ts
 *
 * Tests for the ControlPlaneGateway subsystem:
 *   - Construction: default state after instantiation
 *   - End-to-end emit: publishEvent / publishSurfaceMessage reach live clients
 *   - Invariants: recentEvents ring buffer capped at 500; recentMessages capped at 200
 */

import { describe, expect, test } from 'bun:test';
import {
  ControlPlaneGateway,
  DEFAULT_DOMAINS_TEST_EXPORT,
} from '../packages/sdk/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeGatewayWithBus(): { gateway: ControlPlaneGateway; bus: RuntimeEventBus } {
  const bus = new RuntimeEventBus();
  const gateway = new ControlPlaneGateway({ runtimeBus: bus });
  return { gateway, bus };
}

// ---------------------------------------------------------------------------
// describe: ControlPlaneGateway — construction
// ---------------------------------------------------------------------------
describe('ControlPlaneGateway — construction', () => {
  test('initializes with empty client list and zero totals', () => {
    const gateway = new ControlPlaneGateway();

    expect(gateway.listClients()).toEqual([]);
    expect(gateway.listSurfaceMessages()).toEqual([]);
    expect(gateway.listRecentEvents()).toEqual([]);

    const snap = gateway.getSnapshot() as {
      totals: {
        clients: number;
        activeClients: number;
        surfaceMessages: number;
        recentEvents: number;
        requests: number;
        errors: number;
      };
    };
    expect(snap.totals.clients).toBe(0);
    expect(snap.totals.activeClients).toBe(0);
    expect(snap.totals.surfaceMessages).toBe(0);
    expect(snap.totals.recentEvents).toBe(0);
    expect(snap.totals.requests).toBe(0);
    expect(snap.totals.errors).toBe(0);
  });

  test('DEFAULT_DOMAINS_TEST_EXPORT covers expected core domains', () => {
    const domains = DEFAULT_DOMAINS_TEST_EXPORT as readonly string[];
    expect(domains).toContain('session');
    expect(domains).toContain('turn');
    expect(domains).toContain('agents');
    expect(domains).toContain('control-plane');
    expect(domains).toContain('transport');
    // At least 10 domains configured by default
    expect(domains.length).toBeGreaterThanOrEqual(10);
  });

  test('accepts partial server config and merges with defaults', () => {
    const gateway = new ControlPlaneGateway({
      server: { port: 9999, enabled: true },
    });
    const snap = gateway.getSnapshot() as { server: { port: number; enabled: boolean; host: string } };
    expect(snap.server.port).toBe(9999);
    expect(snap.server.enabled).toBe(true);
    // default host must be preserved
    expect(snap.server.host).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// describe: ControlPlaneGateway — end-to-end emit
// ---------------------------------------------------------------------------
describe('ControlPlaneGateway — end-to-end emit', () => {
  test('publishEvent delivers to a registered WebSocket client', () => {
    const { gateway } = makeGatewayWithBus();

    const received: Array<{ event: string; payload: unknown; id?: string }> = [];
    const send = (event: string, payload: unknown, id?: string): void => {
      received.push({ event, payload, id });
    };

    const { clientId } = gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'test-tui' },
      send,
    );

    // Clear registration noise (ready + replay)
    received.length = 0;

    gateway.publishEvent('my-event', { value: 42 }, { clientId });

    const match = received.find((r) => r.event === 'my-event');
    expect(match).toBeDefined();
    expect((match!.payload as { value: number }).value).toBe(42);
    expect(match!.id).toMatch(/^evt-/);

    // Must also appear in listRecentEvents
    const recent = gateway.listRecentEvents();
    const recentMatch = recent.find((r) => r.event === 'my-event');
    expect(recentMatch).toBeDefined();
    expect((recentMatch!.payload as { value: number }).value).toBe(42);
  });

  test('publishSurfaceMessage delivers to a web client and stores the message', () => {
    const { gateway } = makeGatewayWithBus();

    const received: Array<{ event: string; payload: unknown }> = [];
    const send = (event: string, payload: unknown): void => {
      received.push({ event, payload });
    };

    // 'web' kind required for surface-message delivery (gateway filters by kind)
    gateway.openWebSocketClient({ clientKind: 'web', label: 'test-web' }, send);
    received.length = 0;

    const msg = gateway.publishSurfaceMessage({
      surface: 'web',
      title: 'Hello Surface',
      body: 'message body',
      level: 'info',
    });

    // Returned message must have an id and timestamp
    expect(msg.id).toMatch(/^cpmsg-/);
    expect(typeof msg.createdAt).toBe('number');
    expect(msg.title).toBe('Hello Surface');

    // Client send must have been invoked with 'surface-message'
    const surfaceMsg = received.find((r) => r.event === 'surface-message');
    expect(surfaceMsg).toBeDefined();
    expect((surfaceMsg!.payload as { title: string }).title).toBe('Hello Surface');

    // Message must be stored in listSurfaceMessages
    const stored = gateway.listSurfaceMessages();
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe(msg.id);
  });

  test('openWebSocketClient sends ready event and registers the client', () => {
    const { gateway } = makeGatewayWithBus();

    const events: string[] = [];
    const send = (event: string): void => { events.push(event); };

    const result = gateway.openWebSocketClient(
      { clientKind: 'daemon', label: 'daemon-1', sessionId: 'sess-abc' },
      send,
    );

    expect(result.clientId).not.toBe('');
    expect(result.domains).toBeInstanceOf(Array);
    expect(result.domains).toEqual(DEFAULT_DOMAINS_TEST_EXPORT);
    // 'ready' must be the first event sent
    expect(events[0]).toBe('ready');

    // Client must appear in listClients
    const clients = gateway.listClients();
    expect(clients.some((c) => c.id === result.clientId)).toBe(true);
  });

  test('closeWebSocketClient disconnects the client', () => {
    const { gateway } = makeGatewayWithBus();
    const { clientId } = gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'close-test' },
      () => {},
    );

    gateway.closeWebSocketClient(clientId, 'test-close');

    const snap = gateway.getSnapshot() as { totals: { activeClients: number } };
    expect(snap.totals.activeClients).toBe(0);
  });

  test('recordApiRequest increments request and error counters', () => {
    const gateway = new ControlPlaneGateway();

    gateway.recordApiRequest({ method: 'GET', path: '/api/status', status: 200 });
    gateway.recordApiRequest({ method: 'POST', path: '/api/action', status: 400, error: 'bad input' });

    const snap = gateway.getSnapshot() as { totals: { requests: number; errors: number } };
    expect(snap.totals.requests).toBe(2);
    expect(snap.totals.errors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// describe: ControlPlaneGateway — invariants
// ---------------------------------------------------------------------------
describe('ControlPlaneGateway — invariants', () => {
  test('recentEvents ring buffer never exceeds 500 entries', () => {
    const gateway = new ControlPlaneGateway();
    const CAPACITY = 500;
    const OVERFLOW = 520;

    for (let i = 0; i < OVERFLOW; i++) {
      gateway.publishEvent(`evt-${i}`, { seq: i });
    }

    const recent = gateway.listRecentEvents(OVERFLOW + 100);
    expect(recent.length).toBeLessThanOrEqual(CAPACITY);
    expect(recent.length).toBe(CAPACITY);
  });

  test('recentMessages array never exceeds 200 entries', () => {
    const gateway = new ControlPlaneGateway();
    const CAPACITY = 200;
    const OVERFLOW = 215;

    for (let i = 0; i < OVERFLOW; i++) {
      gateway.publishSurfaceMessage({
        surface: 'web',
        title: `msg-${i}`,
        body: 'body',
      });
    }

    const messages = gateway.listSurfaceMessages(OVERFLOW + 100);
    expect(messages.length).toBeLessThanOrEqual(CAPACITY);
    expect(messages.length).toBe(CAPACITY);
  });

  test('recentEvents are returned in newest-first order', () => {
    const gateway = new ControlPlaneGateway();

    gateway.publishEvent('first', { seq: 1 });
    gateway.publishEvent('second', { seq: 2 });
    gateway.publishEvent('third', { seq: 3 });

    const recent = gateway.listRecentEvents(3);
    expect(recent[0].event).toBe('third');
    expect(recent[1].event).toBe('second');
    expect(recent[2].event).toBe('first');
  });

  test('recentEvents wraps correctly after ring buffer overflow', () => {
    const gateway = new ControlPlaneGateway();
    const CAPACITY = 500;

    for (let i = 0; i < CAPACITY + 10; i++) {
      gateway.publishEvent('wrap-test', { seq: i });
    }

    const recent = gateway.listRecentEvents(CAPACITY);
    expect(recent.length).toBe(CAPACITY);
    // Most recent entry must have seq = CAPACITY + 9 (last written)
    const newest = recent[0].payload as { seq: number };
    expect(newest.seq).toBe(CAPACITY + 9);
  });

  test('publishEvent with clientId filter only delivers to the matching client', () => {
    const { gateway } = makeGatewayWithBus();

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const { clientId: idA } = gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'client-A' },
      (event) => { receivedA.push(event); },
    );
    gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'client-B' },
      (event) => { receivedB.push(event); },
    );

    // Reset capture buffers after registration noise
    receivedA.length = 0;
    receivedB.length = 0;

    gateway.publishEvent('targeted', { for: 'A' }, { clientId: idA });

    expect(receivedA).toContain('targeted');
    expect(receivedB).not.toContain('targeted');
  });

  test('filtered recent events are not replayed to other clients', () => {
    const { gateway } = makeGatewayWithBus();
    const receivedA: string[] = [];
    const { clientId: idA } = gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'client-A' },
      (event) => { receivedA.push(event); },
    );
    receivedA.length = 0;

    gateway.publishEvent('targeted-private', { for: 'A' }, { clientId: idA });

    const receivedB: string[] = [];
    gateway.openWebSocketClient(
      { clientKind: 'tui', label: 'client-B' },
      (event) => { receivedB.push(event); },
    );

    expect(receivedA).toContain('targeted-private');
    expect(receivedB).not.toContain('targeted-private');
    const publicRecent = gateway.listRecentEvents().find((event) => event.event === 'targeted-private');
    expect(publicRecent).toBeDefined();
    expect('replayScope' in (publicRecent as Record<string, unknown>)).toBe(false);
  });
});
