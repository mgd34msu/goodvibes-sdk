/**
 * Tests for UX-first enhancements:
 *  Task 1 — Typed connection-state events (ConnectionState, ReconnectAttemptInfo)
 *  Task 2 — Backpressure visibility (BackpressureInfo, onBackpressure callback)
 *  Task 3 — WS error envelope parity (createWebSocketRemoteError)
 *  Task 4 — Granular progress event contracts (BATCH_JOB_PROGRESS, EXPORT_PROGRESS, KNOWLEDGE_INGEST_PROGRESS)
 */
import { describe, expect, test } from 'bun:test';
import {
  createWebSocketConnector,
  createWebSocketRemoteError,
  WebSocketTransportError,
  type BackpressureInfo,
  type ConnectionState,
  type ConnectorTransportEvent,
  type ReconnectAttemptInfo,
  type RuntimeEventConnectorOptions,
} from '../packages/sdk/dist/index.js';
import type {
  TaskEvent,
  KnowledgeEvent,
  TransportEvent,
} from '../packages/sdk/dist/index.js';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// Minimal mock WebSocket for connector tests
// ---------------------------------------------------------------------------
type WsEventName = 'open' | 'message' | 'close' | 'error';

interface MockWebSocketHandle {
  simulateOpen(): void;
  simulateMessage(data: string): void;
  simulateClose(code?: number, reason?: string): void;
  sentMessages: string[];
}

function createMockWebSocketClass(): {
  MockWebSocket: typeof WebSocket;
  instances: MockWebSocketHandle[];
} {
  const instances: MockWebSocketHandle[] = [];

  class MockWebSocket {
    private listeners = new Map<WsEventName, Set<EventListenerOrEventListenerObject>>();
    readonly sentMessages: string[] = [];
    readonly url: string;
    readyState: number = 0;

    constructor(url: string) {
      this.url = url;
      const handle: MockWebSocketHandle = {
        simulateOpen: () => {
          this.readyState = 1;
          this._dispatch('open', new Event('open'));
        },
        simulateMessage: (data: string) => {
          const evt = new MessageEvent('message', { data });
          this._dispatch('message', evt);
        },
        simulateClose: (code = 1006, reason = '') => {
          this.readyState = 3;
          const evt = new CloseEvent('close', { code, reason, wasClean: code === 1000 });
          this._dispatch('close', evt);
        },
        sentMessages: this.sentMessages,
      };
      instances.push(handle);
    }

    static get OPEN(): number { return 1; }

    addEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }

    removeEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
      this.listeners.get(event)?.delete(listener);
    }

    send(data: string) {
      this.sentMessages.push(data);
    }

    close() { this.readyState = 3; }

    private _dispatch(event: WsEventName, evt: Event) {
      for (const listener of this.listeners.get(event) ?? []) {
        if (typeof listener === 'function') listener(evt);
        else listener.handleEvent(evt);
      }
    }
  }

  return { MockWebSocket: MockWebSocket as unknown as typeof WebSocket, instances };
}

// ---------------------------------------------------------------------------
// Task 1 — Typed connection-state events
// ---------------------------------------------------------------------------
describe('Task 1: typed connection-state events', () => {
  test('ConnectionState type is exported and covers all expected literals', () => {
    // Type-level assertion: if any literal is missing this assignment would fail at compile time.
    const states: ConnectionState[] = [
      'connecting',
      'connected',
      'reconnecting',
      'disconnected',
      'failed',
    ];
    expect(states).toHaveLength(5);
  });

  test('ReconnectAttemptInfo type carries all required fields', () => {
    const info: ReconnectAttemptInfo = {
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: 'connection closed',
    };
    expect(info.attempt).toBe(1);
    expect(info.maxAttempts).toBe(10);
    expect(info.delayMs).toBe(500);
    expect(info.reason).toBe('connection closed');
  });

  test('onConnectionStateChange fires connecting then connected on successful open', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});
    expect(instances).toHaveLength(1);

    instances[0].simulateOpen();
    await settleEvents(10);

    // Exact sequence: connecting (from connect()) then connected (after auth).
    // onOpen must NOT emit 'connecting' — that would be a dedup-suppressed no-op
    // but semantically wrong. The sequence must be exactly [connecting, connected].
    expect(states).toEqual(['connecting', 'connected']);

    stop();
    await settleEvents(0);
    expect(states).toContain('disconnected');
  });

  test('onConnectionStateChange fires reconnecting after abnormal close', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);
    instances[0].simulateClose(1006); // abnormal close
    await settleEvents(10);

    expect(states).toContain('reconnecting');
    stop();
  });

  test('onConnectionStateChange fires failed when attempts exhausted', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 },
      onConnectionStateChange: (s) => states.push(s),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // exhaust the single allowed reconnect
    instances[0].simulateOpen();
    await settleEvents(10);
    instances[0].simulateClose(1006);
    await settleEvents(10);
    // second connection attempt (reconnect #1)
    const ws2 = instances[instances.length - 1];
    if (ws2) {
      ws2.simulateOpen();
      await settleEvents(10);
      ws2.simulateClose(1006);
      await settleEvents(10);
    }

    expect(states).toContain('failed');
    stop();
  });

  test('onReconnectAttempt fires with structured metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const attempts: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onReconnectAttempt: (info) => attempts.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);
    instances[0].simulateClose(1006, 'server error');
    await settleEvents(10);

    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const first = attempts[0]!;
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(5);
    expect(typeof first.delayMs).toBe('number');
    expect(typeof first.reason).toBe('string');
    expect(first.reason.length).toBeGreaterThan(0);

    stop();
  });

  test('legacy onReconnect still fires alongside onReconnectAttempt (backward compat)', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const legacyCalls: [number, number][] = [];
    const newCalls: ReconnectAttemptInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onReconnect: (attempt, delayMs) => legacyCalls.push([attempt, delayMs]),
      onReconnectAttempt: (info) => newCalls.push(info),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);
    instances[0].simulateClose(1006);
    await settleEvents(10);

    expect(legacyCalls.length).toBeGreaterThanOrEqual(1);
    expect(newCalls.length).toBeGreaterThanOrEqual(1);
    // Both should agree on attempt number
    expect(legacyCalls[0]![0]).toBe(newCalls[0]!.attempt);

    stop();
  });
});

// ---------------------------------------------------------------------------
// Task 2 — Backpressure visibility
// ---------------------------------------------------------------------------
describe('Task 2: backpressure visibility', () => {
  test('BackpressureInfo type carries all required fields', () => {
    const info: BackpressureInfo = {
      droppedCount: 5,
      queueLength: 100,
      queueBytes: 102400,
      reason: 'queue_full',
    };
    expect(info.droppedCount).toBe(5);
    expect(info.reason).toBe('queue_full');
  });

  test('onBackpressure fires with queue_full reason when queue saturates', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];

    // Note: MAX_OUTBOUND_QUEUE = 1024 in the implementation.
    // We keep the socket disconnected so all sends queue up.
    const opts: RuntimeEventConnectorOptions = {
      onBackpressure: (info) => bpEvents.push(info),
      onEmitter: (emitLocal) => {
        // Flood the queue: 1025 small messages to trigger the cap
        const smallMsg = JSON.stringify({ type: 'x', data: 'a'.repeat(10) });
        for (let i = 0; i < 1025; i++) {
          emitLocal(smallMsg);
        }
      },
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});
    await settleEvents(10);

    // onEmitter fires synchronously (before socket open) so backpressure callbacks fire
    // before any WebSocket is instantiated — only the queue saturation matters here.
    // The first overflow fires at item 1025
    expect(bpEvents.length).toBeGreaterThanOrEqual(1);
    const bp = bpEvents[0]!;
    expect(bp.reason).toBe('queue_full');
    expect(bp.droppedCount).toBeGreaterThanOrEqual(1);
  });

  test('onBackpressure fires with message_too_large reason for oversized single message', async () => {
    const { MockWebSocket } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onBackpressure: (info) => bpEvents.push(info),
      onEmitter: (emitLocal) => {
        // MAX_OUTBOUND_MESSAGE_BYTES = 1 MiB = 1048576
        const hugeMsg = 'x'.repeat(1048577);
        emitLocal(hugeMsg);
      },
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});
    await settleEvents(10);

    expect(bpEvents.length).toBeGreaterThanOrEqual(1);
    expect(bpEvents[0]!.reason).toBe('message_too_large');
  });

  test('overflow notification resets after successful reconnect flush', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const bpEvents: BackpressureInfo[] = [];

    let emitter!: (data: string) => void;
    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onBackpressure: (info) => bpEvents.push(info),
      onEmitter: (fn) => { emitter = fn; },
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});
    await settleEvents(10);

    // Flood queue while disconnected
    const smallMsg = JSON.stringify({ t: 'x' });
    for (let i = 0; i < 1025; i++) emitter(smallMsg);
    expect(bpEvents.length).toBeGreaterThanOrEqual(1);
    const beforeReconnect = bpEvents.length;

    // Connect (flushOutboundQueue resets the overflow counter + drains the queue)
    instances[0].simulateOpen();
    await settleEvents(10);

    // Disconnect again so the next messages go to the queue (not the open socket)
    instances[0].simulateClose(1006);
    await settleEvents(10);

    // Flood again — the overflow counter was reset on the previous flush, so the
    // first overflow in this disconnected session should fire a new backpressure event.
    for (let i = 0; i < 1025; i++) emitter(smallMsg);
    expect(bpEvents.length).toBeGreaterThan(beforeReconnect);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — WS error envelope parity
// ---------------------------------------------------------------------------
describe('Task 3: WS error envelope parity', () => {
  test('createWebSocketRemoteError falls back to fallbackMessage for non-structured body', () => {
    const err = createWebSocketRemoteError('Something went wrong', { some: 'object' });
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Something went wrong');
    expect(err.code).toBe('WS_REMOTE_ERROR');
  });

  test('createWebSocketRemoteError uses body string directly when body is a non-empty string', () => {
    const err = createWebSocketRemoteError('fallback', 'Server said no');
    expect(err.message).toBe('Server said no');
  });

  test('createWebSocketRemoteError unpacks structured daemon error body', () => {
    const body = {
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      category: 'rate_limit',
      recoverable: true,
      hint: 'Wait 60 seconds before retrying.',
      requestId: 'req-abc',
    };
    const err = createWebSocketRemoteError('fallback', body);
    expect(err).toBeInstanceOf(WebSocketTransportError);
    expect(err.message).toBe('Rate limit exceeded');
    // The transport code is always a canonical WS code ('WS_REMOTE_ERROR');
    // the server's body.code is not used as the error code since Symbol.hasInstance
    // enforces a canonical-code allowlist. The server's metadata (category, recoverable,
    // hint, requestId) is preserved on the error object.
    expect(err.code).toBe('WS_REMOTE_ERROR');
    expect(err.category).toBe('rate_limit');
    expect(err.recoverable).toBe(true);
    expect(err.hint).toBe('Wait 60 seconds before retrying.');
    expect(err.requestId).toBe('req-abc');
  });

  test('createWebSocketRemoteError respects caller code override for non-structured body', () => {
    const err = createWebSocketRemoteError('fallback', null, { code: 'WS_CLOSE_ABNORMAL', hint: 'reconnect' });
    expect(err.code).toBe('WS_CLOSE_ABNORMAL');
    expect(err.hint).toBe('reconnect');
  });

  test('WebSocketTransportError constructor accepts extended options for parity with HttpStatusError', () => {
    const err = new WebSocketTransportError('Auth failed over WS', {
      code: 'WS_REMOTE_ERROR',
      category: 'authentication',
      recoverable: false,
      status: 401,
      requestId: 'req-xyz',
    });
    expect(err.category).toBe('authentication');
    expect(err.recoverable).toBe(false);
    expect(err.status).toBe(401);
    expect(err.requestId).toBe('req-xyz');
  });

  test('WebSocketTransportError defaults to network/recoverable when category/recoverable omitted', () => {
    const err = new WebSocketTransportError('WS error', { code: 'WS_EVENT_ERROR' });
    expect(err.category).toBe('network');
    expect(err.recoverable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 4 — Granular progress event contracts
// ---------------------------------------------------------------------------
describe('Task 4: granular progress event contracts', () => {
  test('BATCH_JOB_PROGRESS event shape satisfies TaskEvent union', () => {
    const event: TaskEvent = {
      type: 'BATCH_JOB_PROGRESS',
      operationId: 'op-1',
      phase: 'embedding',
      completed: 50,
      total: 200,
      percent: 25,
      message: 'Processing documents...',
    };
    expect(event.type).toBe('BATCH_JOB_PROGRESS');
    // Narrowing works:
    if (event.type === 'BATCH_JOB_PROGRESS') {
      expect(event.operationId).toBe('op-1');
      expect(event.phase).toBe('embedding');
      expect(event.completed).toBe(50);
      expect(event.total).toBe(200);
      expect(event.percent).toBe(25);
    }
  });

  test('BATCH_JOB_PROGRESS event shape works with optional fields absent', () => {
    const event: TaskEvent = {
      type: 'BATCH_JOB_PROGRESS',
      operationId: 'op-2',
      phase: 'indexing',
      completed: 10,
    };
    expect(event.type).toBe('BATCH_JOB_PROGRESS');
    if (event.type === 'BATCH_JOB_PROGRESS') {
      expect(event.total).toBeUndefined();
      expect(event.percent).toBeUndefined();
      expect(event.message).toBeUndefined();
    }
  });

  test('EXPORT_PROGRESS event shape satisfies TaskEvent union', () => {
    const event: TaskEvent = {
      type: 'EXPORT_PROGRESS',
      operationId: 'export-1',
      phase: 'serializing',
      completed: 1000,
      total: 5000,
      percent: 20,
      message: 'Exporting sessions...',
    };
    expect(event.type).toBe('EXPORT_PROGRESS');
    if (event.type === 'EXPORT_PROGRESS') {
      expect(event.operationId).toBe('export-1');
      expect(event.phase).toBe('serializing');
    }
  });

  test('KNOWLEDGE_INGEST_PROGRESS event shape satisfies KnowledgeEvent union', () => {
    const event: KnowledgeEvent = {
      type: 'KNOWLEDGE_INGEST_PROGRESS',
      operationId: 'ingest-1',
      phase: 'chunking',
      completed: 30,
      total: 100,
      percent: 30,
      message: 'Processing chunk 30/100',
    };
    expect(event.type).toBe('KNOWLEDGE_INGEST_PROGRESS');
    if (event.type === 'KNOWLEDGE_INGEST_PROGRESS') {
      expect(event.operationId).toBe('ingest-1');
      expect(event.phase).toBe('chunking');
    }
  });

  test('KNOWLEDGE_INGEST_PROGRESS works with optional fields absent', () => {
    const event: KnowledgeEvent = {
      type: 'KNOWLEDGE_INGEST_PROGRESS',
      operationId: 'ingest-2',
      phase: 'embedding',
      completed: 0,
    };
    if (event.type === 'KNOWLEDGE_INGEST_PROGRESS') {
      expect(event.total).toBeUndefined();
      expect(event.percent).toBeUndefined();
      expect(event.message).toBeUndefined();
    }
  });

  test('TRANSPORT_BACKPRESSURE event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_BACKPRESSURE',
      transportId: 'agents-ws',
      droppedCount: 5,
      queueLength: 1024,
      queueBytes: 2048,
      reason: 'queue_full',
    };
    expect(event.type).toBe('TRANSPORT_BACKPRESSURE');
  });

  test('TRANSPORT_CONNECTION_STATE event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_CONNECTION_STATE',
      transportId: 'agents-ws',
      state: 'reconnecting',
    };
    expect(event.type).toBe('TRANSPORT_CONNECTION_STATE');
    if (event.type === 'TRANSPORT_CONNECTION_STATE') {
      expect(event.state).toBe('reconnecting');
    }
  });

  test('TRANSPORT_RECONNECT_ATTEMPT event shape satisfies TransportEvent union', () => {
    const event: TransportEvent = {
      type: 'TRANSPORT_RECONNECT_ATTEMPT',
      transportId: 'agents-ws',
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: 'connection closed',
    };
    expect(event.type).toBe('TRANSPORT_RECONNECT_ATTEMPT');
  });
});

// ---------------------------------------------------------------------------
// Task 5 — onTransportEvent: typed events dispatched by connector
// ---------------------------------------------------------------------------
describe('Task 5: onTransportEvent typed event dispatch', () => {
  test('onTransportEvent receives TRANSPORT_CONNECTION_STATE on each state transition', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    // Before open: 'connecting' event from connect()
    const connectingEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE',
    );
    expect(connectingEvents.length).toBeGreaterThanOrEqual(1);
    expect(connectingEvents[0]!.state).toBe('connecting');

    instances[0].simulateOpen();
    await settleEvents(10);

    const stateEvents = events
      .filter((e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE')
      .map((e) => e.state);

    // Exact sequence pin: connecting then connected, no duplicates
    expect(stateEvents).toEqual(['connecting', 'connected']);

    stop();
    await settleEvents(0);

    const afterStop = events
      .filter((e): e is ConnectorTransportEvent & { type: 'TRANSPORT_CONNECTION_STATE' } =>
        e.type === 'TRANSPORT_CONNECTION_STATE')
      .map((e) => e.state);
    expect(afterStop).toContain('disconnected');
  });

  test('onTransportEvent receives TRANSPORT_RECONNECT_ATTEMPT with full metadata', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    const stop = await connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);
    instances[0].simulateClose(1006, 'server error');
    await settleEvents(10);

    const reconnectEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_RECONNECT_ATTEMPT' } =>
        e.type === 'TRANSPORT_RECONNECT_ATTEMPT',
    );
    expect(reconnectEvents.length).toBeGreaterThanOrEqual(1);
    const first = reconnectEvents[0]!;
    expect(first.attempt).toBe(1);
    expect(first.maxAttempts).toBe(5);
    expect(typeof first.delayMs).toBe('number');
    expect(first.reason.length).toBeGreaterThan(0);

    stop();
  });

  test('onTransportEvent receives TRANSPORT_BACKPRESSURE when queue overflows', async () => {
    const { MockWebSocket } = createMockWebSocketClass();
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      onTransportEvent: (e) => events.push(e),
      onEmitter: (emitLocal) => {
        const smallMsg = JSON.stringify({ type: 'x', data: 'a'.repeat(10) });
        for (let i = 0; i < 1025; i++) emitLocal(smallMsg);
      },
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});
    await settleEvents(10);

    const bpEvents = events.filter(
      (e): e is ConnectorTransportEvent & { type: 'TRANSPORT_BACKPRESSURE' } =>
        e.type === 'TRANSPORT_BACKPRESSURE',
    );
    expect(bpEvents.length).toBeGreaterThanOrEqual(1);
    expect(bpEvents[0]!.reason).toBe('queue_full');
    expect(bpEvents[0]!.droppedCount).toBeGreaterThanOrEqual(1);
    expect(typeof bpEvents[0]!.transportId).toBe('string');
    expect(bpEvents[0]!.transportId.length).toBeGreaterThan(0);
  });

  test('code 1005 (No Status Received) schedules reconnect — not a clean close per RFC 6455 §7.4.1', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);

    // simulateClose with code 1005 sets wasClean: false (code !== 1000 in the harness)
    instances[0].simulateClose(1005, '');
    await settleEvents(20);

    // 1005 is NOT a clean close — connector must schedule a reconnect
    expect(states).toContain('reconnecting');
    const reconnectEvents = events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT');
    expect(reconnectEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('clean close (code 1000) does NOT trigger reconnect — state sequence is connecting→connected→disconnected', async () => {
    const { MockWebSocket, instances } = createMockWebSocketClass();
    const states: ConnectionState[] = [];
    const events: ConnectorTransportEvent[] = [];

    const opts: RuntimeEventConnectorOptions = {
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 },
      onConnectionStateChange: (s) => states.push(s),
      onTransportEvent: (e) => events.push(e),
    };
    const connector = createWebSocketConnector('http://127.0.0.1:3210', 'tok', MockWebSocket, opts);
    void connector('agents', () => {});

    instances[0].simulateOpen();
    await settleEvents(10);

    // Simulate clean server-side close
    instances[0].simulateClose(1000, 'normal closure');
    await settleEvents(20);

    // Must NOT see 'reconnecting' after a clean close
    expect(states).not.toContain('reconnecting');
    // Must see 'disconnected' (emitted by onClose clean path)
    expect(states).toContain('disconnected');
    // No TRANSPORT_RECONNECT_ATTEMPT event should be dispatched
    const reconnectEvents = events.filter((e) => e.type === 'TRANSPORT_RECONNECT_ATTEMPT');
    expect(reconnectEvents).toHaveLength(0);
  });
});
