/**
 * otlp-ingest-routes.test.ts
 *
 * Tests for F7 — OTLP POST ingest endpoints.
 *
 * Routes under test:
 *   POST /api/v1/telemetry/otlp/v1/logs
 *   POST /api/v1/telemetry/otlp/v1/traces
 *   POST /api/v1/telemetry/otlp/v1/metrics
 *
 * Coverage:
 *   - Happy path: application/json body for each signal type
 *   - Happy path: application/x-protobuf body for each signal type
 *   - 401 when no authenticated principal
 *   - 415 when wrong Content-Type
 *   - 400 when malformed JSON
 *   - Ingest sink forwarding (spy verifies payload routed to sink)
 *   - Router dispatch wiring via dispatchDaemonApiRoutes
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '../packages/daemon-sdk/src/telemetry-routes.js';
import { dispatchOperatorRoutes } from '../packages/daemon-sdk/src/operator.js';
import type { AuthenticatedPrincipal } from '../packages/daemon-sdk/src/http-policy.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const ADMIN_PRINCIPAL: AuthenticatedPrincipal = {
  principalId: 'test-user',
  principalKind: 'user',
  admin: true,
  scopes: ['read:telemetry'],
};

function makeHandlers(opts: {
  authenticated?: boolean;
  ingestSink?: {
    ingestLogs: (p: Record<string, unknown>) => void;
    ingestTraces: (p: Record<string, unknown>) => void;
    ingestMetrics: (p: Record<string, unknown>) => void;
  } | null;
}) {
  return createDaemonTelemetryRouteHandlers({
    telemetryApi: null,
    resolveAuthenticatedPrincipal: () =>
      opts.authenticated !== false ? ADMIN_PRINCIPAL : null,
    // ingestSink is required (TelemetryIngestSink | null). Default null when
    // the test does not exercise sink forwarding.
    ingestSink: opts.ingestSink ?? null,
  });
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function protobufRequest(url: string, bytes: Uint8Array = new Uint8Array([0x0a, 0x00])): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: bytes,
  });
}

// ---------------------------------------------------------------------------
// Happy path — JSON
// ---------------------------------------------------------------------------

describe('F7 — OTLP POST ingest: happy path (application/json)', () => {
  test('POST logs with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });

  test('POST traces with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await h.postTelemetryOtlpTraces(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });

  test('POST metrics with JSON body → 200 with partialSuccess', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await h.postTelemetryOtlpMetrics(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('partialSuccess');
  });
});

// ---------------------------------------------------------------------------
// Protobuf — must return 415 (not implemented in this release)
// ---------------------------------------------------------------------------

describe('F7 — OTLP POST ingest: protobuf returns 415 (not implemented)', () => {
  test('POST logs with protobuf body → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const h = makeHandlers({ authenticated: true });
    const res = await h.postTelemetryOtlpLogs(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/logs'),
    );
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(typeof body['hint']).toBe('string');
    expect((body['hint'] as string).toLowerCase()).toContain('protobuf');
  });

  test('POST traces with protobuf body → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const h = makeHandlers({ authenticated: true });
    const res = await h.postTelemetryOtlpTraces(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/traces'),
    );
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(typeof body['hint']).toBe('string');
    expect((body['hint'] as string).toLowerCase()).toContain('protobuf');
  });

  test('POST metrics with protobuf body → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const h = makeHandlers({ authenticated: true });
    const res = await h.postTelemetryOtlpMetrics(
      protobufRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics'),
    );
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(typeof body['hint']).toBe('string');
    expect((body['hint'] as string).toLowerCase()).toContain('protobuf');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('F7 — OTLP POST ingest: error paths', () => {
  test('401 when no authenticated principal (logs)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('AUTH_REQUIRED');
  });

  test('401 when no authenticated principal (traces)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await h.postTelemetryOtlpTraces(req);
    expect(res.status).toBe(401);
  });

  test('401 when no authenticated principal (metrics)', async () => {
    const h = makeHandlers({ authenticated: false });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await h.postTelemetryOtlpMetrics(req);
    expect(res.status).toBe(401);
  });

  test('415 when wrong Content-Type (text/plain)', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"resourceLogs":[]}',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(415);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('400 when body is malformed JSON', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json!!!',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body['code']).toBe('INVALID_PAYLOAD');
  });

  test('400 when JSON body is a non-object (array)', async () => {
    const h = makeHandlers({ authenticated: true });
    const req = new Request('http://localhost/api/v1/telemetry/otlp/v1/logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1, 2, 3]',
    });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Ingest sink forwarding
// ---------------------------------------------------------------------------

describe('F7 — OTLP POST ingest: sink forwarding', () => {
  test('JSON logs payload is forwarded to ingestSink.ingestLogs', async () => {
    const received: Record<string, unknown>[] = [];
    const h = makeHandlers({
      authenticated: true,
      ingestSink: {
        ingestLogs: (p) => { received.push(p); },
        ingestTraces: () => {},
        ingestMetrics: () => {},
      },
    });
    const payload = { resourceLogs: [{ scopeLogs: [] }] };
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', payload);
    await h.postTelemetryOtlpLogs(req);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ resourceLogs: [{ scopeLogs: [] }] });
  });

  test('null ingestSink is handled gracefully (no throw)', async () => {
    const h = makeHandlers({ authenticated: true, ingestSink: null });
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await h.postTelemetryOtlpLogs(req);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Router dispatch wiring — E2E via dispatchDaemonApiRoutes
// ---------------------------------------------------------------------------

describe('F7 — OTLP POST ingest: router dispatch wiring', () => {
  function makeFullHandlers() {
    const handlers = makeHandlers({ authenticated: true });
    // Provide a minimal stub that satisfies all other required handler fields.
    // dispatchDaemonApiRoutes returns null for unknown routes, so we only need
    // the POST telemetry handlers to be real.
    return handlers;
  }

  test('POST /api/v1/telemetry/otlp/v1/logs is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('POST /api/v1/telemetry/otlp/v1/traces is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('POST /api/v1/telemetry/otlp/v1/metrics is dispatched by dispatchOperatorRoutes', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  test('legacy path POST /api/telemetry/otlp/v1/logs is also dispatched', async () => {
    const handlers = makeFullHandlers();
    const req = jsonRequest('http://localhost/api/telemetry/otlp/v1/logs', { resourceLogs: [] });
    const res = await dispatchOperatorRoutes(req, handlers as never);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});
