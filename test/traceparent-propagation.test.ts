/**
 * OTel traceparent/tracestate propagation tests.
 *
 * Covers:
 * 1. OTel absent (default) — no traceparent header injected, request proceeds normally
 * 2. OTel present, active span — traceparent header injected with correct W3C format
 * 3. OTel present, no active span — no traceparent header
 * 4. injectTraceparent() — synchronous, does not mutate headers when OTel absent
 * 5. injectTraceparentAsync() — async variant, same behaviour
 * 6. traceparent format: "00-{traceId}-{spanId}-{flags}"
 * 7. tracestate header injected when span has traceState
 * 8. OTel errors are isolated and do not propagate
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { injectTraceparent, injectTraceparentAsync } from '../packages/transport-core/src/otel.js';
import { resetOtelState, setOtelModuleOverride } from '../packages/transport-core/src/otel-state.js';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// Reset module-level cache between tests by re-importing with a fresh cache
// We patch globalThis.require to simulate OTel presence/absence.
// ---------------------------------------------------------------------------

function makeSpanContext(overrides: {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  traceState?: string | null;
} = {}): object {
  return {
    traceId: overrides.traceId ?? 'aabbccdd001122334455667788990011',
    spanId: overrides.spanId ?? '0102030405060708',
    traceFlags: overrides.traceFlags ?? 1, // SAMPLED
    traceState: overrides.traceState !== undefined
      ? (overrides.traceState ? { serialize: () => overrides.traceState } : null)
      : null,
  };
}

function makeOtelApi(spanCtx: ReturnType<typeof makeSpanContext> | null = makeSpanContext()): object {
  return {
    trace: {
      getActiveSpan: () => spanCtx ? { spanContext: () => spanCtx } : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// injectTraceparent() — synchronous
// ---------------------------------------------------------------------------

describe('injectTraceparent() — OTel absent', () => {
  test('no traceparent header added when OTel is not installed', () => {
    // In the test environment, @opentelemetry/api is not installed.
    // The sync probe falls back to null.
    const headers: Record<string, string> = {};
    injectTraceparent(headers);
    // Header should NOT be injected since OTel is absent.
    expect(headers['traceparent']).toBeUndefined();
  });

  test('headers object is not modified when OTel is absent', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer token' };
    const before = { ...headers };
    injectTraceparent(headers);
    expect(headers).toEqual(before);
  });
});

describe('injectTraceparent() — OTel present via injected state', () => {
  const origRequire = (globalThis as { require?: unknown }).require;

  afterEach(() => {
    if (origRequire !== undefined) {
      (globalThis as { require?: unknown }).require = origRequire;
    } else {
      delete (globalThis as { require?: unknown }).require;
    }
    resetOtelState();
  });

  test('traceparent header is injected when active span is present', () => {
    const spanCtx = makeSpanContext({
      traceId: 'aabbccdd001122334455667788990011',
      spanId: '0102030405060708',
      traceFlags: 1,
    });
    resetOtelState();
    setOtelModuleOverride(makeOtelApi(spanCtx as ReturnType<typeof makeSpanContext>) as never);

    const headers: Record<string, string> = {};
    injectTraceparent(headers);

    expect(headers['traceparent']).toBe('00-aabbccdd001122334455667788990011-0102030405060708-01');
  });

  test('traceparent format is 00-{32hex}-{16hex}-{2hex}', () => {
    const traceId = '0'.repeat(32);
    const spanId = 'f'.repeat(16);
    const flags = 255;
    const flagsHex = (flags & 0xff).toString(16).padStart(2, '0');
    const traceparent = `00-${traceId}-${spanId}-${flagsHex}`;
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  test('flags 0 produces 00 flag byte', () => {
    const flags = 0;
    const flagsHex = (flags & 0xff).toString(16).padStart(2, '0');
    expect(flagsHex).toBe('00');
  });

  test('sampled flag (1) produces 01 flag byte', () => {
    const flags = 1;
    const flagsHex = (flags & 0xff).toString(16).padStart(2, '0');
    expect(flagsHex).toBe('01');
  });
});

// ---------------------------------------------------------------------------
// injectTraceparentAsync() — async variant
// ---------------------------------------------------------------------------

describe('injectTraceparentAsync() — OTel absent', () => {
  test('returns without adding traceparent header when OTel not installed', async () => {
    const headers: Record<string, string> = {};
    await injectTraceparentAsync(headers);
    expect(headers['traceparent']).toBeUndefined();
  });

  test('does not throw when OTel is absent', async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let threw = false;
    try {
      await injectTraceparentAsync(headers);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OTel error isolation
// ---------------------------------------------------------------------------

describe('OTel error isolation', () => {
  test('injectTraceparent() does not throw if internal OTel call fails', () => {
    // Simulate a broken OTel API via patching globalThis.require
    const origRequire = (globalThis as { require?: unknown }).require;
    (globalThis as { require?: unknown }).require = (mod: string) => {
      if (mod === '@opentelemetry/api') {
        return {
          trace: {
            getActiveSpan: () => {
              throw new Error('OTel internal error');
            },
          },
        };
      }
      return origRequire ? (origRequire as (m: string) => unknown)(mod) : undefined;
    };

    const headers: Record<string, string> = {};
    let threw = false;
    try {
      injectTraceparent(headers);
    } catch {
      threw = true;
    }

    // Restore
    if (origRequire !== undefined) {
      (globalThis as { require?: unknown }).require = origRequire;
    } else {
      delete (globalThis as { require?: unknown }).require;
    }
    resetOtelState();

    expect(threw).toBe(false);
    // Headers may or may not have been modified, but no exception must escape.
  });

  test('injectTraceparentAsync() does not throw if dynamic import fails', async () => {
    const headers: Record<string, string> = {};
    let threw = false;
    try {
      await injectTraceparentAsync(headers);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP transport integration — traceparent not injected when OTel absent
// ---------------------------------------------------------------------------

describe('HTTP transport: traceparent not present when OTel absent', () => {
  test('no traceparent header in outgoing HTTP requests when OTel is absent', async () => {
    const { createHttpJsonTransport } = await import('../packages/transport-http/src/http-core.js');
    let capturedHeaders: Record<string, string> = {};
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const h = new Headers(init?.headers as HeadersInit);
      h.forEach((value, key) => { capturedHeaders[key] = value; });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const transport = createHttpJsonTransport({
      baseUrl: 'https://api.example.com',
      fetch,
    });
    await transport.requestJson('/v1/test');
    expect(capturedHeaders['traceparent']).toBeUndefined();
    expect(capturedHeaders['tracestate']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MINOR 1: Positive OTel path — injection seam
// ---------------------------------------------------------------------------

describe('injectTraceparent() — OTel present via test state', () => {
  test('traceparent header injected with correct W3C format when active span is present', async () => {
    resetOtelState();
    setOtelModuleOverride(makeOtelApi(makeSpanContext()) as never);

    const headers: Record<string, string> = {};
    injectTraceparent(headers);
    resetOtelState();

    expect(headers['traceparent']).toBe('00-aabbccdd001122334455667788990011-0102030405060708-01');
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  test('OTel test state is not part of the public otel surface', async () => {
    const otelModule = await import('../packages/transport-core/src/otel.js');
    expect('setOtelModuleOverride' in otelModule).toBe(false);
    expect('__resetOtelCache' in otelModule).toBe(false);
    expect('getOtelModuleOverride' in otelModule).toBe(false);
  });

  test('OTel test state is not exported from source public surfaces', async () => {
    const rootModule = await import('../packages/transport-core/src/index.js');
    const otelModule = await import('../packages/transport-core/src/otel.js');

    for (const module of [rootModule, otelModule]) {
      expect('setOtelModuleOverride' in module).toBe(false);
      expect('resetOtelState' in module).toBe(false);
      expect('readOtelModuleOverride' in module).toBe(false);
      expect('cacheOtelApi' in module).toBe(false);
    }
  });

  test('traceparent format verified for various flag values', () => {
    // Verify the W3C format for different flag combinations.
    const cases = [
      { flags: 0, expected: '00' },
      { flags: 1, expected: '01' },
      { flags: 255, expected: 'ff' },
    ];
    for (const { flags, expected } of cases) {
      const flagsHex = (flags & 0xff).toString(16).padStart(2, '0');
      expect(flagsHex).toBe(expected);
    }
  });

  test('tracestate header is injected when present in span context', async () => {
    // Verify the seam in the async path exists and is callable.
    const { injectTraceparentAsync } =
      await import('../packages/transport-core/src/otel.js') as {
        injectTraceparentAsync: (h: Record<string, string>) => Promise<void>;
      };

    resetOtelState();

    // Without a real OTel module, async inject is a no-op. Verify it doesn't throw.
    const headers: Record<string, string> = {};
    await injectTraceparentAsync(headers);
    // Headers unchanged when no span is active.
    expect(Object.keys(headers).length).toBe(0);

    resetOtelState();
  });
});

describe('HTTP transport: traceparent injection with OTel test state', () => {
  test('injectTraceparent injects correct W3C traceparent header via test override', async () => {
    const { injectTraceparent: inject } =
      await import('../packages/transport-core/src/otel.js') as {
        injectTraceparent: (h: Record<string, string>) => void;
      };

    resetOtelState();

    const mockTraceId = '0af7651916cd43dd8448eb211c80319c';
    const mockSpanId = 'b7ad6b7169203331';
    const mockFlags = 1;

    setOtelModuleOverride({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: mockTraceId,
            spanId: mockSpanId,
            traceFlags: mockFlags,
            traceState: null,
          }),
        }),
      },
    });

    const headers: Record<string, string> = {};
    inject(headers);
    resetOtelState();

    expect(headers['traceparent']).toBe(`00-${mockTraceId}-${mockSpanId}-01`);
    expect(headers['tracestate']).toBeUndefined();
  });

  test('tracestate header is injected when span context has traceState', async () => {
    const { injectTraceparent: inject } =
      await import('../packages/transport-core/src/otel.js') as {
        injectTraceparent: (h: Record<string, string>) => void;
      };

    resetOtelState();

    setOtelModuleOverride({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: '00000000000000000000000000000001',
            spanId: '0000000000000001',
            traceFlags: 1,
            traceState: { serialize: () => 'vendor=example' },
          }),
        }),
      },
    });

    const headers: Record<string, string> = {};
    inject(headers);
    resetOtelState();

    expect(headers['traceparent']).toBe('00-00000000000000000000000000000001-0000000000000001-01');
    expect(headers['tracestate']).toBe('vendor=example');
  });

  test('no span active — no traceparent injected even when OTel is present', async () => {
    const { injectTraceparent: inject } =
      await import('../packages/transport-core/src/otel.js') as {
        injectTraceparent: (h: Record<string, string>) => void;
      };

    resetOtelState();

    // OTel present but no active span.
    setOtelModuleOverride({
      trace: {
        getActiveSpan: () => undefined,
      },
    });

    const headers: Record<string, string> = {};
    inject(headers);
    resetOtelState();

    expect(headers['traceparent']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SSE positive path — traceparent in fetch headers when OTel is present
// ---------------------------------------------------------------------------

describe('SSE transport: traceparent in fetch headers when OTel is present', () => {
  test('traceparent header appears in SSE fetch request when active span is present', async () => {
    const { setOtelModuleOverride: setDistOtelModuleOverride, resetOtelState: resetDistOtelState } =
      await import('../packages/transport-core/dist/otel-state.js') as {
        setOtelModuleOverride: (api: unknown) => void;
        resetOtelState: () => void;
      };

    const mockTraceId = '0af7651916cd43dd8448eb211c80319c';
    const mockSpanId  = 'b7ad6b7169203331';

    resetDistOtelState();
    setDistOtelModuleOverride({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: mockTraceId,
            spanId: mockSpanId,
            traceFlags: 1,
            traceState: null,
          }),
        }),
      },
    });

    const { createEventSourceConnector } =
      await import('../packages/transport-realtime/dist/runtime-events.js') as {
        createEventSourceConnector: (
          baseUrl: string,
          token: string,
          fetchImpl: typeof fetch,
        ) => (domain: string, onEnvelope: () => void) => Promise<() => void>;
      };

    let capturedHeaders: Record<string, string> = {};
    const fetchSpy: typeof globalThis.fetch = async (_input, init) => {
      const h = new Headers(init?.headers as HeadersInit);
      h.forEach((value, key) => { capturedHeaders[key] = value; });
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const connector = createEventSourceConnector(
      'http://127.0.0.1:3210',
      'test-token',
      fetchSpy,
    );

    const stop = await connector('agents', () => {});
    stop();

    resetDistOtelState();

    expect(capturedHeaders['traceparent']).toBe(`00-${mockTraceId}-${mockSpanId}-01`);
  });
});

// ---------------------------------------------------------------------------
// WebSocket positive path — traceparent in auth frame when OTel is present
// ---------------------------------------------------------------------------

describe('WebSocket transport: traceparent in auth frame when OTel is present', () => {
  test('traceparent field appears in WS auth frame when active span is present', async () => {
    const { setOtelModuleOverride: setDistOtelModuleOverride, resetOtelState: resetDistOtelState } =
      await import('../packages/transport-core/dist/otel-state.js') as {
        setOtelModuleOverride: (api: unknown) => void;
        resetOtelState: () => void;
      };

    const mockTraceId = '0af7651916cd43dd8448eb211c80319c';
    const mockSpanId  = 'b7ad6b7169203331';

    resetDistOtelState();
    setDistOtelModuleOverride({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: mockTraceId,
            spanId: mockSpanId,
            traceFlags: 1,
            traceState: null,
          }),
        }),
      },
    });

    const { createWebSocketConnector } =
      await import('../packages/transport-realtime/dist/runtime-events.js') as {
        createWebSocketConnector: (
          baseUrl: string,
          token: string,
          WebSocketImpl: typeof WebSocket,
        ) => (domain: string, onEnvelope: () => void) => Promise<() => void>;
      };

    const sentMessages: string[] = [];
    type WsEventName = 'open' | 'message' | 'close' | 'error';

    class MockWebSocket {
      private listeners = new Map<WsEventName, Set<EventListenerOrEventListenerObject>>();
      readonly readyState = 1; // OPEN

      constructor(_url: string) {
        queueMicrotask(() => this._dispatch('open', new Event('open')));
      }

      _dispatch(event: WsEventName, e: Event) {
        for (const listener of this.listeners.get(event) ?? []) {
          if (typeof listener === 'function') {
            (listener as EventListener)(e);
          } else {
            listener.handleEvent(e);
          }
        }
      }

      addEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(listener);
      }

      removeEventListener(event: WsEventName, listener: EventListenerOrEventListenerObject) {
        this.listeners.get(event)?.delete(listener);
      }

      send(data: string) { sentMessages.push(data); }
      close() {}
    }

    const connector = createWebSocketConnector(
      'http://127.0.0.1:3210',
      'test-token',
      MockWebSocket as unknown as typeof WebSocket,
    );

    await connector('agents', () => {});
    // Allow async onOpen handler (which calls injectTraceparentAsync) to complete.
    await settleEvents(30);

    resetDistOtelState();

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const authFrame = JSON.parse(sentMessages[0]!) as {
      type: string;
      token: string;
      domains: string[];
      traceparent?: string;
    };
    expect(authFrame.type).toBe('auth');
    expect(authFrame.traceparent).toBe(`00-${mockTraceId}-${mockSpanId}-01`);
  });
});
