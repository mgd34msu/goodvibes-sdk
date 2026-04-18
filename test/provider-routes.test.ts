/**
 * provider-routes.test.ts
 *
 * Tests for:
 *   GET    /api/providers
 *   GET    /api/providers/current
 *   PATCH  /api/providers/current
 *   Turn-time isConfigured guard in createCompanionProviderAdapter
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { dispatchProviderRoutes } from '../packages/sdk/src/_internal/platform/daemon/http/provider-routes.js';
import type { ProviderRouteContext } from '../packages/sdk/src/_internal/platform/daemon/http/provider-routes.js';
import type { RuntimeEventBus } from '../packages/sdk/src/_internal/platform/runtime/events/index.js';
import type { ProviderRegistry } from '../packages/sdk/src/_internal/platform/providers/registry.js';
import type { ConfigManager } from '../packages/sdk/src/_internal/platform/config/manager.js';
import type { ModelDefinition } from '../packages/sdk/src/_internal/platform/providers/registry-types.js';

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

function makeRuntimeBus(): RuntimeEventBus & { emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    emitted,
    emit(domain: string, envelope: unknown) { emitted.push({ domain, envelope }); },
    on: () => () => {},
    onDomain: () => () => {},
    once: () => () => {},
    off: () => {},
  } as unknown as RuntimeEventBus & { emitted: unknown[] };
}

function makeRegistry(opts: {
  models?: ModelDefinition[];
  currentModel?: ModelDefinition;
  configuredIds?: string[];
  setCurrentModelThrows?: string;
}): ProviderRegistry {
  const models = opts.models ?? [];
  const current = opts.currentModel ?? models[0];
  const configuredIds = opts.configuredIds ?? [];

  return {
    listModels: () => models,
    getCurrentModel: () => {
      if (!current) throw new Error('No current model');
      return current;
    },
    getConfiguredProviderIds: () => configuredIds,
    setCurrentModel: (modelId: string) => {
      if (opts.setCurrentModelThrows) throw new Error(opts.setCurrentModelThrows);
      // no-op for tests (event emission is tested via registry unit tests)
    },
  } as unknown as ProviderRegistry;
}

function makeConfigManager(): ConfigManager {
  return {
    set: () => {},
  } as unknown as ConfigManager;
}

function makeContext(registryOpts: Parameters<typeof makeRegistry>[0]): {
  context: ProviderRouteContext;
  bus: RuntimeEventBus & { emitted: unknown[] };
} {
  const bus = makeRuntimeBus();
  const context: ProviderRouteContext = {
    providerRegistry: makeRegistry(registryOpts),
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

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------

describe('GET /api/providers', () => {
  test('returns provider list with models and configured flags', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('venice', 'llama-3.3-70b');
    const { context } = makeContext({
      models: [m1, m2],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('GET', 'http://localhost/api/providers');
    const res = await dispatchProviderRoutes(req, context);
    expect(res).not.toBeNull();
    const body = await res!.json() as Record<string, unknown>;
    expect(body.providers).toBeInstanceOf(Array);
    const providers = body.providers as Array<Record<string, unknown>>;

    const inceptionProv = providers.find((p) => p['id'] === 'inception');
    expect(inceptionProv).toBeDefined();
    expect(inceptionProv!['configured']).toBe(true);

    const veniceProv = providers.find((p) => p['id'] === 'venice');
    expect(veniceProv).toBeDefined();
    expect(veniceProv!['configured']).toBe(false);

    const currentModel = body.currentModel as Record<string, unknown> | null;
    expect(currentModel).not.toBeNull();
    expect(currentModel!['provider']).toBe('inception');
    expect(currentModel!['registryKey']).toBe('inception:mercury-2');
  });

  test('returns correct model entries with registryKey', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('GET', 'http://localhost/api/providers');
    const res = await dispatchProviderRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    const providers = body.providers as Array<Record<string, unknown>>;
    const inceptionProv = providers.find((p) => p['id'] === 'inception')!;
    const models = inceptionProv['models'] as Array<Record<string, unknown>>;
    expect(models[0]!['registryKey']).toBe('inception:mercury-2');
    expect(models[0]!['id']).toBe('mercury-2');
  });

  test('returns null currentModel when no model configured', async () => {
    const { context } = makeContext({ models: [], configuredIds: [] });

    const req = makeRequest('GET', 'http://localhost/api/providers');
    const res = await dispatchProviderRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.currentModel).toBeNull();
  });

  test('returns null for non-matching paths', async () => {
    const { context } = makeContext({ models: [] });
    const req = makeRequest('GET', 'http://localhost/api/other');
    const res = await dispatchProviderRoutes(req, context);
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/providers/current
// ---------------------------------------------------------------------------

describe('GET /api/providers/current', () => {
  test('returns current model ref and configured=true when env key present', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({
      models: [m1],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('GET', 'http://localhost/api/providers/current');
    const res = await dispatchProviderRoutes(req, context);
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

    const req = makeRequest('GET', 'http://localhost/api/providers/current');
    const res = await dispatchProviderRoutes(req, context);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.model).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/providers/current
// ---------------------------------------------------------------------------

describe('PATCH /api/providers/current', () => {
  test('succeeds with known registryKey and returns new current model', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const m2 = makeModel('inception', 'mercury-edit');
    const { context, bus } = makeContext({
      models: [m1, m2],
      currentModel: m1,
      configuredIds: ['inception'],
    });

    const req = makeRequest('PATCH', 'http://localhost/api/providers/current', {
      registryKey: 'inception:mercury-edit',
    });
    const res = await dispatchProviderRoutes(req, context);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.model).not.toBeNull();

    // bus should have received model.changed emission
    const modelChangedEmit = (bus.emitted as Array<{ domain: string; envelope: { type: string } }>)
      .find((e) => e.domain === 'providers' && e.envelope.type === 'MODEL_CHANGED');
    expect(modelChangedEmit).toBeDefined();
  });

  test('returns 400 MODEL_NOT_FOUND for unknown registryKey', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('PATCH', 'http://localhost/api/providers/current', {
      registryKey: 'inception:nonexistent-model',
    });
    const res = await dispatchProviderRoutes(req, context);
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

    const req = makeRequest('PATCH', 'http://localhost/api/providers/current', {
      registryKey: 'venice:llama-3.3-70b',
    });
    const res = await dispatchProviderRoutes(req, context);
    expect(res!.status).toBe(409);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(Array.isArray(body.missingEnvVars)).toBe(true);
    // Venice env vars from BUILTIN_PROVIDER_ENV_KEYS
    const missingEnvVars = body.missingEnvVars as string[];
    expect(missingEnvVars).toContain('VENICE_API_KEY');
  });

  test('returns 400 INVALID_REQUEST when registryKey is missing', async () => {
    const m1 = makeModel('inception', 'mercury-2');
    const { context } = makeContext({ models: [m1], currentModel: m1, configuredIds: ['inception'] });

    const req = makeRequest('PATCH', 'http://localhost/api/providers/current', {});
    const res = await dispatchProviderRoutes(req, context);
    expect(res!.status).toBe(400);
    const body = await res!.json() as Record<string, unknown>;
    expect(body.code).toBe('INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Turn-time isConfigured guard (facade-composition)
// ---------------------------------------------------------------------------

describe('createCompanionProviderAdapter: isConfigured guard', () => {
  test('yields clean error when provider.isConfigured() returns false', async () => {
    const { createCompanionProviderAdapter } = await import(
      '../packages/sdk/src/_internal/platform/daemon/facade-composition.js'
    );

    const unconfiguredProvider = {
      name: 'venice',
      models: ['venice:llama-3.3-70b'],
      isConfigured: () => false,
      chat: async () => { throw new Error('Should not be called'); },
    };

    const mockRegistry = {
      getCurrentModel: () => ({ id: 'llama-3.3-70b', provider: 'venice' }),
      getForModel: () => unconfiguredProvider,
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
      '../packages/sdk/src/_internal/platform/daemon/facade-composition.js'
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
      getCurrentModel: () => ({ id: 'mercury-2', provider: 'inception' }),
      getForModel: () => configuredProvider,
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
