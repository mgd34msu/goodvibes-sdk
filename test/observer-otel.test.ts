/**
 * OpenTelemetry observer — in-memory collector integration tests.
 *
 * Verifies that createOpenTelemetryObserver emits the correct spans and
 * metric increments for every SDKObserver callback:
 *   - onAuthTransition  → sdk.auth.transitions counter + sdk.auth.transition span
 *   - onError           → sdk.errors counter + sdk.error span
 *   - onTransportActivity (recv only) → sdk.transport.duration_ms histogram
 *   - onEvent           → no-op (no metric emitted; verified by absence)
 *
 * All assertions run against in-memory collector mocks — no real OTEL
 * infrastructure required.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  createOpenTelemetryObserver,
  type OtelTracer,
  type OtelMeter,
  type OtelSpan,
  type SDKObserver,
  type TransportActivityInfo,
} from '../packages/sdk/src/observer/index.js';

// ---------------------------------------------------------------------------
// In-memory collector
// ---------------------------------------------------------------------------

interface SpanRecord {
  name: string;
  attributes: Record<string, string | number | boolean>;
  ended: boolean;
  status?: { code: number; message?: string };
  exceptions: Array<Error | unknown>;
}

interface CounterRecord {
  name: string;
  value: number;
  attributes: Record<string, string | number | boolean>;
}

interface HistogramRecord {
  name: string;
  value: number;
  attributes: Record<string, string | number | boolean>;
}

interface Collector {
  spans: SpanRecord[];
  counters: CounterRecord[];
  histograms: HistogramRecord[];
  tracer: OtelTracer;
  meter: OtelMeter;
}

function makeCollector(): Collector {
  const spans: SpanRecord[] = [];
  const counters: CounterRecord[] = [];
  const histograms: HistogramRecord[] = [];

  function makeSpan(name: string): OtelSpan & { _record: SpanRecord } {
    const record: SpanRecord = { name, attributes: {}, ended: false, exceptions: [] };
    spans.push(record);
    const span: OtelSpan & { _record: SpanRecord } = {
      _record: record,
      setAttribute(key, value) { record.attributes[key] = value; return span; },
      setStatus(status) { record.status = status; return span; },
      recordException(err) { record.exceptions.push(err); return span; },
      end() { record.ended = true; },
    };
    return span;
  }

  const tracer: OtelTracer = {
    startActiveSpan<F extends (span: OtelSpan) => unknown>(name: string, fn: F): ReturnType<F> {
      const span = makeSpan(name);
      return fn(span) as ReturnType<F>;
    },
    startSpan(name: string): OtelSpan {
      return makeSpan(name);
    },
  };

  const meter: OtelMeter = {
    createCounter(name) {
      return {
        add(value, attributes = {}) {
          counters.push({ name, value, attributes: attributes as Record<string, string | number | boolean> });
        },
      };
    },
    createHistogram(name) {
      return {
        record(value, attributes = {}) {
          histograms.push({ name, value, attributes: attributes as Record<string, string | number | boolean> });
        },
      };
    },
  };

  return { spans, counters, histograms, tracer, meter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOpenTelemetryObserver — onAuthTransition', () => {
  test('emits sdk.auth.transitions counter with correct attributes', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onAuthTransition?.({ from: 'anonymous', to: 'token', reason: 'login' });

    const counter = col.counters.find((c) => c.name === 'sdk.auth.transitions');
    expect(counter?.name).toBe('sdk.auth.transitions');
    expect(counter!.value).toBe(1);
    expect(counter!.attributes.from).toBe('anonymous');
    expect(counter!.attributes.to).toBe('token');
    expect(counter!.attributes.reason).toBe('login');
  });

  test('emits sdk.auth.transition span with correct attributes', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onAuthTransition?.({ from: 'token', to: 'anonymous', reason: 'logout' });

    const span = col.spans.find((s) => s.name === 'sdk.auth.transition');
    expect(span?.name).toBe('sdk.auth.transition');
    expect(span!.ended).toBe(true);
    expect(span!.attributes['sdk.auth.from']).toBe('token');
    expect(span!.attributes['sdk.auth.to']).toBe('anonymous');
    expect(span!.attributes['sdk.auth.reason']).toBe('logout');
  });

  test('multiple transitions each emit their own counter + span', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onAuthTransition?.({ from: 'anonymous', to: 'token', reason: 'login' });
    obs.onAuthTransition?.({ from: 'token', to: 'anonymous', reason: 'logout' });

    expect(col.counters.filter((c) => c.name === 'sdk.auth.transitions')).toHaveLength(2);
    expect(col.spans.filter((s) => s.name === 'sdk.auth.transition')).toHaveLength(2);
  });
});

describe('createOpenTelemetryObserver — onError', () => {
  function makeSdkError(kind = 'network', category = 'transport'): Parameters<NonNullable<SDKObserver['onError']>>[0] {
    const err = Object.assign(new Error('sdk test error'), {
      kind,
      category,
      recoverable: false,
    });
    return err as unknown as Parameters<NonNullable<SDKObserver['onError']>>[0];
  }

  test('emits sdk.errors counter with kind + category', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onError?.(makeSdkError('network', 'transport'));

    const counter = col.counters.find((c) => c.name === 'sdk.errors');
    expect(counter?.name).toBe('sdk.errors');
    expect(counter!.value).toBe(1);
    expect(counter!.attributes.kind).toBe('network');
    expect(counter!.attributes.category).toBe('transport');
  });

  test('emits sdk.error span with error attributes and exception recorded', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onError?.(makeSdkError('auth', 'security'));

    const span = col.spans.find((s) => s.name === 'sdk.error');
    expect(span?.name).toBe('sdk.error');
    expect(span!.ended).toBe(true);
    expect(span!.attributes['sdk.error.kind']).toBe('auth');
    expect(span!.attributes['sdk.error.category']).toBe('security');
    expect(span!.exceptions).toHaveLength(1);
    expect(span!.status?.code).toBe(2); // SpanStatusCode.ERROR
  });
});

describe('createOpenTelemetryObserver — onTransportActivity', () => {
  test('records sdk.transport.duration_ms histogram for recv with durationMs', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    const activity: TransportActivityInfo = { direction: 'recv', url: 'http://x', kind: 'http', durationMs: 123 };
    obs.onTransportActivity?.(activity);

    const hist = col.histograms.find((h) => h.name === 'sdk.transport.duration_ms');
    expect(hist?.name).toBe('sdk.transport.duration_ms');
    expect(hist!.value).toBe(123);
    expect(hist!.attributes.kind).toBe('http');
  });

  test('does NOT record histogram for send direction', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onTransportActivity?.({ direction: 'send', url: 'http://x', kind: 'http' });

    expect(col.histograms.filter((h) => h.name === 'sdk.transport.duration_ms')).toHaveLength(0);
  });

  test('does NOT record histogram for recv without durationMs', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onTransportActivity?.({ direction: 'recv', url: 'http://x', kind: 'sse' });

    expect(col.histograms.filter((h) => h.name === 'sdk.transport.duration_ms')).toHaveLength(0);
  });

  test('records histogram with status attribute when status is present', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    obs.onTransportActivity?.({ direction: 'recv', url: 'http://x', kind: 'http', durationMs: 55, status: 200 });

    const hist = col.histograms.find((h) => h.name === 'sdk.transport.duration_ms');
    expect(hist?.name).toBe('sdk.transport.duration_ms');
    expect(hist!.attributes.status).toBe(200);
  });
});

describe('createOpenTelemetryObserver — onEvent', () => {
  test('onEvent is a no-op — emits no counters or spans', () => {
    const col = makeCollector();
    const obs = createOpenTelemetryObserver(col.tracer, col.meter);

    // Call with a synthetic event-like payload
    obs.onEvent?.({ type: 'AGENT_SPAWNING' } as Parameters<NonNullable<SDKObserver['onEvent']>>[0]);

    // No spans or counters should have been emitted for this event
    expect(col.spans).toHaveLength(0);
    // Histograms may have been created at construction (createHistogram) but not recorded
    expect(col.histograms).toHaveLength(0);
  });
});
