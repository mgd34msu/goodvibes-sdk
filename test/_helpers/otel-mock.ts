/**
 * Shared OTel mock helper extracted from observer-coverage.test.ts.
 * Import in any test that needs a mock OtelTracer/OtelMeter.
 */
import type {
  OtelTracer,
  OtelMeter,
  OtelSpan,
} from '../../packages/sdk/src/observer/index.js';

export interface MockOtelResult {
  tracer: OtelTracer;
  meter: OtelMeter;
  spans: Array<{ name: string; attrs: Record<string, unknown>; ended: boolean; exceptions: unknown[]; status?: unknown }>;
  counters: Array<{ name: string; value: number; attrs?: Record<string, unknown> }>;
  histRecords: Array<{ value: number; attrs?: Record<string, unknown> }>;
}

export function makeMockOtel(): MockOtelResult {
  const spans: MockOtelResult['spans'] = [];
  const counters: MockOtelResult['counters'] = [];
  const histRecords: MockOtelResult['histRecords'] = [];

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
