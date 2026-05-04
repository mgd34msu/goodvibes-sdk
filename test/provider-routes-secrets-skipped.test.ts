/**
 * provider-routes-secrets-skipped.test.ts
 *
 * Tests for F-PROV-009 — secretsResolutionSkipped observability field.
 *
 * - With secretsManager: null → GET /api/providers response body includes secretsResolutionSkipped: true
 * - With secretsManager present → response does NOT include secretsResolutionSkipped (or is falsy)
 */

import { describe, expect, test } from 'bun:test';
import { dispatchProviderRoutes } from '../packages/sdk/src/platform/daemon/http/provider-routes.js';
import type { ProviderRouteContext } from '../packages/sdk/src/platform/daemon/http/provider-routes.js';
import { DaemonHttpRouter } from '../packages/sdk/src/platform/daemon/http/router.js';
import { RuntimeEventBus } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

// ---------------------------------------------------------------------------
// Stubs (minimal — matches provider-routes.test.ts pattern)
// ---------------------------------------------------------------------------

function makeModel(provider: string, id: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: '',
    selectable: true,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    tier: 'standard',
  } as ModelDefinition;
}

function makeRegistry(models: ModelDefinition[], configuredIds: string[] = []): ProviderRegistry {
  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (!models[0]) throw new Error('No current model');
      return models[0];
    },
    getConfiguredProviderIds: () => configuredIds,
    setCurrentModel: () => {},
  } as unknown as ProviderRegistry;
}

function makeConfigManager(): ConfigManager {
  return { set: () => {} } as unknown as ConfigManager;
}

function makeContext(
  registry: ProviderRegistry,
  secretsManager?: ProviderRouteContext['secretsManager'],
): ProviderRouteContext {
  const bus = new RuntimeEventBus();
  return {
    providerRegistry: registry,
    configManager: makeConfigManager(),
    runtimeBus: bus,
    parseJsonBody: async (req) => {
      try { return await req.json(); } catch { return new Response('Bad JSON', { status: 400 }); }
    },
    secretsManager,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F-PROV-009 — GET /api/providers: secretsResolutionSkipped observability', () => {
  test('secretsManager: null → response includes secretsResolutionSkipped: true', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const ctx = makeContext(makeRegistry([m1], ['inception']), null);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body['secretsResolutionSkipped']).toBe(true);
  });

  test('secretsManager: undefined → response includes secretsResolutionSkipped: true', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const ctx = makeContext(makeRegistry([m1], ['inception']), undefined);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body['secretsResolutionSkipped']).toBe(true);
  });

  test('secretsManager present → response does NOT include secretsResolutionSkipped', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const secretsManager = {
      get: async (_key: string): Promise<string | null> => null,
    };
    const ctx = makeContext(makeRegistry([m1], ['inception']), secretsManager);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await dispatchProviderRoutes(req, ctx);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    // When secretsManager is present, the field should be absent or falsy
    expect(body['secretsResolutionSkipped'] ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Router-level E2E — secretsResolutionSkipped via DaemonHttpRouter
// ---------------------------------------------------------------------------

describe('F-PROV-009 — DaemonHttpRouter: secretsResolutionSkipped E2E (router-level)', () => {
  /**
   * This test proves the full end-to-end path:
   *   Request → DaemonHttpRouter.dispatchApiRoutes
   *     → dispatchProviderRoutes (with secretsManager: null threaded through)
   *       → handleListProviders → secretsResolutionSkipped: true
   *
   * If a future PR removes the secretsManager field from DaemonHttpRouterContext
   * or forgets to pass it into the ProviderRouteContext literal, this test will
   * fail because secretsResolutionSkipped will be absent or false.
   */
  test('GET /api/providers via DaemonHttpRouter with secretsManager: null → secretsResolutionSkipped: true', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const bus = new RuntimeEventBus();
    const registry = {
      listModels: () => [m1],
      getCurrentModel: () => m1,
      getConfiguredProviderIds: () => ['inception'],
      setCurrentModel: () => {},
    } as unknown as ProviderRegistry;
    const configManager = makeConfigManager();

    // Minimal stub context for DaemonHttpRouter.
    // CRIT-05 (eighth-review): replaced `as never` stubs with typed spies that fail
    // loudly if any field unexpectedly accessed by the /api/providers code path.
    //
    // The guard used for all service stubs: accessing them means the route under
    // test has been refactored to reach them — that is a regression that should
    // surface immediately rather than silently returning undefined.
    function unexpectedAccess(field: string): never {
      throw new Error(`[provider-routes test] Unexpected access to stub field '${field}' — the /api/providers path should not need this`);
    }
    const makeUnexpectedService = (name: string) =>
      new Proxy({} as never, {
        get(_: never, prop: string) {
          unexpectedAccess(`${name}.${prop}`);
        },
      });

    const routerContext = {
      configManager,
      serviceRegistry: makeUnexpectedService('serviceRegistry'),
      userAuth: makeUnexpectedService('userAuth'),
      agentManager: makeUnexpectedService('agentManager'),
      automationManager: makeUnexpectedService('automationManager'),
      approvalBroker: makeUnexpectedService('approvalBroker'),
      controlPlaneGateway: makeUnexpectedService('controlPlaneGateway'),
      gatewayMethods: makeUnexpectedService('gatewayMethods'),
      providerRegistry: registry,
      sessionBroker: makeUnexpectedService('sessionBroker'),
      routeBindings: makeUnexpectedService('routeBindings'),
      channelPolicy: makeUnexpectedService('channelPolicy'),
      channelPlugins: makeUnexpectedService('channelPlugins'),
      surfaceRegistry: makeUnexpectedService('surfaceRegistry'),
      distributedRuntime: makeUnexpectedService('distributedRuntime'),
      watcherRegistry: makeUnexpectedService('watcherRegistry'),
      voiceService: makeUnexpectedService('voiceService'),
      webSearchService: makeUnexpectedService('webSearchService'),
      knowledgeService: makeUnexpectedService('knowledgeService'),
      knowledgeGraphqlService: makeUnexpectedService('knowledgeGraphqlService'),
      mediaProviders: makeUnexpectedService('mediaProviders'),
      multimodalService: makeUnexpectedService('multimodalService'),
      artifactStore: makeUnexpectedService('artifactStore'),
      memoryRegistry: makeUnexpectedService('memoryRegistry'),
      memoryEmbeddingRegistry: makeUnexpectedService('memoryEmbeddingRegistry'),
      platformServiceManager: makeUnexpectedService('platformServiceManager'),
      integrationHelpers: null,
      runtimeBus: bus,
      runtimeStore: null,
      runtimeDispatch: null,
      githubWebhookSecret: null,
      authToken: () => null,
      buildSurfaceAdapterContext: () => { throw new Error('not expected'); },
      buildGenericWebhookAdapterContext: () => { throw new Error('not expected'); },
      checkAuth: () => true,
      extractAuthToken: () => '',
      requireAuthenticatedSession: () => null,
      requireAdmin: () => null,
      requireRemotePeer: async () => { throw new Error('not expected'); },
      describeAuthenticatedPrincipal: () => null,
      invokeGatewayMethodCall: async () => { throw new Error('not expected'); },
      queueSurfaceReplyFromBinding: () => {},
      surfaceDeliveryEnabled: () => false,
      syncSpawnedAgentTask: () => {},
      syncFinishedAgentTask: () => {},
      trySpawnAgent: () => { throw new Error('not expected'); },
      companionChatManager: null,
      // THE CRITICAL FIELD UNDER TEST: secretsManager null causes secretsResolutionSkipped
      secretsManager: null,
    } as never;

    const router = new DaemonHttpRouter(routerContext);
    const req = new Request('http://localhost/api/providers', { method: 'GET' });
    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body['secretsResolutionSkipped']).toBe(true);

    router.dispose();
  });
});
