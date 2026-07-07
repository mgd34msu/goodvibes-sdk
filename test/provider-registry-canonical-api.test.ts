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
import { getProviderUsageSnapshot } from '../packages/sdk/src/platform/providers/runtime-snapshot.js';
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

function makeProvider(name: string, models: readonly string[] = []): LLMProvider {
  return {
    name,
    models: [...models],
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

// ---------------------------------------------------------------------------
// getCurrentModel() — fresh-home fallback for the well-known configured default
// ---------------------------------------------------------------------------
//
// Root cause (D7b): buildModelRegistry() only draws from custom/runtime/
// synthetic/catalog/discovered models. The catalog is populated exclusively
// by an async models.dev fetch (initProviderCatalog/refreshProviderCatalog),
// which is never awaited at construction time — so on a fresh daemon home
// (no cache file yet) or while offline, getModelRegistry() is missing every
// catalog-sourced entry, including the stock default 'openrouter:openrouter/
// free', and getCurrentModel() throws for the entire lifetime of a catalog-
// less boot. ProviderRegistry.buildConfiguredModelFallback() closes that gap
// by synthesizing a minimal definition when the configured registryKey names
// an actually-registered provider whose own static `models` list already
// declares that id — narrow enough that a genuinely bad ref still throws.
describe('ProviderRegistry.getCurrentModel() — fresh-home default fallback', () => {
  test('the stock default resolves with no catalog cache and no initCatalog() call', () => {
    const registry = makeRegistry();
    const current = registry.getCurrentModel();
    expect(current.registryKey).toBe('openrouter:openrouter/free');
    expect(current.provider).toBe('openrouter');
    expect(current.id).toBe('openrouter/free');
    expect(current.tier).toBe('free');
    expect(current.selectable).toBe(true);
    expect(current.contextWindowProvenance).toBe('fallback');
  });

  test('a genuinely unknown provider in the configured ref still throws honestly', () => {
    const registry = makeRegistry('/tmp/test-registry', { 'provider.model': 'ghost-provider:ghost-model' });
    expect(() => registry.getCurrentModel()).toThrow(
      "Current model 'ghost-provider:ghost-model' not in registry.",
    );
  });

  test('a registered provider whose own model list omits the configured id still throws honestly', () => {
    const registry = makeRegistry('/tmp/test-registry', { 'provider.model': 'openrouter:not-a-real-model' });
    expect(() => registry.getCurrentModel()).toThrow(
      "Current model 'openrouter:not-a-real-model' not in registry.",
    );
  });

  test('once the catalog hydrates, the real catalog entry wins over the fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-registry-'));
    try {
      saveCatalogCache(
        [{ ...makeCatalogModel('openrouter/free', 'openrouter'), tier: 'free', pricing: { input: 0, output: 0 }, contextWindow: 32_000 }],
        getCatalogCachePath(root),
        getCatalogTmpPath(root),
      );
      const registry = makeRegistry(root);
      registry.initCatalog();
      const current = registry.getCurrentModel();
      expect(current.registryKey).toBe('openrouter:openrouter/free');
      // Sourced from the catalog now, not the synthesized fallback.
      expect(current.contextWindowProvenance).not.toBe('fallback');
      expect(current.contextWindow).toBe(32_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getProviderUsageSnapshot() — defense in depth for GET /api/providers/:id/usage
// ---------------------------------------------------------------------------
//
// getProviderUsageSnapshot() makes its own, separate getCurrentModel() call
// after buildSnapshotForProvider() (which already tolerates an unresolved
// current model). Before this fix that second call was unguarded, so a
// configured model that still can't resolve — even after the fallback above —
// turned this into an unhandled throw instead of an honest JSON payload.
describe('getProviderUsageSnapshot() — honest degrade on an unresolvable current model', () => {
  test('reports the resolved default cleanly for the provider that owns it', async () => {
    const registry = makeRegistry();
    // Swap the real builtin 'openrouter' (whose describeRuntime() needs full
    // secrets/service-registry deps this test double doesn't provide) for a
    // minimal stub that still declares 'openrouter/free' — register()
    // overwrites by name, so buildConfiguredModelFallback still matches.
    registry.register(makeProvider('openrouter', ['openrouter/free']));
    const snapshot = await getProviderUsageSnapshot(registry, 'openrouter');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.active).toBe(true);
    expect(snapshot?.currentModelRegistryKey).toBe('openrouter:openrouter/free');
  });

  test('does not throw and omits currentModelRegistryKey when the configured ref is unresolvable', async () => {
    const registry = makeRegistry('/tmp/test-registry', { 'provider.model': 'ghost-provider:ghost-model' });
    registry.register(makeProvider('anthropic'));
    const snapshot = await getProviderUsageSnapshot(registry, 'anthropic');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.active).toBe(false);
    expect(snapshot?.currentModelRegistryKey).toBeUndefined();
  });

  test('returns null for a provider that is not registered at all (route 404s honestly)', async () => {
    const registry = makeRegistry();
    const snapshot = await getProviderUsageSnapshot(registry, 'not-a-real-provider');
    expect(snapshot).toBeNull();
  });
});
