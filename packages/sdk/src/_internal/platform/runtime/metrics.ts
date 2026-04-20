/**
 * OBS-12: RuntimeMeter production wiring for the goodvibes-sdk platform.
 *
 * Exposes named metric instruments used across the platform:
 * - HTTP request counters and histograms
 * - LLM request counters and histograms
 * - Auth success/failure counters
 * - Session and SSE subscriber gauges
 * - Telemetry buffer fill gauge
 */
import { RuntimeMeter } from './telemetry/meter.js';

/** Singleton RuntimeMeter instance for the platform. */
export const platformMeter = new RuntimeMeter({ scope: 'goodvibes-sdk' });

// ── HTTP metrics ─────────────────────────────────────────────────────────────

/** Counter: total HTTP requests by method and status_class (2xx, 4xx, 5xx). */
export const httpRequestsTotal = platformMeter.counter('http.requests.total');
/** Histogram: HTTP request latency in ms by method, path_pattern, status_class. */
export const httpRequestDurationMs = platformMeter.histogram('http.request.duration_ms');

// ── LLM metrics ──────────────────────────────────────────────────────────────

/** Counter: total LLM requests started by provider, model (emitted on entry, before the call). */
export const llmRequestsStarted = platformMeter.counter('llm.requests.started');
/** Counter: total LLM requests by provider, model, status (success/error). */
export const llmRequestsTotal = platformMeter.counter('llm.requests.total');
/** Histogram: LLM request latency in ms by provider, model. */
export const llmRequestDurationMs = platformMeter.histogram('llm.request.duration_ms');
/** Histogram: LLM input token counts by provider, model. */
export const llmTokensInput = platformMeter.histogram('llm.tokens.input');
/** Histogram: LLM output token counts by provider, model. */
export const llmTokensOutput = platformMeter.histogram('llm.tokens.output');

// ── Auth metrics ─────────────────────────────────────────────────────────────

/** Counter: successful auth events. */
export const authSuccessTotal = platformMeter.counter('auth.success.total');
/** Counter: failed auth events. */
export const authFailureTotal = platformMeter.counter('auth.failure.total');

// ── Session and SSE metrics ───────────────────────────────────────────────────

/** Gauge: currently active sessions. */
export const sessionsActive = platformMeter.gauge('sessions.active');
/** Gauge: current SSE subscriber count per stream type. */
export const sseSubscribers = platformMeter.gauge('sse.subscribers');

// ── Transport metrics ─────────────────────────────────────────────────────────

/** Counter: total transport retries by transport_type and reason. */
export const transportRetriesTotal = platformMeter.counter('transport.retries_total');

// ── Telemetry buffer metrics ──────────────────────────────────────────────────

/** Gauge: fill level of the telemetry buffer (0..1). */
export const telemetryBufferFill = platformMeter.gauge('telemetry.buffer.fill');

/**
 * OBS-12: Snapshot all metric instruments as a JSON-serialisable object.
 * Used by the GET /api/runtime/metrics endpoint.
 *
 * C-3: includes histograms section with count/sum/min/max/mean per instrument.
 */
export function snapshotMetrics(): Record<string, unknown> {
  return {
    counters: {
      'http.requests.total': {
        '2xx': httpRequestsTotal.value({ status_class: '2xx' }),
        '4xx': httpRequestsTotal.value({ status_class: '4xx' }),
        '5xx': httpRequestsTotal.value({ status_class: '5xx' }),
      },
      'llm.requests.total': {
        success: llmRequestsTotal.value({ status: 'success' }),
        error: llmRequestsTotal.value({ status: 'error' }),
      },
      'auth.success.total': authSuccessTotal.value(),
      'auth.failure.total': authFailureTotal.value(),
      'transport.retries_total': transportRetriesTotal.value(),
    },
    gauges: {
      'sessions.active': sessionsActive.value(),
      'sse.subscribers': sseSubscribers.value(),
      'telemetry.buffer.fill': telemetryBufferFill.value(),
    },
    histograms: {
      'http.request.duration_ms': httpRequestDurationMs.snapshot(),
      'llm.request.duration_ms': llmRequestDurationMs.snapshot(),
      'llm.tokens.input': llmTokensInput.snapshot(),
      'llm.tokens.output': llmTokensOutput.snapshot(),
    },
    // Legacy shape — kept for backward compat with existing consumers
    http: {
      requests_total: {
        '2xx': httpRequestsTotal.value({ status_class: '2xx' }),
        '4xx': httpRequestsTotal.value({ status_class: '4xx' }),
        '5xx': httpRequestsTotal.value({ status_class: '5xx' }),
      },
    },
    llm: {
      requests_total: {
        success: llmRequestsTotal.value({ status: 'success' }),
        error: llmRequestsTotal.value({ status: 'error' }),
      },
    },
    auth: {
      success_total: authSuccessTotal.value(),
      failure_total: authFailureTotal.value(),
    },
    sessions: {
      active: sessionsActive.value(),
    },
    sse: {
      subscribers: sseSubscribers.value(),
    },
    transport: {
      retries_total: transportRetriesTotal.value(),
    },
    telemetry: {
      buffer_fill: telemetryBufferFill.value(),
    },
  };
}
