import { describe, expect, test } from 'bun:test';
import {
  createDaemonChannelRouteHandlers,
  createDaemonControlRouteHandlers,
  createDaemonKnowledgeRouteHandlers,
  createDaemonMediaRouteHandlers,
  createDaemonSystemRouteHandlers,
  dispatchDaemonApiRoutes,
  jsonErrorResponse,
} from '../packages/daemon-sdk/dist/index.js';
import { GoodVibesSdkError } from '../packages/errors/dist/index.js';

describe('daemon sdk', () => {
  test('builds control route handlers from injected host services', async () => {
    const handlers = createDaemonControlRouteHandlers({
      authToken: 'shared-token',
      version: '0.18.2',
      sessionCookieName: 'goodvibes_session',
      controlPlaneGateway: {
        getSnapshot: () => ({ ok: true }),
        renderWebUi: () => new Response('<html></html>', { status: 200 }),
        listRecentEvents: (limit) => [{ id: 'evt-1', limit }],
        listSurfaceMessages: () => [{ id: 'msg-1' }],
        listClients: () => [{ id: 'client-1' }],
        createEventStream: () => new Response('stream', { status: 200 }),
      },
      extractAuthToken: (req) => req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      resolveAuthenticatedPrincipal: () => ({
        principalId: 'tester',
        principalKind: 'user',
        admin: true,
        scopes: ['read:control-plane'],
      }),
      gatewayMethods: {
        list: () => [{ id: 'tasks.create' }],
        listEvents: () => [{ id: 'runtime.turn' }],
        get: (methodId) => methodId === 'tasks.create'
          ? { dangerous: false, access: 'authenticated' }
          : null,
      },
      getOperatorContract: () => ({ version: 1, product: { id: 'goodvibes' } }),
      inspectInboundTls: (surface) => ({ surface, mode: 'off' }),
      inspectOutboundTls: () => ({ mode: 'system' }),
      invokeGatewayMethodCall: async () => ({ status: 200, ok: true, body: { invoked: true } }),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
      requireAuthenticatedSession: () => ({ username: 'tester', roles: ['admin'] }),
    }, new Request('http://127.0.0.1/api/control-plane/auth', {
      headers: {
        Authorization: 'Bearer token-123',
        Cookie: 'goodvibes_session=session-123',
      },
    }));

    const statusResponse = await handlers.getStatus();
    expect(statusResponse.status).toBe(200);
    const status = await statusResponse.json() as { version: string };
    expect(status.version).toBe('0.18.2');

    const authResponse = await handlers.getCurrentAuth(new Request('http://127.0.0.1/api/control-plane/auth', {
      headers: {
        Authorization: 'Bearer token-123',
        Cookie: 'goodvibes_session=session-123',
      },
    }));
    expect(authResponse.status).toBe(200);
    const auth = await authResponse.json() as { authenticated: boolean; roles: string[] };
    expect(auth.authenticated).toBe(true);
    expect(auth.roles).toEqual(['admin']);
  });

  test('dispatches daemon api routes to the matching handler', async () => {
    const response = await dispatchDaemonApiRoutes(
      new Request('http://127.0.0.1/api/v1/telemetry/events', { method: 'GET' }),
      {
        getTelemetryEvents: () => Response.json({ ok: true }),
      } as never,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
  });

  test('builds structured daemon error responses', async () => {
    const response = jsonErrorResponse(new GoodVibesSdkError('provider rejected auth', {
      code: 'PROVIDER_ERROR',
      category: 'authentication',
      source: 'provider',
      recoverable: false,
      status: 401,
      hint: 'wrong token',
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-401',
      providerCode: 'invalid_api_key',
    }), { status: 400 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'provider rejected auth (phase=request, code=invalid_api_key, request_id=req-401)',
      hint: 'wrong token',
      code: 'PROVIDER_ERROR',
      category: 'authentication',
      source: 'provider',
      recoverable: false,
      status: 401,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-401',
      providerCode: 'invalid_api_key',
    });
  });

  test('builds structured daemon error responses from foreign provider-style errors', async () => {
    const response = jsonErrorResponse({
      message: 'inceptionlabs chat request failed 401: token rejected',
      code: 'PROVIDER_ERROR',
      recoverable: false,
      statusCode: 401,
      category: 'authentication',
      guidance: 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.',
      source: 'provider',
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-401',
      providerCode: 'invalid_api_key',
    }, { status: 400 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'inceptionlabs chat request failed 401: token rejected (code=invalid_api_key, request_id=req-401)',
      hint: 'The provider rejected authentication. Possible causes include invalid or expired credentials, missing account/session state, account restrictions, or the wrong provider/endpoint receiving the request.',
      code: 'PROVIDER_ERROR',
      category: 'authentication',
      source: 'provider',
      recoverable: false,
      status: 401,
      provider: 'inceptionlabs',
      operation: 'chat',
      phase: 'request',
      requestId: 'req-401',
      providerCode: 'invalid_api_key',
    });
  });

  test('exports channel, system, knowledge, and media route builders', async () => {
    const channelHandlers = createDaemonChannelRouteHandlers({
      channelPlugins: {
        listAccounts: async () => [],
        getAccount: async () => null,
        getSetupSchema: async () => null,
        doctor: async () => null,
        listRepairActions: async () => [],
        getLifecycleState: async () => null,
        migrateLifecycle: async () => null,
        runAccountAction: async () => null,
        listCapabilities: async () => [],
        listTools: async () => [],
        listAgentTools: () => [],
        runTool: async () => null,
        listOperatorActions: async () => [],
        runOperatorAction: async () => null,
        resolveTarget: async () => null,
        authorizeActorAction: async () => null,
        resolveAllowlist: async () => null,
        editAllowlist: async () => null,
        listStatus: async () => [],
        queryDirectory: async () => [],
      },
      channelPolicy: {
        listPolicies: () => [],
        upsertPolicy: async () => ({}),
        listAudit: () => [],
      },
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
      surfaceRegistry: {
        list: () => [{ id: 'discord' }],
      },
    });
    expect(await channelHandlers.getSurfaces().json()).toEqual({
      surfaces: [{ id: 'discord' }],
    });

    const systemHandlers = createDaemonSystemRouteHandlers({
      approvalBroker: {
        claimApproval: async () => null,
        cancelApproval: async () => null,
        resolveApproval: async () => null,
      },
      configManager: {
        get: () => true,
        getAll: () => ({ demo: true }),
        setDynamic: () => undefined,
      },
      integrationHelpers: null,
      inspectInboundTls: (surface) => ({ surface, mode: 'off' }),
      inspectOutboundTls: () => ({ mode: 'system' }),
      isValidConfigKey: () => true,
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      platformServiceManager: {
        status: () => ({ running: true }),
        install: () => ({ ok: true }),
        start: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        restart: () => ({ ok: true }),
        uninstall: () => ({ ok: true }),
      },
      recordApiResponse: (_req, _path, response) => response,
      requireAdmin: () => null,
      requireAuthenticatedSession: () => ({ username: 'tester', roles: ['admin'] }),
      routeBindings: {
        listBindings: () => [],
        upsertBinding: async () => ({}),
        patchBinding: async () => ({}),
        removeBinding: async () => true,
      },
      watcherRegistry: {
        list: () => [],
        removeWatcher: () => true,
        registerWatcher: (input) => input,
        getWatcher: () => null,
        startWatcher: () => null,
        stopWatcher: () => null,
        runWatcherNow: async () => null,
      },
    }, new Request('http://127.0.0.1/api/system/status'));
    expect(systemHandlers.getServiceStatus).toBeDefined();

    const knowledgeHandlers = createDaemonKnowledgeRouteHandlers({
      configManager: { get: () => false },
      inspectGraphqlAccess: () => ({ requiredScopes: [] }),
      normalizeAtSchedule: (at) => ({ kind: 'at', at }),
      normalizeEverySchedule: (interval, anchorAt) => ({ kind: 'every', interval, anchorAt }),
      normalizeCronSchedule: (expression, timezone, staggerMs) => ({ kind: 'cron', expression, timezone, staggerMs }),
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      parseJsonText: () => ({}),
      requireAdmin: () => null,
      resolveAuthenticatedPrincipal: () => null,
      knowledgeService: {
        getStatus: async () => ({ ok: true }),
        listSources: () => [],
        listNodes: () => [],
        listIssues: () => [],
        getItem: () => null,
        listConnectors: () => [],
        getConnector: () => null,
        doctorConnector: async () => null,
        listProjectionTargets: async () => [],
        listExtractions: () => [],
        listUsageRecords: () => [],
        listConsolidationCandidates: () => [],
        getConsolidationCandidate: () => null,
        listConsolidationReports: () => [],
        getConsolidationReport: () => null,
        getExtraction: () => null,
        getSourceExtraction: () => null,
        listJobs: () => [],
        getJob: () => null,
        listJobRuns: () => [],
        listSchedules: () => [],
        getSchedule: () => null,
        ingestUrl: async () => ({}),
        ingestArtifact: async () => ({}),
        importBookmarksFromFile: async () => ({}),
        importUrlsFromFile: async () => ({}),
        ingestConnectorInput: async () => ({}),
        search: () => [],
        buildPacket: async () => ({}),
        decideConsolidationCandidate: async () => ({}),
        runJob: async () => ({}),
        lint: async () => [],
        reindex: async () => ({}),
        saveSchedule: async () => ({}),
        deleteSchedule: async () => false,
        setScheduleEnabled: async () => null,
        renderProjection: async () => ({}),
        materializeProjection: async () => ({}),
      },
      knowledgeGraphqlService: {
        schemaText: 'type Query { status: String! }',
        execute: async () => ({ data: { status: 'ok' } }),
      },
    });
    expect(await knowledgeHandlers.getKnowledgeGraphqlSchema().json()).toMatchObject({
      schema: 'type Query { status: String! }',
    });

    const mediaHandlers = createDaemonMediaRouteHandlers({
      artifactStore: {
        list: () => [{ id: 'artifact-1' }],
        create: async () => ({}),
        get: () => null,
        readContent: async () => ({
          record: { mimeType: 'text/plain' },
          buffer: new Uint8Array([1, 2, 3]),
        }),
      },
      configManager: { get: () => true },
      mediaProviders: {
        status: async () => [],
        findProvider: () => null,
      },
      multimodalService: {
        getStatus: async () => ({ ok: true }),
        listProviders: async () => [],
        analyze: async () => ({}),
        buildPacket: () => ({}),
        writeBackAnalysis: async () => ({}),
      },
      parseJsonBody: async () => ({}),
      requireAdmin: () => null,
      voiceService: {
        getStatus: async () => ({ providers: [] }),
        listVoices: async () => [],
        synthesize: async () => ({}),
        transcribe: async () => ({}),
        openRealtimeSession: async () => ({}),
      },
      webSearchService: {
        getStatus: async () => ({ providers: [] }),
        search: async () => ({}),
      },
    });
    expect(await mediaHandlers.getArtifacts().json()).toEqual({
      artifacts: [{ id: 'artifact-1' }],
    });
  });
});
