/**
 * Unit tests for the canonical ProviderRegistry.has() / .get() / .require() API.
 *
 * These tests use lightweight test doubles so no real providers or heavy
 * dependencies are instantiated. Providers are registered through the public
 * ProviderRegistry API to keep the tests fast and isolated.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { ProviderNotFoundError } from '../packages/sdk/src/platform/providers/provider-not-found-error.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import {
  getCatalogCachePath,
  getCatalogTmpPath,
  saveCatalogCache,
  type CatalogModel,
} from '../packages/sdk/src/platform/providers/model-catalog.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeProvider(name: string): LLMProvider {
  return {
    name,
    chat: async () => { throw new Error('not implemented'); },
    stream: async function* () { /* empty */ },
  } as unknown as LLMProvider;
}

/** Build a ProviderRegistry with the minimum required options provided by test doubles. */
function makeRegistry(
  root = '/tmp/test-registry',
  config: Readonly<Record<string, unknown>> = {},
): ProviderRegistry {
  const configManager = {
    get: (key: string) => config[key],
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => root,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'];

  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'];

  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'];

  const cacheHitTracker = {
    record: () => {},
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'];

  const favoritesStore = {
    load: async () => ({ pinned: [], history: [] }),
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'];

  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'];

  const secretsManager = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'];
  const serviceRegistry = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'];

  return new ProviderRegistry({
    configManager,
    subscriptionManager,
    capabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    secretsManager,
    serviceRegistry,
    featureFlags: null,
    runtimeBus: null,
  });
}

function makeCatalogModel(id: string, providerId: string): CatalogModel {
  return {
    id,
    name: id,
    provider: providerId,
    providerId,
    providerEnvVars: [],
    pricing: { input: 1, output: 1 },
    tier: 'paid',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  };
}

function writeCustomProvider(root: string, name: string, modelId: string): void {
  const providersDir = join(root, 'providers');
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(join(providersDir, `${name}.json`), JSON.stringify({
    name,
    displayName: name,
    type: 'openai-compat',
    baseURL: `https://${name}.example.test/v1`,
    models: [{
      id: modelId,
      displayName: modelId,
      contextWindow: 8192,
      capabilities: {
        toolCalling: true,
        codeEditing: false,
        reasoning: false,
        multimodal: false,
      },
    }],
  }));
}

// ---------------------------------------------------------------------------
// has()
// ---------------------------------------------------------------------------

describe('ProviderRegistry.has()', () => {
  test('returns true for a registered provider', () => {
    const registry = makeRegistry();
    registry.register(makeProvider('anthropic'));
    expect(registry.has('anthropic')).toBe(true);
  });

  test('returns false for an unknown provider', () => {
    const registry = makeRegistry();
    expect(registry.has('does-not-exist')).toBe(false);
  });

  test('returns false before registration, true after', () => {
    const registry = makeRegistry();
    // Use a name that is definitely not a builtin provider
    const customId = '__test_custom_xyz__';
    expect(registry.has(customId)).toBe(false);
    registry.register(makeProvider(customId));
    expect(registry.has(customId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tryGet() — nullable lookup, never throws
// ---------------------------------------------------------------------------

describe('ProviderRegistry.tryGet()', () => {
  test('returns the provider instance for a registered provider', () => {
    const registry = makeRegistry();
    const provider = makeProvider('openrouter');
    registry.register(provider);
    expect(registry.tryGet('openrouter')).toBe(provider);
  });

  test('returns undefined for an unknown provider (no throw)', () => {
    const registry = makeRegistry();
    expect(() => registry.tryGet('missing')).not.toThrow();
    expect(registry.tryGet('missing')).toBeUndefined();
  });

  test('returns undefined for multiple unknown providers', () => {
    const registry = makeRegistry();
    expect(registry.tryGet('alpha')).toBeUndefined();
    expect(registry.tryGet('beta')).toBeUndefined();
  });

  test('returns undefined before registration, provider after', () => {
    const registry = makeRegistry();
    const customId = '__test_tryget_xyz__';
    expect(registry.tryGet(customId)).toBeUndefined();
    const provider = makeProvider(customId);
    registry.register(provider);
    expect(registry.tryGet(customId)).toBe(provider);
  });
});

// ---------------------------------------------------------------------------
// require()
// ---------------------------------------------------------------------------

describe('ProviderRegistry.require()', () => {
  test('returns the provider for a registered name', () => {
    const registry = makeRegistry();
    const provider = makeProvider('ollama');
    registry.register(provider);
    expect(registry.require('ollama')).toBe(provider);
  });

  test('throws ProviderNotFoundError for an unregistered provider', () => {
    const registry = makeRegistry();
    registry.register(makeProvider('anthropic'));
    registry.register(makeProvider('openai'));
    expect(() => registry.require('missing')).toThrow(ProviderNotFoundError);
  });

  test('error message includes the requested provider ID', () => {
    const registry = makeRegistry();
    registry.register(makeProvider('anthropic'));
    const caught = (() => { try { registry.require('phantom'); } catch (e) { return e; } })();
    expect(caught).toBeInstanceOf(ProviderNotFoundError);
    expect((caught as ProviderNotFoundError).message).toContain('phantom');
  });

  test('error message lists available provider IDs', () => {
    const registry = makeRegistry();
    registry.register(makeProvider('alpha'));
    registry.register(makeProvider('beta'));
    const caught = (() => { try { registry.require('unknown'); } catch (e) { return e; } })();
    expect(caught).toBeInstanceOf(ProviderNotFoundError);
    const err = caught as ProviderNotFoundError;
    // The message should include the available provider names
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
    // availableIds should include at least alpha and beta
    expect(err.availableIds).toContain('alpha');
    expect(err.availableIds).toContain('beta');
  });

  test('ProviderNotFoundError has correct providerId property', () => {
    const registry = makeRegistry();
    const caught = (() => { try { registry.require('ghost'); } catch (e) { return e; } })();
    expect(caught).toBeInstanceOf(ProviderNotFoundError);
    expect((caught as ProviderNotFoundError).providerId).toBe('ghost');
  });

  test('instanceof check works correctly', () => {
    const err = new ProviderNotFoundError('test-provider', ['alpha', 'beta']);
    expect(err instanceof ProviderNotFoundError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe('ProviderNotFoundError');
    expect(err.availableIds).toEqual(['alpha', 'beta']);
  });
});

describe('ProviderRegistry model catalog cache', () => {
  test('initCatalog invalidates model registry built before cached catalog load', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-registry-'));
    try {
      const registry = makeRegistry(root);
      expect(registry.listModels().some((model) => model.registryKey === 'openai:gpt-5.4')).toBe(false);
      saveCatalogCache(
        [makeCatalogModel('gpt-5.4', 'openai')],
        getCatalogCachePath(root),
        getCatalogTmpPath(root),
      );
      registry.initCatalog();
      expect(registry.listModels().some((model) => model.registryKey === 'openai:gpt-5.4')).toBe(true);
      expect(() => registry.getForModel('gpt-5.4')).toThrow(
        "Model lookup requires a provider-qualified registryKey; received 'gpt-5.4'.",
      );
      expect(registry.getForModel('openai:gpt-5.4').name).toBe('openai');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bare OpenAI model IDs are not guessed when local catalog is stale', () => {
    const registry = makeRegistry();
    expect(() => registry.getForModel('gpt-5.4')).toThrow(
      "Model lookup requires a provider-qualified registryKey; received 'gpt-5.4'.",
    );
    expect(() => registry.getForModel('gpt-5.4', 'openai')).toThrow(
      "No model 'gpt-5.4' for provider 'openai' in registry.",
    );
    expect(() => registry.getForModel('gpt-5.4', 'anthropic')).toThrow(
      "No model 'gpt-5.4' for provider 'anthropic' in registry.",
    );
  });

  test('configured bare model requires explicit provider identity', () => {
    expect(() => makeRegistry('/tmp/test-registry', { 'provider.model': 'gpt-5.4' })).toThrow(
      "provider.model must be a provider-qualified registryKey; received 'gpt-5.4'.",
    );
  });

  test('model selection rejects bare model ids without a provider', () => {
    const registry = makeRegistry();
    expect(() => registry.getForModel('gpt-5.4')).toThrow(
      "Model lookup requires a provider-qualified registryKey; received 'gpt-5.4'.",
    );
    expect(() => registry.setCurrentModel('gpt-5.4')).toThrow(
      "Model selection requires a provider-qualified registryKey; received 'gpt-5.4'.",
    );
    expect(() => registry.getCapabilityForModel('gpt-5.4')).toThrow(
      "Model capability lookups require a provider-qualified registryKey; received 'gpt-5.4'.",
    );
  });

  test('custom provider changes and catalog override warnings use registry keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-registry-'));
    try {
      saveCatalogCache(
        [makeCatalogModel('shared-model', 'openai')],
        getCatalogCachePath(root),
        getCatalogTmpPath(root),
      );
      writeCustomProvider(root, 'openai', 'shared-model');
      writeCustomProvider(root, 'custom-ai', 'shared-model');

      const registry = makeRegistry(root);
      registry.initCatalog();
      const result = await registry.loadCustomProviders();

      expect(result.added).toContain('openai:shared-model');
      expect(result.added).toContain('custom-ai:shared-model');
      expect(result.warnings).toContain("[registry] Custom model 'openai:shared-model' overrides catalog model.");
      expect(result.warnings.some((warning) => warning.includes("'custom-ai:shared-model' overrides"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
