/**
 * Test: Realtime transport subscribe + receive in a real browser V8 context.
 *
 * Uses MSW to intercept SSE (Server-Sent Events) requests and a deterministic
 * in-browser WebSocket stub to simulate real-time message delivery.
 *
 * Verifies:
 * 1. sdk.realtime.viaSse() returns a DomainEvents object with domain feeds.
 * 2. forSession(events, sessionId) returns a session-scoped DomainEvents view.
 * 3. SSE domain feed receives events delivered by MSW stream handler.
 * 4. WebSocket connector creates a connection and receives messages.
 *
 * Routes verified against runtime-events.ts:
 *   SSE: GET /api/control-plane/events?domains={domain}
 *   WS:  ws://host/api/control-plane/ws?clientKind=web&domains={domain}
 *
 * forSession() signature verified against domain-events.ts:
 *   forSession(events: DomainEvents, sessionId: string): DomainEvents
 *   First arg is a DomainEvents instance from sdk.realtime.viaSse() or viaWebSocket(),
 *   NOT the SDK object itself.
 *
 * WS connector message format verified against createWebSocketConnector in runtime-events.ts:
 *   { type: 'event', event: <domain>, payload: SerializedRuntimeEnvelope }
 */
import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { worker } from './setup.js';
import { createBrowserGoodVibesSdk, forSession } from '@pellux/goodvibes-sdk/browser';

const BASE_URL = 'http://localhost:4000';
const SESSION_ID = 'sess-browser-001';

function makeSdk() {
  return createBrowserGoodVibesSdk({ baseUrl: BASE_URL });
}

// ---------------------------------------------------------------------------
// Minimal deterministic WebSocket stub for browser context.
// ---------------------------------------------------------------------------
interface MockWebSocketHandle {
  simulateOpen(): void;
  simulateMessage(data: string): void;
  simulateClose(): void;
  sentMessages: string[];
}

function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket;
  instances: MockWebSocketHandle[];
} {
  const instances: MockWebSocketHandle[] = [];

  class MockWebSocket extends EventTarget {
    readonly sentMessages: string[] = [];
    readonly url: string;
    readyState: number = 0; // CONNECTING
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    constructor(url: string) {
      super();
      this.url = url;
      const handle: MockWebSocketHandle = {
        simulateOpen: () => {
          (this as unknown as { readyState: number }).readyState = 1;
          this.dispatchEvent(new Event('open'));
        },
        simulateMessage: (data: string) => {
          this.dispatchEvent(new MessageEvent('message', { data }));
        },
        simulateClose: () => {
          (this as unknown as { readyState: number }).readyState = 3;
          this.dispatchEvent(new CloseEvent('close', { code: 1000, wasClean: true }));
        },
        sentMessages: this.sentMessages,
      };
      instances.push(handle);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      (this as unknown as { readyState: number }).readyState = 3;
      this.dispatchEvent(new CloseEvent('close', { code: 1000, wasClean: true }));
    }

    // Property-style event handler adapters.
    set onmessage(handler: ((event: MessageEvent) => void) | null) {
      if (handler) this.addEventListener('message', handler as EventListener);
    }
    get onmessage(): ((event: MessageEvent) => void) | null { return null; }
    set onopen(handler: ((event: Event) => void) | null) {
      if (handler) this.addEventListener('open', handler as EventListener);
    }
    get onopen(): ((event: Event) => void) | null { return null; }
    set onclose(handler: ((event: CloseEvent) => void) | null) {
      if (handler) this.addEventListener('close', handler as EventListener);
    }
    get onclose(): ((event: CloseEvent) => void) | null { return null; }
    set onerror(handler: ((event: Event) => void) | null) {
      if (handler) this.addEventListener('error', handler as EventListener);
    }
    get onerror(): ((event: Event) => void) | null { return null; }
  }

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances };
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------
function encodeSseEvents(events: Array<{ event?: string; data: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.event) lines.push(`event: ${ev.event}`);
    lines.push(`data: ${ev.data}`);
    lines.push('');
  }
  return encoder.encode(lines.join('\n') + '\n');
}

describe.skipIf(typeof window === 'undefined')('Realtime transport (browser, shape verification)', () => {
  it('sdk.realtime.viaSse() returns a DomainEvents object with domain feeds', () => {
    const sdk = makeSdk();
    const events = sdk.realtime.viaSse();

    expect(events).toBeDefined();
    // DomainEvents exposes known runtime event domains as feed properties.
    // 'turn', 'agents', 'tasks' are stable members of RUNTIME_EVENT_DOMAINS.
    expect(typeof events.turn).toBe('object');
    expect(typeof events.agents).toBe('object');
    expect(typeof events.tasks).toBe('object');
    // Each feed exposes .on() and .onEnvelope() — NOT .subscribe().
    expect(typeof events.turn.on).toBe('function');
    expect(typeof events.turn.onEnvelope).toBe('function');
  });

  it('forSession(events, sessionId) returns a session-scoped DomainEvents with the same feed shape', () => {
    const sdk = makeSdk();
    // First arg is DomainEvents from sdk.realtime.viaSse(), NOT the sdk object.
    const events = sdk.realtime.viaSse();
    const sessionEvents = forSession(events, SESSION_ID);

    expect(sessionEvents).toBeDefined();
    expect(typeof sessionEvents.turn).toBe('object');
    expect(typeof sessionEvents.turn.on).toBe('function');
    expect(typeof sessionEvents.turn.onEnvelope).toBe('function');
  });
});

describe.skipIf(typeof window === 'undefined')('Realtime transport (browser, SSE)', () => {
  it('domain feed on() callback receives SSE events matching the domain', async () => {
    // The SSE connector opens GET /api/control-plane/events?domains={domain}
    // for each domain that has active listeners.
    // We intercept any request to /api/control-plane/events regardless of query params.
    worker.use(
      http.get(`${BASE_URL}/api/control-plane/events`, () => {
        // Emit one event on the 'agents' domain.
        // SSE frame format: "event: {domain}\ndata: {serialized envelope}\n\n"
        // Verified against createEventSourceConnector in runtime-events.ts:
        //   onEvent fires when eventName === domain.
        const body = encodeSseEvents([
          {
            event: 'agents',
            data: JSON.stringify({
              type: 'agent_status',
              sessionId: SESSION_ID,
              payload: { status: 'idle' },
            }),
          },
        ]);
        return new HttpResponse(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const sdk = makeSdk();
    const events = sdk.realtime.viaSse();
    const sessionEvents = forSession(events, SESSION_ID);

    const received: unknown[] = [];
    // Subscribe using the real feed API: .on(type, payloadCallback)
    const unsubscribe = sessionEvents.agents.on('agent_status', (payload) => {
      received.push(payload);
    });

    // Allow the SSE stream to deliver events.
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    unsubscribe();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect((received[0] as Record<string, unknown>).status).toBe('idle');
  });
});

describe.skipIf(typeof window === 'undefined')('Realtime transport (browser, WebSocket mock)', () => {
  it('viaWebSocket() creates a WebSocket connection and receives messages', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();

    const sdk = createBrowserGoodVibesSdk({
      baseUrl: BASE_URL,
      WebSocketImpl: MockWebSocket,
    });

    // viaWebSocket() returns DomainEvents backed by the WebSocket connector.
    const events = sdk.realtime.viaWebSocket(MockWebSocket);
    const sessionEvents = forSession(events, SESSION_ID);

    const received: unknown[] = [];
    // Subscribe to a domain to trigger the WebSocket connection.
    const unsubscribe = sessionEvents.agents.on('agent_status', (payload) => {
      received.push(payload);
    });

    // Allow the connector to instantiate the WebSocket.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // The connector must have created at least one WebSocket instance.
    expect(instances.length).toBe(1);

    const ws = instances[0]!;
    // Simulate the full connection lifecycle.
    ws.simulateOpen();

    // The WS connector expects frames shaped as:
    // { type: 'event', event: <domain>, payload: SerializedRuntimeEnvelope }
    // Verified against createWebSocketConnector onMessage handler in runtime-events.ts:
    //   frame.type === 'event' && frame.event === domain && frame.payload
    ws.simulateMessage(
      JSON.stringify({
        type: 'event',
        event: 'agents',
        payload: {
          type: 'agent_status',
          sessionId: SESSION_ID,
          payload: { status: 'idle' },
        },
      }),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    ws.simulateClose();

    unsubscribe();

    // At least one message must have been received after open+message.
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect((received[0] as Record<string, unknown>).status).toBe('idle');
  });
});
