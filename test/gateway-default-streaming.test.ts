/**
 * gateway-default-streaming.test.ts  (One-Platform Wave 1, S2a)
 *
 * Proves the control-plane-gateway flag defaults ON so a STOCK daemon (no config) can
 * stream companion chat over SSE — the literal W1 "stock daemon is dead" repro — while
 * keeping every honest failure mode intact:
 *   - default-ON assertion + kill-switch honesty (config can still turn it off)
 *   - stock-daemon companion SSE happy path: 200 text/event-stream through the REAL
 *     ControlPlaneGateway.createEventStream (today, without the flip, this returns 503)
 *   - honest degraded mode: flag explicitly off ⇒ getSnapshot() disabled shell +
 *     createEventStream 503 with an ACTIONABLE body naming the flag
 *   - auth is orthogonal to the flag: flag ON + no principal ⇒ SSE route 401,
 *     method invoke 401 by access class
 */
import { describe, expect, test } from 'bun:test';
import { createFeatureFlagManager } from '../packages/sdk/src/platform/runtime/feature-flags/manager.js';
import { ControlPlaneGateway } from '../packages/sdk/src/platform/control-plane/gateway.js';
import { CONTROL_PLANE_GATEWAY_FLAG_ID } from '../packages/sdk/src/platform/control-plane/gateway-disabled-response.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import { CompanionChatManager } from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import type {
  CompanionChatManagerConfig,
  CompanionLLMProvider,
  CompanionProviderChunk,
} from '../packages/sdk/src/platform/companion/companion-chat-manager.js';
import { DaemonHttpRouter } from '../packages/sdk/src/platform/daemon/http/router.js';
import { createDaemonControlRouteHandlers } from '../packages/daemon-sdk/src/control-routes.js';

const FLAG = CONTROL_PLANE_GATEWAY_FLAG_ID;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(): CompanionLLMProvider {
  return {
    async *chatStream(): AsyncIterable<CompanionProviderChunk> {
      yield { type: 'text_delta', delta: 'hi' };
      yield { type: 'done' };
    },
  };
}

function makeManager(gateway: ControlPlaneGateway): CompanionChatManager {
  const config: CompanionChatManagerConfig = {
    provider: makeMockProvider(),
    eventPublisher: gateway,
    gcIntervalMs: 999_999,
  };
  return new CompanionChatManager(config);
}

/** A real gateway seeded from a fresh (stock) feature-flag manager + real runtime bus. */
function makeStockGateway(): { gateway: ControlPlaneGateway; bus: RuntimeEventBus } {
  const bus = new RuntimeEventBus();
  const featureFlags = createFeatureFlagManager(); // seeds declared defaults — no config
  const gateway = new ControlPlaneGateway({ runtimeBus: bus, featureFlags });
  return { gateway, bus };
}

/**
 * Minimal DaemonHttpRouter context wiring ONLY the fields the companion-chat SSE path
 * needs (companionChatManager + the real controlPlaneGateway). Everything else is a stub;
 * runtimeStore:null avoids TelemetryApiService construction. Mirrors the known-good stub
 * in companion-chat-daemon-wire.test.ts.
 */
function makeRouterContext(
  gateway: ControlPlaneGateway,
  companionChatManager: CompanionChatManager,
): ConstructorParameters<typeof DaemonHttpRouter>[0] {
  const noop = () => {};
  return {
    configManager: {} as never,
    serviceRegistry: {} as never,
    userAuth: {} as never,
    agentManager: {} as never,
    automationManager: {} as never,
    approvalBroker: {} as never,
    controlPlaneGateway: gateway as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]['controlPlaneGateway'],
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
    companionChatManager,
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0];
}

// ---------------------------------------------------------------------------
// Flag default + kill switch
// ---------------------------------------------------------------------------

describe('S2a — control-plane-gateway defaults ON', () => {
  test('a fresh (stock) feature-flag manager reports the gateway ENABLED', () => {
    const flags = createFeatureFlagManager();
    expect(flags.isEnabled(FLAG)).toBe(true);
    expect(flags.getState(FLAG)).toBe('enabled');
  });

  test('config can still turn the gateway OFF (kill-switch / opt-out honesty)', () => {
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: { [FLAG]: 'disabled' } });
    expect(flags.isEnabled(FLAG)).toBe(false);
    expect(flags.getState(FLAG)).toBe('disabled');
  });

  test('only control-plane-gateway flips; sibling tier-10 surfaces stay OFF', () => {
    const flags = createFeatureFlagManager();
    expect(flags.isEnabled('control-plane-gateway')).toBe(true);
    for (const sibling of ['slack-surface', 'discord-surface', 'web-surface', 'automation-domain']) {
      expect(flags.isEnabled(sibling)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Stock-daemon streaming proof (the W1 repro)
// ---------------------------------------------------------------------------

describe('S2a — stock daemon streams companion chat (no 503 dead end)', () => {
  test('GET companion /events returns 200 text/event-stream through the real gateway', async () => {
    const { gateway } = makeStockGateway();
    const manager = makeManager(gateway);
    try {
      const router = new DaemonHttpRouter(makeRouterContext(gateway, manager));

      const createRes = await router.dispatchApiRoutes(new Request('http://localhost/api/companion/chat/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'stock-stream', provider: 'inception', model: 'mercury-2' }),
      }));
      expect(createRes!.status).toBe(201);
      const { sessionId } = await createRes!.json();

      const eventsRes = await router.dispatchApiRoutes(new Request(
        `http://localhost/api/companion/chat/sessions/${sessionId}/events`,
        { method: 'GET' },
      ));
      expect(eventsRes).not.toBeNull();
      // The literal W1 assertion: a stock daemon streams (200), NOT the 503 flag-disabled dead end.
      expect(eventsRes!.status).toBe(200);
      expect(eventsRes!.headers.get('content-type')).toContain('text/event-stream');
      await eventsRes!.body?.cancel();
    } finally {
      manager.dispose();
    }
  });

  test('the raw gateway createEventStream returns 200 for a stock manager', () => {
    const { gateway } = makeStockGateway();
    const res = gateway.createEventStream(new Request('http://localhost/stream'), { clientKind: 'web' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});

// ---------------------------------------------------------------------------
// Honest degraded mode — flag explicitly OFF is legible, not silent
// ---------------------------------------------------------------------------

describe('S2a — honest degraded mode when the flag is explicitly OFF', () => {
  function makeDisabledGateway(): ControlPlaneGateway {
    const bus = new RuntimeEventBus();
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: { [FLAG]: 'disabled' } });
    return new ControlPlaneGateway({ runtimeBus: bus, featureFlags });
  }

  test('getSnapshot() returns the webui-actionable disabled shell', () => {
    const snapshot = makeDisabledGateway().getSnapshot() as {
      disabled?: boolean;
      featureFlag?: string;
      totals?: { clients: number };
    };
    expect(snapshot.disabled).toBe(true);
    expect(snapshot.featureFlag).toBe(FLAG);
    expect(snapshot.totals?.clients).toBe(0);
  });

  test('createEventStream returns 503 with an ACTIONABLE body naming the flag', async () => {
    const res = makeDisabledGateway().createEventStream(new Request('http://localhost/stream'));
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; featureFlag: string; hint: string };
    expect(body.featureFlag).toBe(FLAG);
    expect(body.error).toContain(FLAG);
    // Actionable: names the flag AND tells the operator how to restore streaming.
    expect(body.hint).toContain(FLAG);
    expect(body.hint.toLowerCase()).toContain('disabled');
  });
});

// ---------------------------------------------------------------------------
// Auth is orthogonal to the flag — flipping it ON exposes nothing un-authed
// ---------------------------------------------------------------------------

describe('S2a — auth still gates every entry point when the flag is ON', () => {
  function makeControlHandlers(gateway: ControlPlaneGateway, principal: unknown) {
    return createDaemonControlRouteHandlers({
      authToken: 'shared-token',
      version: '0.0.0-test',
      sessionCookieName: 'gv_session',
      controlPlaneGateway: gateway as never,
      extractAuthToken: () => '',
      resolveAuthenticatedPrincipal: () => principal as never,
      gatewayMethods: {
        get: () => ({ access: 'authenticated' }),
        list: () => [],
        listEvents: () => [],
      } as never,
      getOperatorContract: () => ({}),
      invokeGatewayMethodCall: async () => ({ status: 200, ok: true, body: null }),
      parseOptionalJsonBody: async () => null,
      requireAdmin: () => null,
      requireAuthenticatedSession: () => null,
    });
  }

  test('SSE route returns 401 with no principal even though the flag is ON', async () => {
    const { gateway } = makeStockGateway();
    const handlers = makeControlHandlers(gateway, null);
    const res = await handlers.createControlPlaneEventStream(new Request('http://localhost/api/control-plane/events'));
    expect(res.status).toBe(401);
  });

  test('SSE route streams (200) once a principal is present + flag ON', async () => {
    const { gateway } = makeStockGateway();
    const handlers = makeControlHandlers(gateway, {
      principalId: 'shared-token',
      principalKind: 'token',
      admin: true,
      scopes: ['read:events'],
    });
    const res = await handlers.createControlPlaneEventStream(new Request('http://localhost/api/control-plane/events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  test('authenticated method invoke returns 401 with no principal', async () => {
    const { gateway } = makeStockGateway();
    const handlers = makeControlHandlers(gateway, null);
    const res = await handlers.invokeGatewayMethod('sessions.list', new Request('http://localhost/api/control/gateway-methods/sessions.list/invoke', { method: 'POST' }));
    expect(res.status).toBe(401);
  });
});
