/**
 * router-e2e-telemetry.test.ts
 *
 * Router-level E2E tests for the telemetry route family.
 * Exercises createDaemonTelemetryRouteHandlers, which is then composed
 * with dispatchOperatorRoutes (the production wiring) to test:
 *   GET /api/telemetry          (getTelemetrySnapshot)
 *   GET /api/telemetry/events   (getTelemetryEvents)
 *   GET /api/v1/telemetry       (alias path)
 *
 * Two key scenarios:
 *   - Happy path: telemetryApi present → 200 JSON response
 *   - Failure path: telemetryApi null → 503 unavailable
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '../packages/sdk/src/_internal/daemon/telemetry-routes.js';
import { dispatchOperatorRoutes } from '../packages/sdk/src/_internal/daemon/operator.js';
import type { DaemonApiRouteHandlers } from '../packages/sdk/src/_internal/daemon/context.js';
import { makeDefaultDaemonHandlerStub } from './_helpers/daemon-stub-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, url: string): Request {
  return new Request(url, { method });
}

interface TelemetryApiStubSnapshot {
  generatedAt: number;
  view: string;
  rawAccessible: boolean;
  runtime: Record<string, unknown>;
  sessionMetrics: Record<string, unknown>;
  aggregates: Record<string, unknown>;
  events?: unknown[];
  errors?: unknown[];
  spans?: unknown[];
}

/**
 * Minimal TelemetryApiLike stub.
 */
function makeTelemetryApi(): {
  getSnapshot: (filter: unknown, view: string, rawAccessible: boolean) => TelemetryApiStubSnapshot;
  listEventPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  listErrorPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  listSpanPage: (filter: unknown, view: string, rawAccessible: boolean) => unknown;
  createStream: () => Response;
  buildOtlpTraceDocument: () => unknown;
  buildOtlpLogDocument: () => unknown;
  buildOtlpMetricDocument: () => unknown;
  ingestLogs: () => void;
  ingestTraces: () => void;
  ingestMetrics: () => void;
} {
  const snapshot: TelemetryApiStubSnapshot = {
    generatedAt: Date.now(),
    view: 'safe',
    rawAccessible: false,
    runtime: {},
    sessionMetrics: {},
    aggregates: {},
    events: [],
    errors: [],
    spans: [],
  };
  return {
    getSnapshot: (_filter, _view, _rawAccessible) => snapshot,
    listEventPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    listErrorPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    listSpanPage: (_filter, _view, _rawAccessible) => ({ items: [], cursor: null }),
    createStream: () => new Response('', { status: 200 }),
    buildOtlpTraceDocument: () => ({}),
    buildOtlpLogDocument: () => ({}),
    buildOtlpMetricDocument: () => ({}),
    ingestLogs: () => {},
    ingestTraces: () => {},
    ingestMetrics: () => {},
  };
}

/**
 * Build a full DaemonApiRouteHandlers stub using createDaemonTelemetryRouteHandlers
 * for the telemetry slice and makeDefaultDaemonHandlerStub for everything else.
 */
function makeTelemetryHandlers(
  opts: { telemetryApiPresent: boolean } = { telemetryApiPresent: true },
): DaemonApiRouteHandlers {
  const api = opts.telemetryApiPresent ? makeTelemetryApi() : null;

  // Provide a stub principal with read:telemetry scope so the auth guard passes.
  // The telemetry routes always require an authenticated principal — null returns 401.
  const stubPrincipal = {
    principalId: 'test-principal',
    principalKind: 'token' as const,
    admin: false,
    scopes: ['read:telemetry'] as readonly string[],
  };

  const telemetryHandlers = createDaemonTelemetryRouteHandlers({
    telemetryApi: api as never,
    resolveAuthenticatedPrincipal: () => stubPrincipal,
    ingestSink: api as never,
  });

  return makeDefaultDaemonHandlerStub({
    getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
    ...telemetryHandlers,
  });
}

// ---------------------------------------------------------------------------
// describe: telemetry routes — happy paths
// ---------------------------------------------------------------------------

describe('router-e2e telemetry — GET /api/telemetry (happy path)', () => {
  test('returns 200 with snapshot shape when telemetryApi is present', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const req = makeRequest('GET', 'http://localhost/api/telemetry');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe('number');
    expect(body.view).toBeDefined();
  });

  test('GET /api/v1/telemetry alias returns same 200 shape', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const req = makeRequest('GET', 'http://localhost/api/v1/telemetry');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(typeof body.generatedAt).toBe('number');
  });

  test('GET /api/telemetry/events returns event page', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: true });
    const req = makeRequest('GET', 'http://localhost/api/telemetry/events');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('GET /api/telemetry/events bounds since, until, and limit filters', async () => {
    let capturedFilter: Record<string, unknown> | null = null;
    const api = {
      ...makeTelemetryApi(),
      listEventPage: (filter: unknown) => {
        capturedFilter = filter as Record<string, unknown>;
        return { items: [], cursor: null };
      },
    };
    const telemetryHandlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: api as never,
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'test-principal',
        principalKind: 'token' as const,
        admin: false,
        scopes: ['read:telemetry'] as readonly string[],
      }),
      ingestSink: api as never,
    });
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
      ...telemetryHandlers,
    });
    const req = makeRequest('GET', 'http://localhost/api/telemetry/events?limit=999999&since=-12.8&until=410244480000000');
    const res = await dispatchOperatorRoutes(req, handlers);

    expect(res?.status).toBe(200);
    if (!capturedFilter) throw new Error('Telemetry filter was not captured');
    expect(capturedFilter.limit).toBe(1000);
    expect(capturedFilter.since).toBe(0);
    expect(capturedFilter.until).toBe(Date.UTC(2100, 0, 1));
  });

  test('GET /api/telemetry/events omits non-finite timestamp filters', async () => {
    let capturedFilter: Record<string, unknown> | null = null;
    const api = {
      ...makeTelemetryApi(),
      listEventPage: (filter: unknown) => {
        capturedFilter = filter as Record<string, unknown>;
        return { items: [], cursor: null };
      },
    };
    const telemetryHandlers = createDaemonTelemetryRouteHandlers({
      telemetryApi: api as never,
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'test-principal',
        principalKind: 'token' as const,
        admin: false,
        scopes: ['read:telemetry'] as readonly string[],
      }),
      ingestSink: api as never,
    });
    const handlers = makeDefaultDaemonHandlerStub({
      getControlPlaneWeb: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      getControlPlaneRecentEvents: (_limit) => Response.json({ events: [] }),
      ...telemetryHandlers,
    });
    const req = makeRequest('GET', 'http://localhost/api/telemetry/events?since=Infinity&until=not-a-date');
    const res = await dispatchOperatorRoutes(req, handlers);

    expect(res?.status).toBe(200);
    if (!capturedFilter) throw new Error('Telemetry filter was not captured');
    expect(capturedFilter).not.toHaveProperty('since');
    expect(capturedFilter).not.toHaveProperty('until');
  });
});

// ---------------------------------------------------------------------------
// describe: telemetry routes — failure paths (telemetryApi absent)
// ---------------------------------------------------------------------------

describe('router-e2e telemetry — failure paths (telemetryApi null)', () => {
  test('returns 503 when telemetryApi is null', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: false });
    const req = makeRequest('GET', 'http://localhost/api/telemetry');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    // The unavailable() helper returns 503
    expect(res!.status).toBe(503);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.error).toBeDefined();
  });

  test('GET /api/telemetry/events returns 503 when telemetryApi is null', async () => {
    const handlers = makeTelemetryHandlers({ telemetryApiPresent: false });
    const req = makeRequest('GET', 'http://localhost/api/telemetry/events');
    const res = await dispatchOperatorRoutes(req, handlers);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
  });
});
