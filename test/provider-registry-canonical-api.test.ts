/**
 * Unit tests for the canonical ProviderRegistry.has() / .get() / .require() API.
 *
 * These tests use a minimal stub-based approach — no real providers or heavy
 * dependencies are instantiated. We create a bare-minimum ProviderRegistry
 * instance and directly manipulate its internal Map via register() so the
 * tests remain fast and isolated.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/_internal/platform/providers/registry.js';
import { ProviderNotFoundError } from '../packages/sdk/src/_internal/platform/providers/provider-not-found-error.js';
import type { LLMProvider } from '../packages/sdk/src/_internal/platform/providers/interface.js';
import {
  getCatalogCachePath,
  getCatalogTmpPath,
  saveCatalogCache,
  type CatalogModel,
} from '../packages/sdk/src/_internal/platform/providers/model-catalog.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeProvider(name: string): LLMProvider {
  return {
    name,
    chat: async () => { throw new Error('not implemented'); },
    stream: async function* () { /* empty */ },
  } as unknown as LLMProvider;
}

/** Build a ProviderRegistry with the minimum required options stubbed out. */
function makeRegistry(root = '/tmp/test-registry'): ProviderRegistry {
  const configManager = {
    get: () => undefined,
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
    load: async () => ({ pinned: [], recent: [], byModelId: {} }),
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
// get() — deprecated alias for require(), throwing semantics
// ---------------------------------------------------------------------------

describe('ProviderRegistry.get()', () => {
  test('returns the provider instance for a registered provider', () => {
    const registry = makeRegistry();
    const provider = makeProvider('openrouter');
    registry.register(provider);
    expect(registry.get('openrouter')).toBe(provider);
  });

  test('throws ProviderNotFoundError for an unknown provider', () => {
    const registry = makeRegistry();
    expect(() => registry.get('missing')).toThrow(ProviderNotFoundError);
  });

  test('throws for multiple unknown providers', () => {
    const registry = makeRegistry();
    expect(() => registry.get('alpha')).toThrow(ProviderNotFoundError);
    expect(() => registry.get('beta')).toThrow(ProviderNotFoundError);
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
    let caught: unknown;
    try {
      registry.require('phantom');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderNotFoundError);
    expect((caught as ProviderNotFoundError).message).toContain('phantom');
  });

  test('error message lists available provider IDs', () => {
    const registry = makeRegistry();
    registry.register(makeProvider('alpha'));
    registry.register(makeProvider('beta'));
    let caught: unknown;
    try {
      registry.require('unknown');
    } catch (e) {
      caught = e;
    }
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
    let caught: unknown;
    try {
      registry.require('ghost');
    } catch (e) {
      caught = e;
    }
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explicit OpenAI selection can use provider when local catalog is stale', () => {
    const registry = makeRegistry();
    const provider = registry.getForModel('gpt-5.4', 'openai');
    expect(provider.name).toBe('openai');
    expect(() => registry.getForModel('gpt-5.4', 'anthropic')).toThrow(
      "No model 'gpt-5.4' for provider 'anthropic' in registry.",
    );
  });
});
