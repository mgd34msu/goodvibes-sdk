import { afterEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FavoritesStore } from '../packages/sdk/src/platform/providers/favorites.js';
import { GitHubCopilotProvider, getGitHubCopilotTokenCachePath } from '../packages/sdk/src/platform/providers/github-copilot.js';
import { BenchmarkStore } from '../packages/sdk/src/platform/providers/model-benchmarks.js';
import { fetchCatalog, getCatalogModelDefinitionsFrom, loadCatalogCache, type CatalogModel } from '../packages/sdk/src/platform/providers/model-catalog.js';
import { ModelLimitsService } from '../packages/sdk/src/platform/providers/model-limits.js';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { DiscoveredServer } from '../packages/sdk/src/platform/discovery/scanner.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function warningMessages(warnSpy: Mock<typeof logger.warn>): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

function makeCatalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'model-a',
    name: 'Model A',
    provider: 'Provider A',
    providerId: 'provider-a',
    providerEnvVars: [],
    pricing: { input: 1, output: 1 },
    tier: 'paid',
    ...overrides,
  };
}

function makeRegistry(root: string): ProviderRegistry {
  return new ProviderRegistry({
    configManager: {
      get: (key: string) => key === 'provider.model' ? 'openrouter:openrouter/free' : undefined,
      getCategory: () => ({}),
      getControlPlaneConfigDir: () => root,
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'],
    subscriptionManager: {
      get: () => null,
      getPending: () => null,
      saveSubscription: async () => {},
      resolveAccessToken: async () => null,
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'],
    capabilityRegistry: {
      getCapability: () => ({}),
      getRouteExplanation: () => ({ accepted: true }),
      invalidate: () => {},
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) },
    benchmarkStore: {
      getBenchmarks: () => undefined,
      getTopBenchmarkModelIds: () => [],
    },
    secretsManager: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'],
    serviceRegistry: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

describe('provider cache observability', () => {
  test('model catalog cache warns when persisted shape is malformed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-cache-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const cachePath = join(tmp, 'model-catalog.json');
      writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 1000 }), 'utf-8');

      expect(loadCatalogCache(cachePath)).toBeNull();
      expect(warningMessages(warnSpy)).toContain('[model-catalog] Ignoring malformed cache');
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('model limits cache warns when persisted shape is malformed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-limits-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const cachePath = join(tmp, 'model-limits.json');
      writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 1000, models: [] }), 'utf-8');

      globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
      new ModelLimitsService({ cachePath }).init();

      expect(warningMessages(warnSpy)).toContain('[model-limits] Ignoring malformed cache');
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('benchmark cache warns when persisted shape is malformed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-benchmarks-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }), { status: 200 });
    try {
      const cachePath = join(tmp, 'benchmarks.json');
      writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: Date.now(), ttlMs: 1000 }), 'utf-8');

      new BenchmarkStore({ dir: tmp }).initBenchmarks();

      expect(warningMessages(warnSpy)).toContain('[model-benchmarks] Ignoring malformed cache');
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('favorites load warns when persisted JSON cannot be parsed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-favorites-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const path = join(tmp, 'favorites.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{ bad json', 'utf-8');

      await expect(new FavoritesStore({ dir: tmp }).load()).rejects.toThrow();
      expect(warningMessages(warnSpy)).toContain('[favorites] Favorites load failed; preserving existing file');
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('github copilot token exchange warns when persisted token cache is malformed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-copilot-'));
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    try {
      const tokenCachePath = getGitHubCopilotTokenCachePath(tmp);
      mkdirSync(dirname(tokenCachePath), { recursive: true });
      writeFileSync(tokenCachePath, JSON.stringify({ token: '', expiresAt: 'bad', updatedAt: Date.now() }), 'utf-8');
      const provider = new GitHubCopilotProvider({
        tokenCachePath,
        env: { COPILOT_GITHUB_TOKEN: 'gh-test-token' },
        fetchFn: async () => {
          throw new Error('stop after cache read');
        },
      });

      await provider.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }).catch(() => undefined);

      expect(warningMessages(warnSpy)).toContain('[github-copilot] Ignoring malformed token cache');
    } finally {
      warnSpy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('remote provider catalog fetch warns about malformed provider entries while keeping valid models', async () => {
    const warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
    globalThis.fetch = async () => new Response(JSON.stringify({
      good: {
        name: 'Good Provider',
        env: [],
        models: {
          good: {
            id: 'good-model',
            name: 'Good Model',
            cost: { input: 1, output: 2 },
            limit: { context: 4096, output: 1024 },
          },
        },
      },
      badProvider: null,
      badModels: { name: 'Bad Models', models: [] },
      badModelEntry: { name: 'Bad Model Entry', models: { broken: null } },
    }), { status: 200 });
    try {
      const models = await fetchCatalog();

      expect(models.map((model) => model.id)).toEqual(['good-model']);
      expect(warningMessages(warnSpy)).toContain('[model-catalog] Ignored malformed catalog entries');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('provider context-window provenance', () => {
  test('catalog default context windows carry fallback provenance', () => {
    const [model] = getCatalogModelDefinitionsFrom([makeCatalogModel({ contextWindow: undefined })]);

    expect(model?.contextWindow).toBe(128_000);
    expect(model?.contextWindowProvenance).toBe('fallback');
  });

  test('discovered providers tag default context windows as fallback', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gv-provider-provenance-'));
    try {
      const registry = makeRegistry(tmp);
      const server: DiscoveredServer = {
        name: 'local-test',
        host: '127.0.0.1',
        port: 1234,
        baseURL: 'http://127.0.0.1:1234/v1',
        models: ['llama3'],
        serverType: 'unknown',
      };

      registry.registerDiscoveredProviders([server]);
      const model = registry.listModels().find((entry) => entry.registryKey === 'local-test:llama3');

      expect(model?.contextWindow).toBe(8192);
      expect(model?.contextWindowProvenance).toBe('fallback');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
