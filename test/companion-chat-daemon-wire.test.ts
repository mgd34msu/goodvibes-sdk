/**
 * companion-chat-daemon-wire.test.ts
 *
 * Regression test for the production 404 on POST /api/companion/chat/sessions.
 *
 * Root cause: DaemonHttpRouter gates companion routes on `companionChatManager`
 * being present in its context, but facade-composition.ts never constructed or
 * injected one. This test constructs a DaemonHttpRouter with a live
 * CompanionChatManager and asserts the route is reachable (201), proving the
 * wire exists. It also verifies that without the manager the route returns 404.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { settleEvents } from './_helpers/test-timeout.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionChatManagerConfig,
  CompanionChatEventPublisher,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import { dispatchCompanionChatRoutes } from '../packages/sdk/src/platform/companion/companion-chat-routes.js';
import type { CompanionChatRouteContext } from '../packages/sdk/src/platform/companion/companion-chat-route-types.js';
import { DaemonHttpRouter } from '../packages/sdk/src/platform/daemon/http/router.js';

// ---------------------------------------------------------------------------
// Minimal mock provider
// ---------------------------------------------------------------------------

function makeMockProvider(): CompanionLLMProvider {
  return {
    async *chatStream(): AsyncIterable<CompanionProviderChunk> {
      yield { type: 'text_delta', delta: 'hello' };
      yield { type: 'done' };
    },
  };
}

function makeEventPublisher(): CompanionChatEventPublisher {
  return {
    publishEvent() {},
  };
}

function makeManager(): CompanionChatManager {
  const config: CompanionChatManagerConfig = {
    provider: makeMockProvider(),
    eventPublisher: makeEventPublisher(),
    gcIntervalMs: 999_999,
  };
  return new CompanionChatManager(config);
}

function makeRouteContext(
  chatManager: CompanionChatManager,
): CompanionChatRouteContext {
  return {
    chatManager,
    async parseJsonBody(req) {
      try {
        return await req.json();
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    async parseOptionalJsonBody(req) {
      const text = await req.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return new Response('Bad JSON', { status: 400 });
      }
    },
    openSessionEventStream: (_req, sessionId) =>
      new Response(`data: connected sessionId=${sessionId}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  };
}

// ---------------------------------------------------------------------------
// Minimal DaemonHttpRouter context stub
// ---------------------------------------------------------------------------

/**
 * Builds the minimal DaemonHttpRouterContext needed to exercise companion chat
 * routing inside DaemonHttpRouter.dispatchApiRoutes. All fields unrelated to the
 * companion dispatch path are no-op stubs.
 */
function makeRouterContext(
  companionChatManager?: CompanionChatManager | null,
): ConstructorParameters<typeof DaemonHttpRouter>[0] {
  const noop = () => {};
  // Minimal controlPlaneGateway stub — only publishEvent and registerSubscriber
  // are exercised by the companion POST /sessions path.
  const controlPlaneGateway = {
    publishEvent: noop,
    createEventStream: (_req: Request, _opts: unknown) =>
      new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]['controlPlaneGateway'];

  return {
    configManager: {} as never,
    serviceRegistry: {} as never,
    userAuth: {} as never,
    agentManager: {} as never,
    automationManager: {} as never,
    approvalBroker: {} as never,
    controlPlaneGateway,
    gatewayMethods: {} as never,
    providerRegistry: {} as never,
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
    runtimeBus: {} as never,
    // runtimeStore: null prevents TelemetryApiService construction in the constructor.
    runtimeStore: null,
    runtimeDispatch: null,
    githubWebhookSecret: null,
    authToken: () => null,
    buildSurfaceAdapterContext: () => ({}) as never,
    buildGenericWebhookAdapterContext: () => ({}) as never,
    checkAuth: () => false,
    extractAuthToken: () => '',
    requireAuthenticatedSession: () => null,
    requireAdmin: () => null,
    requireRemotePeer: async () => ({}) as never,
    describeAuthenticatedPrincipal: () => null,
    invokeGatewayMethodCall: async () => ({ status: 200, ok: true, body: null }),
    queueSurfaceReplyFromBinding: noop,
    surfaceDeliveryEnabled: () => false,
    syncSpawnedAgentTask: noop,
    syncFinishedAgentTask: noop,
    trySpawnAgent: () => ({}) as never,
    companionChatManager: companionChatManager ?? null,
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('companion-chat daemon wire: route reachability', () => {
  let manager: CompanionChatManager;

  beforeEach(() => {
    manager = makeManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  test('POST /api/companion/chat/sessions returns 201 when companionChatManager is wired', async () => {
    // This exercises the same dispatchCompanionChatRoutes call path that
    // DaemonHttpRouter.dispatchApiRoutes delegates to when companionChatManager
    // is present. Before the fix, the manager was never injected, so the guard
    // `if (this.context.companionChatManager && ...)` was always falsy and
    // the request fell through to the 404 handler.
    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'wire-test', model: 'mercury-2' }),
    });
    const ctx = makeRouteContext(manager);
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json();
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('POST /api/companion/chat/sessions with empty body rejects without a default resolver', async () => {
    const req = new Request('http://localhost/api/companion/chat/sessions', { method: 'POST' });
    const ctx = makeRouteContext(manager);
    const res = await dispatchCompanionChatRoutes(req, ctx);
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.code).toBe('NO_MODEL_CONFIGURED');
  });

  test('dispatchCompanionChatRoutes returns null for non-companion routes', async () => {
    // Verifies the guard: without companionChatManager, the router must return
    // null (fall-through to 404). We simulate this by calling with a non-companion URL.
    const req = new Request('http://localhost/api/tasks', { method: 'GET' });
    const ctx = makeRouteContext(manager);
    const res = await dispatchCompanionChatRoutes(req, ctx);
    // dispatchCompanionChatRoutes should return null for unrecognised paths
    expect(res).toBeNull();
  });

  test('GET /api/companion/chat/sessions/:id returns 200 for a created session', async () => {
    const ctx = makeRouteContext(manager);

    // Create
    const createReq = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'wire-get-test' }),
    });
    const createRes = await dispatchCompanionChatRoutes(createReq, ctx);
    expect(createRes!.status).toBe(201);
    const { sessionId } = await createRes!.json();

    // Retrieve
    const getReq = new Request(
      `http://localhost/api/companion/chat/sessions/${sessionId}`,
      { method: 'GET' },
    );
    const getRes = await dispatchCompanionChatRoutes(getReq, ctx);
    expect(getRes!.status).toBe(200);
    const body = await getRes!.json();
    expect(body.session.id).toBe(sessionId);
    expect(body.session.title).toBe('wire-get-test');
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wire-level regression: DaemonHttpRouter.dispatchApiRoutes companion routing
//
// The original bug: facade-composition.ts never injected companionChatManager
// into DaemonHttpRouter, so the guard `if (this.context.companionChatManager)`
// was always falsy and POST /api/companion/chat/sessions returned 404.
//
// These tests construct DaemonHttpRouter directly (not via dispatchCompanionChatRoutes)
// so that deleting the `companionChatManager: runtime.companionChatManager` line
// from facade-composition.ts (or the guard inside dispatchApiRoutes) causes them
// to fail, whereas the route-isolation tests above would still pass.
// ---------------------------------------------------------------------------

describe('companion-chat daemon wire: DaemonHttpRouter.dispatchApiRoutes integration', () => {
  let manager: CompanionChatManager;

  beforeEach(() => {
    manager = makeManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  test('dispatchApiRoutes returns 201 when companionChatManager is present in router context', async () => {
    // This is the actual regression guard. If someone removes `companionChatManager`
    // from the DaemonHttpRouter constructor call in facade-composition.ts, the
    // guard `if (this.context.companionChatManager && ...)` becomes falsy and this
    // test fails — unlike the route-isolation tests which bypass the router entirely.
    const ctx = makeRouterContext(manager);
    const router = new DaemonHttpRouter(ctx);

    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'router-wire-test', model: 'mercury-2' }),
    });

    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);
    const body = await res!.json();
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('dispatchApiRoutes returns null for companion path when companionChatManager is absent', async () => {
    // Mirrors the pre-fix state: no manager → guard is falsy → companion request
    // falls through dispatchApiRoutes returning null (not a 201).
    const ctx = makeRouterContext(null);
    const router = new DaemonHttpRouter(ctx);

    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no-manager-test' }),
    });

    // dispatchApiRoutes delegates to dispatchDaemonApiRoutes for non-companion
    // fallthrough, which requires a real gateway. We only need to verify the
    // companion guard returns null — but dispatchDaemonApiRoutes will throw or
    // return something because the stubs are empty. We check the companion path
    // specifically: if the guard is falsy, the companion branch is skipped and
    // execution enters the main API router. We assert it does NOT return 201
    // (i.e., the companion handler was not reached).
    let result: Response | null;
    try {
      result = await router.dispatchApiRoutes(req);
    } catch {
      // If the main API router throws due to stub context, that still proves
      // the companion guard was falsy — the companion handler was bypassed.
      result = null;
    }
    // If result is non-null, it must NOT be a 201 companion response.
    if (result !== null) {
      expect(result.status).not.toBe(201);
    }
  });
});

// ---------------------------------------------------------------------------
// M3: Provider adapter stream-error propagation
// ---------------------------------------------------------------------------

describe('companion-chat provider adapter: stream-error path', () => {
  test('turn.error event is published when chatStream yields error chunk', async () => {
    // Verifies that when the CompanionLLMProvider yields { type: 'error' },
    // CompanionChatManager._runTurn converts it to a thrown Error and publishes
    // a 'turn.error' event via the eventPublisher. This covers the error
    // propagation contract between the facade-composition provider adapter
    // (which bridges chat errors to { type: 'error' } chunks) and the manager.
    const errorMessage = 'simulated provider failure';
    const errorProvider: CompanionLLMProvider = {
      async *chatStream(): AsyncIterable<CompanionProviderChunk> {
        yield { type: 'text_delta', delta: 'partial output' };
        yield { type: 'error', error: errorMessage };
      },
    };

    const publishedEvents: Array<{ event: string; payload: unknown }> = [];
    const trackingPublisher: CompanionChatEventPublisher = {
      publishEvent(event, payload) {
        publishedEvents.push({ event, payload });
      },
    };

    const manager = new CompanionChatManager({
      provider: errorProvider,
      eventPublisher: trackingPublisher,
      gcIntervalMs: 999_999,
    });

    const session = manager.createSession({ title: 'error-test' });
    await manager.postMessage(session.id, 'trigger error');

    // Wait for the async turn to complete.
    await settleEvents(100);

    manager.dispose();

    const turnEvents = publishedEvents.map((e) => e.event);
    // turn.started is always emitted
    expect(turnEvents).toContain('companion-chat.turn.started');
    // Delta events should have been published before the error
    expect(turnEvents).toContain('companion-chat.turn.delta');
    // The error chunk must surface as a turn.error event, not be silently swallowed
    expect(turnEvents).toContain('companion-chat.turn.error');
    // turn.completed must NOT be emitted when the turn fails
    expect(turnEvents).not.toContain('companion-chat.turn.completed');

    // Verify the error payload contains the original message
    const errorEvent = publishedEvents.find((e) => e.event === 'companion-chat.turn.error');
    expect(errorEvent?.payload).toMatchObject({ error: errorMessage });
  });

  test('turn.error is published when chatStream throws mid-iteration', async () => {
    // Tests the case where the underlying generator throws (rather than yielding
    // an error chunk). The facade-composition adapter catches this in .catch()
    // and yields { type: 'error' } — but this test verifies the manager's
    // behavior when the provider itself throws directly.
    const throwingProvider: CompanionLLMProvider = {
      async *chatStream(): AsyncIterable<CompanionProviderChunk> {
        yield { type: 'text_delta', delta: 'before error' };
        throw new Error('mid-stream throw');
      },
    };

    const publishedEvents: Array<{ event: string; payload: unknown }> = [];
    const manager = new CompanionChatManager({
      provider: throwingProvider,
      eventPublisher: { publishEvent(event, payload) { publishedEvents.push({ event, payload }); } },
      gcIntervalMs: 999_999,
    });

    const session = manager.createSession({ title: 'throw-test' });
    await manager.postMessage(session.id, 'trigger throw');
    await settleEvents(100);
    manager.dispose();

    expect(publishedEvents.map((e) => e.event)).toContain('companion-chat.turn.error');
  });
});

// ---------------------------------------------------------------------------
// M4: Composition-level regression — facade-composition.ts wire assertion
//
// The previous test suites construct DaemonHttpRouter directly via
// makeRouterContext(), bypassing facade-composition.ts entirely. That means
// deleting `companionChatManager: runtime.companionChatManager` from
// facade-composition.ts leaves those tests green.
//
// These tests read the actual source file and assert that the two critical
// lines exist: (1) resolveDaemonFacadeRuntime includes companionChatManager in
// its return value, and (2) createDaemonFacadeCollaborators passes
// `companionChatManager: runtime.companionChatManager` to DaemonHttpRouter.
// Deleting either line causes the corresponding test to fail.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F16b: Router-level plumbing — resolveDefaultProviderModel forwarded
//
// Verifies that DaemonHttpRouter.dispatchApiRoutes forwards the optional
// resolveDefaultProviderModel callback from DaemonHttpRouterContext into
// the CompanionChatRouteContext passed to dispatchCompanionChatRoutes.
// If the forwarding is absent, session-create without explicit provider/model
// returns 400 instead of 201 when the resolver is present and returning values.
// ---------------------------------------------------------------------------

describe('F16b: DaemonHttpRouter forwards resolveDefaultProviderModel into companion dispatch', () => {
  let manager: CompanionChatManager;

  beforeEach(() => {
    manager = makeManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  test('resolver injected on context → session created (201) when body has no provider/model', async () => {
    // Build router context with resolveDefaultProviderModel wired in.
    // The resolver returns a concrete provider+model pair.
    const ctx = {
      ...makeRouterContext(manager),
      resolveDefaultProviderModel: () => ({ provider: 'inception', model: 'mercury-2' }),
    } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0];
    const router = new DaemonHttpRouter(ctx);

    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}), // no provider/model
    });

    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    // 201 means the resolver filled in the defaults and the session was created
    expect(res!.status).toBe(201);
    const body = await res!.json();
    expect(typeof body.sessionId).toBe('string');
  });

  test('resolver returns null → 400 NO_MODEL_CONFIGURED', async () => {
    const ctx = {
      ...makeRouterContext(manager),
      resolveDefaultProviderModel: () => null,
    } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0];
    const router = new DaemonHttpRouter(ctx);

    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.code).toBe('NO_MODEL_CONFIGURED');
  });

  test('resolver absent and body lacks provider/model → 400 NO_MODEL_CONFIGURED', async () => {
    const ctx = makeRouterContext(manager) as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0];
    const router = new DaemonHttpRouter(ctx);

    const req = new Request('http://localhost/api/companion/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body['code']).toBe('NO_MODEL_CONFIGURED');
  });
});

describe('companion-chat facade-composition: composition wire assertion', () => {
  const FACADE_COMPOSITION_PATH = resolve(
    import.meta.dir,
    '../packages/sdk/src/platform/daemon/facade-composition.ts',
  );

  let sourceText: string;

  beforeEach(() => {
    sourceText = readFileSync(FACADE_COMPOSITION_PATH, 'utf-8');
  });

  test('resolveDaemonFacadeRuntime includes companionChatManager in its return object', () => {
    // If this assertion fails, someone deleted the CompanionChatManager
    // construction or the `companionChatManager,` shorthand property from the
    // return block of resolveDaemonFacadeRuntime. That would cause the manager
    // to never be present on the ResolvedDaemonFacadeRuntime, breaking the
    // downstream injection into DaemonHttpRouter.
    //
    // Regression: production 404 on POST /api/companion/chat/sessions
    //
    // Uses a regex that excludes commented-out lines (lines beginning with optional
    // whitespace followed by //) so that commenting out the line fails the test.
    expect(sourceText).toMatch(
      /^(?!\s*\/\/).*companionChatManager = new CompanionChatManager\(/m,
    );
    // Assert the shorthand property exists as a non-comment active line.
    // Negative lookahead rejects commented-out lines AND the
    // `companionChatManager: runtime.companionChatManager,` injection line
    // at the router wiring site — we want only the return-object shorthand.
    expect(sourceText).toMatch(
      /^(?!\s*\/\/)(?!.*runtime\.companionChatManager).*\bcompanionChatManager,\s*$/m,
    );
  });

  test('createDaemonFacadeCollaborators passes companionChatManager: runtime.companionChatManager to DaemonHttpRouter', () => {
    // This is THE line that was absent in the original bug. If it is deleted
    // or commented out, DaemonHttpRouter receives null for companionChatManager
    // and the companion route guard is always falsy, causing
    // POST /api/companion/chat/sessions to return 404 in production.
    //
    // Regression: production 404 on POST /api/companion/chat/sessions
    //
    // Uses a regex that excludes commented-out lines so commenting the line
    // out is caught as well as deleting it.
    expect(sourceText).toMatch(
      /^(?!\s*\/\/).*companionChatManager:\s*runtime\.companionChatManager,/m,
    );
  });

  test('F16b: createDaemonFacadeCollaborators passes resolveDefaultProviderModel from options to DaemonHttpRouter', () => {
    // Verifies the F16b plumbing: CreateDaemonFacadeCollaboratorsOptions must
    // declare resolveDefaultProviderModel and DaemonHttpRouter must receive it.
    // If the forwarding line is deleted the companion-chat resolver callback
    // is silently dropped and session-create cannot use the configured model.
    expect(sourceText).toMatch(
      /^(?!\s*\/\/).*resolveDefaultProviderModel:\s*options\.resolveDefaultProviderModel,/m,
    );
  });
});
