/**
 * otlp-ingest-e2e.test.ts
 *
 * F7 end-to-end ingestion tests. Proves that:
 *
 *   1. POSTing to /api/v1/telemetry/otlp/v1/{logs|traces|metrics} via a
 *      real DaemonHttpRouter returns 200.
 *   2. After the POST the ingested records are observable on
 *      GET /api/v1/telemetry/events via the same DaemonHttpRouter.
 *
 * This locks the full pipeline:
 *   Request → DaemonHttpRouter.dispatchApiRoutes
 *     → createDaemonTelemetryRouteHandlers (ingestSink = TelemetryApiService)
 *       → TelemetryApiService.ingestLogs / ingestTraces / ingestMetrics
 *         → record appended to this.records
 *           → GET /api/v1/telemetry/events returns the record
 *
 * Pattern: matches test/provider-routes-secrets-skipped.test.ts DaemonHttpRouter
 * section (lines 113-199).
 */

import { describe, expect, test } from 'bun:test';
import { DaemonHttpRouter } from '../packages/sdk/src/platform/daemon/http/router.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../packages/sdk/src/platform/runtime/store/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';

// ---------------------------------------------------------------------------
// Stubs — identical pattern to provider-routes-secrets-skipped.test.ts
// ---------------------------------------------------------------------------

function makeConfigManager(): ConfigManager {
  return { set: () => {}, get: () => undefined } as unknown as ConfigManager;
}

function makeProviderRegistry(): ProviderRegistry {
  return {
    listModels: () => [],
    getCurrentModel: () => { throw new Error('no model'); },
    getConfiguredProviderIds: () => [],
    setCurrentModel: () => {},
  } as unknown as ProviderRegistry;
}

/**
 * Build a minimal DaemonHttpRouter context sufficient to exercise the
 * telemetry OTLP POST and GET /events routes. All fields not exercised
 * by those code paths are stubbed with `{} as never` or no-op functions.
 *
 * The critical fields are:
 *   - runtimeBus + runtimeStore  → TelemetryApiService is constructed
 *   - checkAuth / extractAuthToken / describeAuthenticatedPrincipal → auth
 */
function makeRouter(): { router: DaemonHttpRouter; dispose: () => void } {
  const bus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const configManager = makeConfigManager();
  const providerRegistry = makeProviderRegistry();

  const SHARED_TOKEN = 'test-shared-token';

  const routerContext = {
    configManager,
    serviceRegistry: {} as never,
    userAuth: {} as never,
    agentManager: {} as never,
    automationManager: {} as never,
    approvalBroker: {} as never,
    controlPlaneGateway: {
      createEventStream: () => { throw new Error('not expected'); },
      recordApiRequest: () => {},
    } as never,
    gatewayMethods: {} as never,
    providerRegistry,
    sessionBroker: {} as never,
    routeBindings: {} as never,
    channelPolicy: {} as never,
    channelPlugins: {} as never,
    surfaceRegistry: {} as never,
    distributedRuntime: {} as never,
    watcherRegistry: {} as never,
    voiceService: {} as never,
    webSearchService: {} as never,
    knowledgeService: {} as never,
    knowledgeGraphqlService: {} as never,
    mediaProviders: {} as never,
    multimodalService: {} as never,
    artifactStore: {} as never,
    memoryRegistry: {} as never,
    memoryEmbeddingRegistry: {} as never,
    platformServiceManager: {} as never,
    integrationHelpers: null,
    runtimeBus: bus,
    runtimeStore: store,
    runtimeDispatch: null,
    githubWebhookSecret: null,
    authToken: () => SHARED_TOKEN,
    buildSurfaceAdapterContext: () => { throw new Error('not expected'); },
    buildGenericWebhookAdapterContext: () => { throw new Error('not expected'); },
    checkAuth: (req: Request) => {
      const auth = req.headers.get('authorization') ?? '';
      return auth === `Bearer ${SHARED_TOKEN}`;
    },
    extractAuthToken: (req: Request): string => {
      const auth = req.headers.get('authorization') ?? '';
      return auth.startsWith('Bearer ') ? auth.slice(7) : '';
    },
    requireAuthenticatedSession: () => null,
    requireAdmin: () => null,
    requireRemotePeer: async () => { throw new Error('not expected'); },
    describeAuthenticatedPrincipal: (token: string) => {
      if (token !== SHARED_TOKEN) return null;
      return {
        principalId: 'test-operator',
        principalKind: 'service' as const,
        admin: true,
        scopes: ['read:telemetry', 'read:telemetry-sensitive'],
      };
    },
    invokeGatewayMethodCall: async () => { throw new Error('not expected'); },
    queueSurfaceReplyFromBinding: () => {},
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    trySpawnAgent: () => { throw new Error('not expected'); },
    companionChatManager: null,
    secretsManager: null,
    swapManager: null,
  };

  const router = new DaemonHttpRouter(routerContext as never);
  return { router, dispose: () => router.dispose() };
}

function jsonIngestRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-shared-token',
    },
    body: JSON.stringify(body),
  });
}

function eventsRequest(): Request {
  return new Request('http://localhost/api/v1/telemetry/events', {
    method: 'GET',
    headers: { authorization: 'Bearer test-shared-token' },
  });
}

// ---------------------------------------------------------------------------
// E2E: POST logs → GET /events
// ---------------------------------------------------------------------------

describe('F7 E2E — DaemonHttpRouter: OTLP logs ingest → observable on GET /events', () => {
  test('POST /api/v1/telemetry/otlp/v1/logs returns 200 and records appear on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      // Step 1: ingest a log batch
      const postReq = jsonIngestRequest(
        'http://localhost/api/v1/telemetry/otlp/v1/logs',
        {
          resourceLogs: [{
            scopeLogs: [{
              logRecords: [{
                timeUnixNano: Date.now() * 1_000_000,
                severityText: 'INFO',
                body: { stringValue: 'hello from OTLP' },
              }],
            }],
          }],
        },
      );
      const postRes = await router.dispatchApiRoutes(postReq);
      expect(postRes).not.toBeNull();
      expect(postRes!.status).toBe(200);
      const postBody = await postRes!.json() as Record<string, unknown>;
      expect(postBody).toHaveProperty('partialSuccess');

      // Step 2: read back via GET /api/v1/telemetry/events
      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes).not.toBeNull();
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events']) as unknown[];
      expect(items).toBeInstanceOf(Array);
      // At least one record with source 'otlp-ingest' and type 'OTLP_LOG_INGEST'
      const ingested = (items as Array<Record<string, unknown>>).filter(
        (r) => r['source'] === 'otlp-ingest' && r['type'] === 'OTLP_LOG_INGEST',
      );
      expect(ingested).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test('empty resourceLogs POST still returns 200 (no-op ingest)', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] }),
      );
      expect(postRes!.status).toBe(200);
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: POST traces → GET /events
// ---------------------------------------------------------------------------

describe('F7 E2E — DaemonHttpRouter: OTLP traces ingest → observable on GET /events', () => {
  test('POST /api/v1/telemetry/otlp/v1/traces returns 200 and sentinel record appears on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postReq = jsonIngestRequest(
        'http://localhost/api/v1/telemetry/otlp/v1/traces',
        {
          resourceSpans: [{
            scopeSpans: [{
              spans: [{
                traceId: 'aaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbb',
                name: 'test-span',
                startTimeUnixNano: Date.now() * 1_000_000,
                endTimeUnixNano: (Date.now() + 1) * 1_000_000,
              }],
            }],
          }],
        },
      );
      const postRes = await router.dispatchApiRoutes(postReq);
      expect(postRes).not.toBeNull();
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events']) as Array<Record<string, unknown>>;
      const ingested = items.filter((r) => r['type'] === 'OTLP_TRACE_INGEST');
      expect(ingested).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test('empty resourceSpans POST still returns 200', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] }),
      );
      expect(postRes!.status).toBe(200);
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: POST metrics → GET /events
// ---------------------------------------------------------------------------

describe('F7 E2E — DaemonHttpRouter: OTLP metrics ingest → observable on GET /events', () => {
  test('POST /api/v1/telemetry/otlp/v1/metrics returns 200 and sentinel record appears on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postReq = jsonIngestRequest(
        'http://localhost/api/v1/telemetry/otlp/v1/metrics',
        {
          resourceMetrics: [{
            scopeMetrics: [{
              metrics: [{
                name: 'test.counter',
                sum: { dataPoints: [{ asDouble: 42 }] },
              }],
            }],
          }],
        },
      );
      const postRes = await router.dispatchApiRoutes(postReq);
      expect(postRes).not.toBeNull();
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events']) as Array<Record<string, unknown>>;
      const ingested = items.filter((r) => r['type'] === 'OTLP_METRICS_INGEST');
      expect(ingested).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test('empty resourceMetrics POST still returns 200', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] }),
      );
      expect(postRes!.status).toBe(200);
    } finally {
      dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// B5 — Sentinel gating: empty payloads must NOT produce observability events
// ---------------------------------------------------------------------------

describe('F7 E2E — Sentinel gating: empty payloads do not emit events', () => {
  test('empty resourceSpans → 200 but no OTLP_TRACE_INGEST on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', { resourceSpans: [] }),
      );
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events'] ?? []) as Array<Record<string, unknown>>;
      const sentinels = items.filter((r) => r['type'] === 'OTLP_TRACE_INGEST');
      expect(sentinels.length).toBe(0);
    } finally {
      dispose();
    }
  });

  test('non-empty resourceSpans → 200 and OTLP_TRACE_INGEST appears on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/traces', {
          resourceSpans: [{
            scopeSpans: [{
              spans: [{
                traceId: 'cccccccccccccccc',
                spanId: 'dddddddd',
                name: 'sentinel-gate-test',
                startTimeUnixNano: Date.now() * 1_000_000,
                endTimeUnixNano: (Date.now() + 1) * 1_000_000,
              }],
            }],
          }],
        }),
      );
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events'] ?? []) as Array<Record<string, unknown>>;
      const sentinels = items.filter((r) => r['type'] === 'OTLP_TRACE_INGEST');
      expect(sentinels).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test('empty resourceMetrics → 200 but no OTLP_METRICS_INGEST on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', { resourceMetrics: [] }),
      );
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events'] ?? []) as Array<Record<string, unknown>>;
      const sentinels = items.filter((r) => r['type'] === 'OTLP_METRICS_INGEST');
      expect(sentinels.length).toBe(0);
    } finally {
      dispose();
    }
  });

  test('non-empty resourceMetrics → 200 and OTLP_METRICS_INGEST appears on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/metrics', {
          resourceMetrics: [{
            scopeMetrics: [{
              metrics: [{
                name: 'sentinel.gate.test',
                sum: { dataPoints: [{ asDouble: 1 }] },
              }],
            }],
          }],
        }),
      );
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events'] ?? []) as Array<Record<string, unknown>>;
      const sentinels = items.filter((r) => r['type'] === 'OTLP_METRICS_INGEST');
      expect(sentinels).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  test('empty resourceLogs → 200 but no OTLP_LOG_INGEST on GET /events', async () => {
    const { router, dispose } = makeRouter();
    try {
      const postRes = await router.dispatchApiRoutes(
        jsonIngestRequest('http://localhost/api/v1/telemetry/otlp/v1/logs', { resourceLogs: [] }),
      );
      expect(postRes!.status).toBe(200);

      const getRes = await router.dispatchApiRoutes(eventsRequest());
      expect(getRes!.status).toBe(200);
      const getBody = await getRes!.json() as Record<string, unknown>;
      const items = (getBody['items'] ?? getBody['events'] ?? []) as Array<Record<string, unknown>>;
      const sentinels = items.filter((r) => r['type'] === 'OTLP_LOG_INGEST');
      expect(sentinels.length).toBe(0);
    } finally {
      dispose();
    }
  });
});
