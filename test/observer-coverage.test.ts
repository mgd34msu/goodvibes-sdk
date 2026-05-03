/**
 * Coverage backfill for packages/sdk/src/observer/index.ts
 *
 * Targets uncovered lines 147-165:
 * - createConsoleObserver debug-level: onTransportActivity, onEvent actually log
 * - createConsoleObserver onError actually logs
 * - createOpenTelemetryObserver: onError, onTransportActivity (recv with durationMs), onEvent
 */
import { describe, expect, test, mock } from 'bun:test';
import {
  createConsoleObserver,
  createOpenTelemetryObserver,
  invokeObserver,
} from '../packages/sdk/src/observer/index.js';
import type {
  OtelTracer,
  OtelMeter,
  OtelSpan,
} from '../packages/sdk/src/observer/index.js';
import { GoodVibesSdkError } from '../packages/errors/src/index.js';
import { captureConsole } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// createConsoleObserver — debug level exercises all callbacks
// ---------------------------------------------------------------------------

describe('createConsoleObserver — debug level', () => {
  test('onTransportActivity at debug level logs to console.debug (send — no status/dur)', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug');
    try {
      obs.onTransportActivity?.({ direction: 'send', url: 'http://localhost/api', kind: 'http' });
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0][0])).toMatch(/transport send http http:\/\/localhost\/api/);
    } finally {
      capture.restore();
    }
  });

  test('onTransportActivity at debug level logs status and duration when present', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug');
    try {
      obs.onTransportActivity?.({
        direction: 'recv',
        url: 'http://localhost/api',
        kind: 'http',
        status: 200,
        durationMs: 42,
      });
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0][0])).toMatch(/status=200/);
      expect(String(capture.messages[0][0])).toMatch(/42ms/);
    } finally {
      capture.restore();
    }
  });

  test('onTransportActivity at info level does NOT log', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('debug');
    try {
      obs.onTransportActivity?.({ direction: 'send', url: 'http://localhost/api', kind: 'http' });
      expect(capture.messages).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  test('onEvent at debug level logs to console.debug', () => {
    const obs = createConsoleObserver({ level: 'debug' });
    const capture = captureConsole('debug');
    try {
      obs.onEvent?.({ type: 'runtime.turn.start' } as Parameters<NonNullable<typeof obs.onEvent>>[0]);
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0][0])).toMatch(/event runtime.turn.start/);
    } finally {
      capture.restore();
    }
  });

  test('onEvent at info level does NOT log', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('debug');
    try {
      obs.onEvent?.({ type: 'runtime.turn.start' } as Parameters<NonNullable<typeof obs.onEvent>>[0]);
      expect(capture.messages).toHaveLength(0);
    } finally {
      capture.restore();
    }
  });

  test('onError logs kind and category to console.error', () => {
    const obs = createConsoleObserver({ level: 'info' });
    const capture = captureConsole('error');
    try {
      const err = new GoodVibesSdkError('test error', { category: 'rate_limit' });
      obs.onError?.(err);
      expect(capture.messages).toHaveLength(1);
      expect(String(capture.messages[0][0])).toMatch(/rate-limit/);
    } finally {
      capture.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// createOpenTelemetryObserver — all callback paths
// ---------------------------------------------------------------------------

function makeMockOtel(): {
  tracer: OtelTracer;
  meter: OtelMeter;
  spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; exceptions: unknown[]; status?: unknown }>;
  counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }>;
  histRecords: Array<{ value: number; attrs?: Record<string, unknown> }>;
} {
  const spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; exceptions: unknown[]; status?: unknown }> = [];
  const counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }> = [];
  const histRecords: Array<{ value: number; attrs?: Record<string, unknown> }> = [];

  function makeSpan(name: string): OtelSpan {
    const entry = { name, attrs: {} as Record<string, unknown>, ended: false, exceptions: [] as unknown[], status: undefined as unknown };
    spans.push(entry);
    return {
      setAttribute(key, value) { entry.attrs[key] = value; return this; },
      setStatus(s) { entry.status = s; return this; },
      recordException(e) { entry.exceptions.push(e); return this; },
      end() { entry.ended = true; },
    };
  }

  const tracer: OtelTracer = {
    startSpan: (name) => makeSpan(name),
    startActiveSpan: (name, fn) => {
      const span = makeSpan(name);
      return fn(span) as ReturnType<typeof fn>;
    },
  };

  const meter: OtelMeter = {
    createCounter: (name) => ({
      add: (value, attrs) => { counters.push({ name, value, attrs }); },
    }),
    createHistogram: (_name) => ({
      record: (value, attrs) => { histRecords.push({ value, attrs }); },
    }),
  };

  return { tracer, meter, spans, counters, histRecords };
}

describe('createOpenTelemetryObserver — onError', () => {
  test('onError increments error counter and ends span with ERROR status', () => {
    const { tracer, meter, spans, counters } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    const err = new GoodVibesSdkError('something failed', { category: 'rate_limit' });
    obs.onError?.(err);
    expect(counters.some((c) => c.name === 'sdk.errors' && c.value === 1)).toBe(true);
    const errSpan = spans.find((s) => s.name === 'sdk.error');
    expect(errSpan).toBeDefined();
    expect(errSpan!.ended).toBe(true);
    expect(errSpan!.attrs['sdk.error.kind']).toBe('rate-limit');
    expect(errSpan!.attrs['sdk.error.category']).toBe('rate_limit');
    expect(errSpan!.attrs['sdk.error.recoverable']).toBe(false);
    expect(errSpan!.exceptions).toContain(err);
    expect((errSpan!.status as { code: number }).code).toBe(2); // SPAN_STATUS_ERROR
  });
});

describe('createOpenTelemetryObserver — onTransportActivity', () => {
  test('recv with durationMs records histogram entry', () => {
    const { tracer, meter, histRecords } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    obs.onTransportActivity?.({
      direction: 'recv',
      url: 'http://localhost/api',
      kind: 'http',
      status: 200,
      durationMs: 55,
    });
    expect(histRecords).toHaveLength(1);
    expect(histRecords[0].value).toBe(55);
    expect((histRecords[0].attrs as Record<string, unknown>)['kind']).toBe('http');
    expect((histRecords[0].attrs as Record<string, unknown>)['status']).toBe(200);
  });

  test('recv without durationMs does NOT record histogram entry', () => {
    const { tracer, meter, histRecords } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    obs.onTransportActivity?.({
      direction: 'recv',
      url: 'http://localhost/api',
      kind: 'http',
    });
    expect(histRecords).toHaveLength(0);
  });

  test('send direction is skipped (does not record histogram)', () => {
    const { tracer, meter, histRecords } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    obs.onTransportActivity?.({
      direction: 'send',
      url: 'http://localhost/api',
      kind: 'http',
      durationMs: 10,
    });
    expect(histRecords).toHaveLength(0);
  });

  test('recv without status records histogram without status attribute', () => {
    const { tracer, meter, histRecords } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    obs.onTransportActivity?.({
      direction: 'recv',
      url: 'http://localhost/api',
      kind: 'sse',
      durationMs: 100,
    });
    expect(histRecords).toHaveLength(1);
    expect((histRecords[0].attrs as Record<string, unknown>)['kind']).toBe('sse');
    expect('status' in (histRecords[0].attrs ?? {})).toBe(false);
  });
});

describe('createOpenTelemetryObserver — onEvent', () => {
  test('onEvent is a no-op (does not throw, makes no span)', () => {
    const { tracer, meter, spans } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    const initialSpans = spans.length;
    expect(() => obs.onEvent?.({ type: 'runtime.turn.start' } as Parameters<NonNullable<typeof obs.onEvent>>[0])).not.toThrow();
    // onEvent is intentionally a no-op — no new spans
    expect(spans.length).toBe(initialSpans);
  });
});

describe('createOpenTelemetryObserver — onAuthTransition', () => {
  test('fires auth counter and span on transition', () => {
    const { tracer, meter, spans, counters } = makeMockOtel();
    const obs = createOpenTelemetryObserver(tracer, meter);
    obs.onAuthTransition?.({ from: 'anonymous', to: 'token', reason: 'login' });
    expect(counters.some((c) => c.name === 'sdk.auth.transitions' && c.value === 1)).toBe(true);
    const authSpan = spans.find((s) => s.name === 'sdk.auth.transition');
    expect(authSpan?.ended).toBe(true);
    expect(authSpan?.attrs['sdk.auth.from']).toBe('anonymous');
    expect(authSpan?.attrs['sdk.auth.to']).toBe('token');
    expect(authSpan?.attrs['sdk.auth.reason']).toBe('login');
  });
});

// ---------------------------------------------------------------------------
// invokeObserver — core behavior
// ---------------------------------------------------------------------------

describe('invokeObserver', () => {
  test('calls the provided thunk', () => {
    let called = false;
    invokeObserver(() => { called = true; });
    expect(called).toBe(true);
  });

  test('swallows errors thrown by the thunk', () => {
    expect(() => invokeObserver(() => { throw new Error('boom'); })).not.toThrow();
  });
});
