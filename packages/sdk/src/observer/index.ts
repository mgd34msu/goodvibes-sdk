/**
 * SDKObserver — first-class observability hooks for the GoodVibes SDK.
 *
 * Consumers can implement any subset of `SDKObserver` and pass the instance
 * via the `observer` option on supported client factories. All methods are
 * optional; the SDK works identically whether an observer is present or not.
 *
 * Observer call sites are wrapped through `invokeObserver`: an observer that
 * throws will not propagate into SDK logic. This is intentional because observer
 * errors must never break the SDK flow.
 *
 * @example
 * const sdk = createGoodVibesSdk({
 *   baseUrl: 'https://daemon.example.com',
 *   tokenStore: createMemoryTokenStore(),
 *   observer: createConsoleObserver({ level: 'debug' }),
 * });
 */

const SPAN_STATUS_ERROR = 2 as const; // OpenTelemetry SpanStatusCode.ERROR

import type { GoodVibesSdkError } from '@pellux/goodvibes-errors';
import type { AnyRuntimeEvent } from '../events/domain-map.js';
import type { TransportObserver, TransportActivityInfo } from '@pellux/goodvibes-transport-core';

export type { AnyRuntimeEvent };

/**
 * The auth state kind used in transition notifications.
 * - `'anonymous'` — no credentials present
 * - `'session'` — session-cookie or short-lived token
 * - `'token'` — long-lived bearer token
 */
export type AuthStateKind = 'anonymous' | 'session' | 'token';

/**
 * The reason an auth transition occurred.
 */
export type AuthTransitionReason = 'login' | 'logout' | 'refresh' | 'expire' | 'revoke';

/**
 * Re-export TransportActivityInfo from transport-core so SDK consumers
 * don't need to import from an internal package.
 */
export type { TransportActivityInfo } from '@pellux/goodvibes-transport-core';

/**
 * Auth transition metadata surfaced to the observer.
 */
export interface AuthTransitionInfo {
  readonly from: AuthStateKind;
  readonly to: AuthStateKind;
  readonly reason: AuthTransitionReason;
}

/**
 * Optional observer interface. Implement any subset of methods and pass the
 * instance to a supported client factory. All methods are optional.
 *
 * Every call site should go through `invokeObserver` so observer errors are
 * isolated from SDK control flow.
 */
// SDKObserver extends TransportObserver which contributes:
//   onTransportActivity?(info: TransportActivityInfo): void
// See @pellux/goodvibes-transport-core for the inherited member definition.
export interface SDKObserver extends TransportObserver {
  /**
   * Called for every event dispatched through the realtime transport
   * (SSE or WebSocket). Receives the fully-typed runtime event payload.
   *
   * Wired as of 0.19.7 — fires on every envelope dispatched through
   * `createEventSourceConnector` and `createWebSocketConnector`.
   */
  onEvent?(event: AnyRuntimeEvent): void;

  /**
   * Called when the SDK catches and is about to rethrow a GoodVibesSdkError.
   * The error is still rethrown; this is notification only.
   *
   * Wired as of 0.19.7 — fires at every `GoodVibesSdkError` throw site in
   * the transport and auth layers before the error propagates to the caller.
   */
  onError?(err: GoodVibesSdkError): void;

  /**
   * Called at HTTP/SSE/WebSocket transport boundaries.
   * - `'send'` fires before the request is dispatched.
   * - `'recv'` fires after a response is received (with status + duration).
   *
   * Wired as of 0.19.7 — fires in `transport-http` request/response boundary
   * and in realtime connect/message boundaries.
   */
  onTransportActivity?(activity: TransportActivityInfo): void;

  /**
   * Called when the SDK's auth state transitions (login, logout, token
   * refresh, expiry, or revocation).
   */
  onAuthTransition?(transition: AuthTransitionInfo): void;
}

/**
 * Safely invoke an observer method. Observer errors are swallowed so they
 * never disrupt SDK control flow. This is the canonical call pattern for
 * all observer call sites throughout the SDK.
 *
 * @param fn - Zero-argument thunk wrapping the observer call.
 */
export function invokeObserver(fn: () => void): void {
  try {
    fn();
  } catch {
    // Observer errors must not propagate into SDK logic.
    // Observers are passive listeners; they have no authority to break flows.
  }
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------

export interface ConsoleObserverOptions {
  /** Minimum log level. Defaults to `'info'`. */
  readonly level?: 'debug' | 'info';
}

/**
 * Create a development-friendly observer that logs SDK activity to the console.
 *
 * Use `level: 'debug'` to also log transport activity and every runtime event.
 *
 * @example
 * const sdk = createGoodVibesSdk({
 *   baseUrl: '...',
 *   observer: createConsoleObserver({ level: 'debug' }),
 * });
 */
export function createConsoleObserver(
  options: ConsoleObserverOptions = {},
): SDKObserver {
  const level = options.level ?? 'info';

  return {
    /* eslint-disable no-console */
    onAuthTransition(transition) {
      console.log(
        `[sdk:observer] auth transition ${transition.from} → ${transition.to} (${transition.reason})`,
      );
    },
    onError(err) {
      console.error(
        `[sdk:observer] error kind=${err.kind} category=${err.category}`,
        err.message,
      );
    },
    onTransportActivity(activity) {
      if (level !== 'debug') return;
      const status = activity.status !== undefined ? ` status=${activity.status}` : '';
      const dur = activity.durationMs !== undefined ? ` ${activity.durationMs}ms` : '';
      console.debug(
        `[sdk:observer] transport ${activity.direction} ${activity.kind ?? 'http'} ${activity.url}${status}${dur}`,
      );
    },
    onEvent(event) {
      if (level !== 'debug') return;
      console.debug(`[sdk:observer] event ${event.type}`);
    },
    /* eslint-enable no-console */
  };
}

/**
 * Accept-only OpenTelemetry types so we don't add a hard dependency on
 * `@opentelemetry/*`. Consumers bring their own tracer and meter.
 */
export interface OtelTracer {
  startActiveSpan<F extends (span: OtelSpan) => unknown>(name: string, fn: F): ReturnType<F>;
  startSpan(name: string, options?: unknown): OtelSpan;
}

export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: number; message?: string }): this;
  recordException(error: Error | unknown): this;
  end(): void;
}

export interface OtelMeter {
  createCounter(name: string, options?: { description?: string }): OtelCounter;
  createHistogram(name: string, options?: { description?: string; unit?: string }): OtelHistogram;
}

export interface OtelCounter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface OtelHistogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

/**
 * Create an observer that emits OpenTelemetry spans and metrics.
 *
 * Pass a pre-configured `Tracer` and `Meter` from your OpenTelemetry SDK setup.
 * This adapter has no hard dependency on `@opentelemetry/*` — it accepts the
 * abstractions defined above, which match the subset of the real
 * OpenTelemetry API.
 *
 * @example
 * import { trace, metrics } from '@opentelemetry/api';
 *
 * const observer = createOpenTelemetryObserver(
 *   trace.getTracer('goodvibes-sdk'),
 *   metrics.getMeter('goodvibes-sdk'),
 * );
 * const sdk = createGoodVibesSdk({ baseUrl: '...', observer });
 */
export function createOpenTelemetryObserver(
  tracer: OtelTracer,
  meter: OtelMeter,
): SDKObserver {
  const authCounter = meter.createCounter('sdk.auth.transitions', {
    description: 'Number of SDK auth state transitions',
  });
  const errorCounter = meter.createCounter('sdk.errors', {
    description: 'Number of SDK errors observed',
  });
  const transportHistogram = meter.createHistogram('sdk.transport.duration_ms', {
    description: 'SDK transport call duration',
    unit: 'ms',
  });

  return {
    onAuthTransition(transition) {
      authCounter.add(1, {
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
      });
      const span = tracer.startSpan('sdk.auth.transition');
      span.setAttribute('sdk.auth.from', transition.from);
      span.setAttribute('sdk.auth.to', transition.to);
      span.setAttribute('sdk.auth.reason', transition.reason);
      span.end();
    },
    onError(err) {
      errorCounter.add(1, { kind: err.kind, category: err.category });
      const span = tracer.startSpan('sdk.error');
      span.setAttribute('sdk.error.kind', err.kind);
      span.setAttribute('sdk.error.category', err.category);
      span.setAttribute('sdk.error.recoverable', err.recoverable);
      span.recordException(err);
      span.setStatus({ code: SPAN_STATUS_ERROR, message: err.message });
      span.end();
    },
    onTransportActivity(activity) {
      if (activity.direction !== 'recv') return; // only record completed calls
      if (activity.durationMs !== undefined) {
        transportHistogram.record(activity.durationMs, {
          kind: activity.kind ?? 'http',
          ...(activity.status !== undefined && { status: activity.status }),
        });
      }
    },
    onEvent(_event) {
      // Event counting is high-cardinality; consumers can add their own meter
      // by wrapping this observer if they need per-event metrics.
    },
  };
}
