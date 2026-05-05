/**
 * model-routes.test.ts
 *
 * Tests for:
 *   GET    /api/models
 *   GET    /api/models/current
 *   PATCH  /api/models/current
 *   Turn-time isConfigured guard in createCompanionProviderAdapter
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { dispatchModelRoutes } from '../packages/sdk/src/platform/daemon/http/model-routes.js';
import type { ModelRouteContext } from '../packages/sdk/src/platform/daemon/http/model-routes.js';
import { DaemonHttpRouter } from '../packages/sdk/src/platform/daemon/http/router.js';
import { RuntimeEventBus, createEventEnvelope } from '../packages/sdk/src/platform/runtime/events/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.js';
import type { ProviderRuntimeMetadata } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeModel(provider: string, id: string, selectable = true): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: '',
    selectable,
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    tier: 'standard',
  } as ModelDefinition;
}

function makeRuntimeBus(): RuntimeEventBus & { emitted: Array<{ domain: string; envelope: unknown }> } {
  const emitted: Array<{ domain: string; envelope: unknown }> = [];
  const realBus = new RuntimeEventBus();
  // Intercept emissions so tests can assert on them
  const originalEmit = realBus.emit.bind(realBus);
  realBus.emit = (domain, envelope) => {
    emitted.push({ domain, envelope });
    originalEmit(domain, envelope);
  };
  return Object.assign(realBus, { emitted });
}

function makeRegistry(opts: {
  models?: ModelDefinition[];
  currentModel?: ModelDefinition;
  configuredIds?: string[];
  setCurrentModelThrows?: string;
  bus?: RuntimeEventBus;
  runtimeByProvider?: Record<string, ProviderRuntimeMetadata | null>;
}): ProviderRegistry {
  const models = opts.models ?? [];
  let current = opts.currentModel ?? models[0];
  const configuredIds = opts.configuredIds ?? [];

  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (!current) throw new Error('No current model');
      return current;
    },
    getConfiguredProviderIds: () => configuredIds,
    describeRuntime: async (providerId: string) => opts.runtimeByProvider?.[providerId] ?? null,
    setCurrentModel: (modelId: string) => {
      if (opts.setCurrentModelThrows) throw new Error(opts.setCurrentModelThrows);
      // Emulate real registry behavior: emit exactly one MODEL_CHANGED per setCurrentModel
      const newModel = models.find((m) => m.registryKey === modelId);
      if (newModel) {
        const previous = current;
        current = newModel;
        if (opts.bus) {
          opts.bus.emit(
            'providers',
            createEventEnvelope('MODEL_CHANGED', {
              type: 'MODEL_CHANGED',
              registryKey: newModel.registryKey,
              provider: newModel.provider,
              previous: previous ? { registryKey: previous.registryKey, provider: previous.provider } : undefined,
            }, { sessionId: 'system', source: 'test-registry', traceId: `test:${Date.now()}` }),
          );
        }
      }
    },
  } as unknown as ProviderRegistry;
}

function makeConfigManager(): ConfigManager {
  return {
    set: () => {},
  } as unknown as ConfigManager;
}

function makeContext(registryOpts: Omit<Parameters<typeof makeRegistry>[0], 'bus'>): {
  context: ModelRouteContext;
  bus: RuntimeEventBus & { emitted: Array<{ domain: string; envelope: unknown }> };
} {
  const bus = makeRuntimeBus();
  const context: ModelRouteContext = {
    providerRegistry: makeRegistry({ ...registryOpts, bus }),
    configManager: makeConfigManager(),
    runtimeBus: bus,
    parseJsonBody: async (req) => {
      try { return await req.json(); }
      catch { return new Response('Bad JSON', { status: 400 }); }
    },
  };
  return { context, bus };
}

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeSubscriptionRuntime(providerId = 'openai'): ProviderRuntimeMetadata {
  return {
    auth: {
      mode: 'api-key',
      configured: false,
      routes: [
        {
          route: 'api-key',
          label: 'Ambient API key',
          configured: false,
          usable: false,
          freshness: 'unconfigured',
        },
        {
          route: 'subscription-oauth',
          label: 'Subscription OAuth',
          configured: true,
          usable: true,
          freshness: 'healthy',
          providerId,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/models
// ---------------------------------------------------------------------------

describe('GET /api/models', () => {
  test('returns provider list with models and configured flags', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('venice', 'llama-3.3-70b');
    const { context } = makeContext({
      models: [m1, m2],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('GET', 'http://localhost/api/models');
    const res = await dispatchModelRoutes(req, context);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body.providers).toBeInstanceOf(Array);
    const providers = body.providers as Array<Record<string, unknown>>;

    const inceptionProv = providers.find((p) => p['id'] === 'inception');
    expect(inceptionProv?.['id']).toBe('inception');
    expect(inceptionProv!['configured']).toBe(true);

    const veniceProv = providers.find((p) => p['id'] === 'venice');
    expect(veniceProv?.['id']).toBe('venice');
    expect(veniceProv!['configured']).toBe(false);

    const currentModel = body.currentModel as Record<string, unknown> | null;
    expect(currentModel).not.toBeNull();
    expect(currentModel!['provider']).toBe('inception');
    expect(currentModel!['registryKey']).toBe('inception:mercury-2');
  });

  test('returns correct model entries with registryKey', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('GET', 'http://localhost/api/models');
    const res = await dispatchModelRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    const providers = body.providers as Array<Record<string, unknown>>;
    const inceptionProv = providers.find((p) => p['id'] === 'inception')!;
    const models = inceptionProv['models'] as Array<Record<string, unknown>>;
    expect(models[0]!['registryKey']).toBe('inception:mercury-2');
    expect(models[0]!['id']).toBe('mercury-2');
  });

  test('returns null currentModel when no model configured', async () => {
    const { context } = makeContext({ models: [], configuredIds: [] });

    const req = makeRequest('GET', 'http://localhost/api/models');
    const res = await dispatchModelRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.currentModel).toBeNull();
  });

  test('returns null for non-matching paths', async () => {
    const { context } = makeContext({ models: [] });
    const req = makeRequest('GET', 'http://localhost/api/other');
    const res = await dispatchModelRoutes(req, context);
    expect(res).toBeNull();
  });

  test("returns configuredVia='secrets' when provider has no env var but SecretsManager has the key", async () => {
    const m1 = makeModel('openai', 'gpt-4o');
    // No env var set for OPENAI_API_KEY (test env), but secrets has it
    const secretsManager = {
      get: async (key: string): Promise<string | null> => {
        if (key === 'OPENAI_API_KEY') return 'sk-test-from-secrets';
        return null;
      },
    };
    const bus = makeRuntimeBus();
    const context: ModelRouteContext = {
      providerRegistry: makeRegistry({ models: [m1], currentModel: m1, configuredIds: ['openai'], bus }),
      configManager: makeConfigManager(),
      runtimeBus: bus,
      parseJsonBody: async (req) => {
        try { return await req.json(); }
        catch { return new Response('Bad JSON', { status: 400 }); }
      },
      secretsManager,
    };

    // Temporarily unset the env var so we hit the secrets path
    const original = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    try {
      const req = makeRequest('GET', 'http://localhost/api/models');
      const res = await dispatchModelRoutes(req, context);
      const body = await res!.json() as Record<string, unknown>;
      const providers = body.providers as Array<Record<string, unknown>>;
      const openaiProv = providers.find((p) => p['id'] === 'openai');
      expect(openaiProv?.['id']).toBe('openai');
      expect(openaiProv!['configured']).toBe(true);
      expect(openaiProv!['configuredVia']).toBe('secrets');
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
    }
  });

  test("returns configuredVia='subscription' when OpenAI has a usable subscription route but no API key", async () => {
    const m1 = makeModel('openai', 'gpt-5.5');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [],
      runtimeByProvider: { openai: makeSubscriptionRuntime('openai') },
    });

    const original = process.env['OPENAI_API_KEY'];
    const originalAlt = process.env['OPENAI_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_KEY'];

    try {
      const req = makeRequest('GET', 'http://localhost/api/models');
      const res = await dispatchModelRoutes(req, context);
      const body = await res!.json() as Record<string, unknown>;
      const providers = body.providers as Array<Record<string, unknown>>;
      const openaiProv = providers.find((p) => p['id'] === 'openai');
      expect(openaiProv?.['id']).toBe('openai');
      expect(openaiProv!['configured']).toBe(true);
      expect(openaiProv!['configuredVia']).toBe('subscription');
      expect(openaiProv!['routes']).toBeInstanceOf(Array);
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
      if (originalAlt !== undefined) process.env['OPENAI_KEY'] = originalAlt;
    }
  });

  test('does not treat stale registry configuredIds as configured when runtime auth routes are unusable', async () => {
    const m1 = makeModel('openai', 'gpt-5.5');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: ['openai'],
      runtimeByProvider: {
        openai: {
          auth: {
            mode: 'api-key',
            configured: false,
            routes: [
              {
                route: 'subscription-oauth',
                label: 'Subscription OAuth',
                configured: false,
                usable: false,
                freshness: 'expired',
                providerId: 'openai',
              },
            ],
          },
        },
      },
    });

    const original = process.env['OPENAI_API_KEY'];
    const originalAlt = process.env['OPENAI_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_KEY'];

    try {
      const req = makeRequest('GET', 'http://localhost/api/models');
      const res = await dispatchModelRoutes(req, context);
      const body = await res!.json() as Record<string, unknown>;
      const providers = body.providers as Array<Record<string, unknown>>;
      const openaiProv = providers.find((p) => p['id'] === 'openai');
      expect(openaiProv?.['configured']).toBe(false);
      expect(openaiProv?.['configuredVia']).toBeUndefined();
      expect(openaiProv?.['routes']).toBeInstanceOf(Array);
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
      if (originalAlt !== undefined) process.env['OPENAI_KEY'] = originalAlt;
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/models/current
// ---------------------------------------------------------------------------

describe('GET /api/models/current', () => {
  test('returns current model ref and configured=true when env key present', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('GET', 'http://localhost/api/models/current');
    const res = await dispatchModelRoutes(req, context);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    const model = body.model as Record<string, unknown> | null;
    expect(model).not.toBeNull();
    expect(model!['registryKey']).toBe('inception:mercury-2');
    expect(model!['provider']).toBe('inception');
    expect(body.configured).toBe(true);
  });

  test('returns configured=false for unconfigured provider', async () => {
    const m1 = makeModel('venice', 'llama-3.3-70b');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [], // venice NOT configured
    });

    const req = makeRequest('GET', 'http://localhost/api/models/current');
    const res = await dispatchModelRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.model).not.toBeNull();
  });

  test("returns configuredVia='subscription' for current OpenAI model when subscription route is usable", async () => {
    const m1 = makeModel('openai', 'gpt-5.5');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [],
      runtimeByProvider: { openai: makeSubscriptionRuntime('openai') },
    });

    const req = makeRequest('GET', 'http://localhost/api/models/current');
    const res = await dispatchModelRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.configuredVia).toBe('subscription');
    expect(body.routes).toBeInstanceOf(Array);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/models/current
// ---------------------------------------------------------------------------

describe('PATCH /api/models/current', () => {
  test('succeeds with known registryKey and returns new current model', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('inception', 'mercury-edit');
    const { context, bus } = makeContext({
      models: [m1, m2],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: 'inception:mercury-edit',
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.model).not.toBeNull();

    // Response must include persisted field
    expect(typeof body.persisted).toBe('boolean');

    // The registry test double emulates real registry behavior by emitting on the bus
    // when setCurrentModel is called. The route handler must NOT emit a second one.
    // If this assertion fails with length > 1, a duplicate emission was introduced.
    const modelChangedEmits = bus.emitted
      .filter((e): e is { domain: string; envelope: Record<string, unknown> } =>
        e.domain === 'providers' &&
        typeof e.envelope === 'object' &&
        e.envelope !== null &&
        (e.envelope as Record<string, unknown>)['type'] === 'MODEL_CHANGED',
      );
    expect(modelChangedEmits).toHaveLength(1);
  });

  test('returns 400 MODEL_NOT_FOUND for unknown registryKey', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: 'inception:nonexistent-model',
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('MODEL_NOT_FOUND');
  });

  test('returns 409 PROVIDER_NOT_CONFIGURED with missingEnvVars for unconfigured provider', async () => {
    const m1 = makeModel('venice', 'llama-3.3-70b');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [], // venice NOT configured
    });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: 'venice:llama-3.3-70b',
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(409);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(body.missingEnvVars).toBeInstanceOf(Array);
    // Venice env vars from BUILTIN_PROVIDER_ENV_KEYS
    const missingEnvVars = body.missingEnvVars as string[];
    expect(missingEnvVars).toContain('VENICE_API_KEY');
  });

  test('returns 400 INVALID_REQUEST when registryKey is missing', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {});
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('INVALID_REQUEST');
  });

  test('returns 400 INVALID_REQUEST when registryKey is not provider-qualified', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: 'mercury-2',
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.error).toContain('provider-qualified registryKey');
  });

  test('accepts OpenAI model switch when only a usable subscription route is configured', async () => {
    const m1 = makeModel('openai', 'gpt-5.4');
    const m2 = makeModel('openai', 'gpt-5.5');
    const { context } = makeContext({
      models: [m1, m2],
      currentModel: m1,
      configuredIds: [],
      runtimeByProvider: { openai: makeSubscriptionRuntime('openai') },
    });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: 'openai:gpt-5.5',
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    const model = body.model as Record<string, unknown> | null;
    expect(model!['registryKey']).toBe('openai:gpt-5.5');
    expect(body.configuredVia).toBe('subscription');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/models/current — discovered/anonymous provider
// ---------------------------------------------------------------------------

describe('PATCH /api/models/current — discovered anonymous provider', () => {
  test('succeeds for a discovered provider not in BUILTIN_PROVIDER_ENV_KEYS when registry reports it configured', async () => {
    // Simulate an LM Studio server discovered at 192.168.0.85.
    // Its provider name won't be in BUILTIN_PROVIDER_ENV_KEYS (no env var).
    const discoveredProviderName = 'LM Studio (192.168.0.85)';
    const modelId = 'qwen2.5-coder-7b';
    const m1 = makeModel(discoveredProviderName, modelId);
    const { context, bus } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [discoveredProviderName],
    });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: `${discoveredProviderName}:${modelId}`,
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.model).not.toBeNull();
    expect(typeof body.persisted).toBe('boolean');
  });

  test('returns 409 PROVIDER_NOT_CONFIGURED with empty missingEnvVars for unknown provider with no env key list', async () => {
    // Providers without configured credentials and without a known env-key list
    // report an empty missingEnvVars array and a clear provider-specific message.
    const discoveredProviderName = 'LM Studio (192.168.0.85)';
    const modelId = 'qwen2.5-coder-7b';
    const m1 = makeModel(discoveredProviderName, modelId);
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: [],
    });

    const req = makeRequest('PATCH', 'http://localhost/api/models/current', {
      registryKey: `${discoveredProviderName}:${modelId}`,
    });
    const res = await dispatchModelRoutes(req, context);
    expect(res!.status).toBe(409);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(body.missingEnvVars).toBeInstanceOf(Array);
    expect((body.missingEnvVars as string[]).length).toBe(0);
    const errorMsg = body.error as string;
    expect(errorMsg).not.toContain('<API key for');
    expect(errorMsg).toContain(discoveredProviderName);
  });
});

// ---------------------------------------------------------------------------
// Turn-time isConfigured guard (facade-composition)
// ---------------------------------------------------------------------------

describe('createCompanionProviderAdapter: isConfigured guard', () => {
  test('yields clean error when provider.isConfigured() returns false', async () => {
    const { createCompanionProviderAdapter } = await import(
      '../packages/sdk/src/platform/daemon/facade-composition.js'
    );

    const unconfiguredProvider = {
      name: 'venice',
      models: ['venice:llama-3.3-70b'],
      isConfigured: () => false,
      chat: async () => { throw new Error('Should not be called'); },
    };

    const mockRegistry = {
      getCurrentModel: () => ({ id: 'llama-3.3-70b', provider: 'venice', registryKey: 'venice:llama-3.3-70b' }),
      getForModel: () => unconfiguredProvider,
      listModels: () => [],
    } as unknown as ProviderRegistry;

    const adapter = createCompanionProviderAdapter(mockRegistry);
    const chunks: unknown[] = [];
    for await (const chunk of adapter.chatStream([{ role: 'user', content: 'hi' }], {})) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    const errChunk = chunks[0] as { type: string; error: string };
    expect(errChunk.type).toBe('error');
    expect(errChunk.error).toContain('venice');
    expect(errChunk.error).toContain('not configured');
  });

  test('proceeds normally when provider.isConfigured() returns true', async () => {
    const { createCompanionProviderAdapter } = await import(
      '../packages/sdk/src/platform/daemon/facade-composition.js'
    );

    const configuredProvider = {
      name: 'inception',
      models: ['inception:mercury-2'],
      isConfigured: () => true,
      chat: async () => ({
        content: 'Hello',
        toolCalls: [],
        model: 'mercury-2',
        provider: 'inception',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const mockRegistry = {
      getCurrentModel: () => ({ id: 'mercury-2', provider: 'inception', registryKey: 'inception:mercury-2' }),
      getForModel: () => configuredProvider,
      listModels: () => [{ id: 'mercury-2', provider: 'inception', registryKey: 'inception:mercury-2' }],
    } as unknown as ProviderRegistry;

    const adapter = createCompanionProviderAdapter(mockRegistry);
    const chunks: unknown[] = [];
    for await (const chunk of adapter.chatStream([{ role: 'user', content: 'hi' }], {})) {
      chunks.push(chunk);
    }
    const hasError = chunks.some((c) => (c as { type: string }).type === 'error');
    expect(hasError).toBe(false);
    const hasDone = chunks.some((c) => (c as { type: string }).type === 'done');
    expect(hasDone).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Router-level integration test — secretsManager wiring through DaemonHttpRouter
// ---------------------------------------------------------------------------

describe('DaemonHttpRouter: secretsManager wiring', () => {
  // Scoped env mutation: remove OPENAI_API_KEY so the env tier is skipped,
  // ensuring the secrets tier is exercised. Scoped to beforeEach/afterEach to
  // avoid any cross-file race in parallel test runners.
  let _savedOpenAiKey: string | undefined;
  beforeEach(() => {
    _savedOpenAiKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });
  afterEach(() => {
    if (_savedOpenAiKey !== undefined) process.env['OPENAI_API_KEY'] = _savedOpenAiKey;
    else delete process.env['OPENAI_API_KEY'];
  });
  /**
   * This test exercises the full production code path:
   *   Request → DaemonHttpRouter.dispatchApiRoutes
   *     → dispatchModelRoutes (with secretsManager threaded in)
   *       → handleListProviders → resolveSecretKeys → secretsManager.get
   *
   * If a future PR removes secretsManager from the DaemonHttpRouterContext
   * or forgets to pass it into the ModelRouteContext literal, this test
   * will fail because configuredVia will come back undefined instead of
   * 'secrets'.
   */
  test("GET /api/models returns configuredVia='secrets' via DaemonHttpRouter when secret is stored but no env var", async () => {
    const m1 = makeModel('openai', 'gpt-4o');
    const bus = makeRuntimeBus();

    const secretsManager = {
      get: async (key: string): Promise<string | null> => {
        if (key === 'OPENAI_API_KEY') return 'sk-test-secret-via-router';
        return null;
      },
    };

    // Only the fields exercised by the /api/models code path need real values.
    const registry = makeRegistry({ models: [m1], currentModel: m1, configuredIds: ['openai'], bus });
    const configManager = makeConfigManager();

    // Fields outside the /api/models path fail loudly if touched.
    const routerContext = {
      configManager,
      serviceRegistry: {} as never,
      userAuth: {} as never,
      agentManager: {} as never,
      automationManager: {} as never,
      approvalBroker: {} as never,
      controlPlaneGateway: {
        createEventStream: () => { throw new Error('not expected'); },
      } as never,
      gatewayMethods: {} as never,
      providerRegistry: registry,
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
      // THE CRITICAL FIELD UNDER TEST: secretsManager must be threaded in here
      secretsManager,
    };

    const router = new DaemonHttpRouter(routerContext as never);

    const req = new Request('http://localhost/api/models', { method: 'GET' });
    const res = await router.dispatchApiRoutes(req);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    const providers = body.providers as Array<Record<string, unknown>>;
    const openaiProv = providers.find((p) => p['id'] === 'openai');
    expect(openaiProv?.['id']).toBe('openai');
    // Without the secretsManager wiring, this would be false and configuredVia undefined
    expect(openaiProv!['configured']).toBe(true);
    expect(openaiProv!['configuredVia']).toBe('secrets');

    router.dispose();
  });
});
