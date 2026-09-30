/**
 * A remote model whose provider file states no real window gets the
 * models.dev catalog's figure.
 *
 * Live incident (abacusai): the old `/provider add` wrote `contextWindow:
 * 8192` for all 146 models of https://routellm.abacus.ai/v1, and the status
 * line read 8.2k for route-llm, whose catalog entry (provider `abacus`) says
 * 128000. Owner rulings 2026-09-29: a non-local model showing the default
 * 8192 is looked up in the models.dev data; when its own provider is not
 * there, the consensus across providers decides.
 *
 * Pins, in resolution order:
 * 1. the exact id under the provider's own catalog id (abacusai -> abacus);
 * 2. otherwise the value most providers listing the model share;
 * 3. a tie goes to the smaller value;
 * 4. vendor prefixes are ignored on both sides;
 * 5. the family default only when no provider lists the model;
 * and around it: a local provider keeps its figure, a user override wins,
 * a real provider-file value is kept, and an accepted request larger than
 * the catalog figure still raises it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import {
  getCatalogCachePath,
  getCatalogTmpPath,
  saveCatalogCache,
  type CatalogModel,
} from '../packages/sdk/src/platform/providers/model-catalog.js';
import { inferFallbackContextWindow } from '../packages/sdk/src/platform/providers/context-window-fallback.js';
import type { DiscoveredServer } from '../packages/sdk/src/platform/discovery/scanner.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistry(root: string): ProviderRegistry {
  return new ProviderRegistry({
    configManager: { get: () => undefined, getCategory: () => ({}), getControlPlaneConfigDir: () => root } as unknown as RegistryOptions['configManager'],
    subscriptionManager: { get: () => null, getPending: () => null, saveSubscription: async () => {}, resolveAccessToken: async () => null } as unknown as RegistryOptions['subscriptionManager'],
    capabilityRegistry: { getCapability: () => ({}), getRouteExplanation: () => ({ accepted: true }), invalidate: () => {}, setModelFactsSource: () => {} } as unknown as RegistryOptions['capabilityRegistry'],
    cacheHitTracker: { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'],
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'],
    benchmarkStore: { getBenchmarks: () => undefined, getTopBenchmarkModelIds: () => [] } as unknown as RegistryOptions['benchmarkStore'],
    secretsManager: {} as unknown as RegistryOptions['secretsManager'],
    serviceRegistry: {} as unknown as RegistryOptions['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

function entry(providerId: string, id: string, contextWindow: number): CatalogModel {
  return { id, name: id, provider: providerId, providerId, providerEnvVars: [], pricing: null, tier: 'paid', contextWindow };
}

const CATALOG: CatalogModel[] = [
  // 1. abacus lists route-llm itself.
  entry('abacus', 'route-llm', 128_000),
  // 2. glm-9 is not under abacus; three others list it, two agree.
  entry('zhipu', 'glm-9', 200_000),
  entry('deepinfra', 'glm-9', 200_000),
  entry('together', 'glm-9', 131_072),
  // 3. kimi-9: an even split.
  entry('moonshot', 'kimi-9', 262_144),
  entry('fireworks', 'kimi-9', 131_072),
  // 4. claude-sonnet-9: listed bare and vendor-prefixed.
  entry('anthropic', 'claude-sonnet-9', 1_000_000),
  entry('openrouter', 'anthropic/claude-sonnet-9', 1_000_000),
  entry('vertex', 'claude-sonnet-9', 200_000),
  // Local-provider case: the catalog knows this model too.
  entry('someone', 'qwen3-local', 262_144),
];

const CAPS = { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false };

function providerFile(root: string, name: string, baseURL: string, models: Array<{ id: string; contextWindow?: number }>): void {
  mkdirSync(join(root, 'providers'), { recursive: true });
  writeFileSync(join(root, 'providers', `${name}.json`), JSON.stringify({
    name,
    displayName: name,
    type: 'openai-compat',
    baseURL,
    models: models.map((m) => ({ id: m.id, displayName: m.id, ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}), capabilities: CAPS })),
  }));
}

async function withRegistry(
  setup: (root: string) => void,
  fn: (registry: ProviderRegistry, model: (key: string) => ModelDefinition) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gv-ctxwin-catalog-'));
  try {
    saveCatalogCache(CATALOG, getCatalogCachePath(root), getCatalogTmpPath(root));
    setup(root);
    const registry = makeRegistry(root);
    registry.initCatalog();
    await registry.loadCustomProviders();
    const model = (key: string): ModelDefinition => {
      const found = registry.listModels().find((m) => m.registryKey === key);
      if (!found) throw new Error(`model ${key} not in registry`);
      return found;
    };
    await fn(registry, model);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ABACUS = 'https://routellm.abacus.ai/v1';
const abacusFile = (root: string): void => providerFile(root, 'abacusai', ABACUS, [
  { id: 'route-llm', contextWindow: 8192 },
  { id: 'glm-9', contextWindow: 8192 },
  { id: 'kimi-9', contextWindow: 8192 },
  { id: 'claude-sonnet-9', contextWindow: 8192 },
  { id: 'anthropic/claude-sonnet-9', contextWindow: 8192 },
  { id: 'flux_pro', contextWindow: 8192 },
  { id: 'no-window-stated' },
  { id: 'measured-by-hand', contextWindow: 32_000 },
]);

describe('a remote model with the old 8192 guess resolves from the catalog', () => {
  test('1. its own catalog provider: abacusai route-llm is 128000 from abacus', async () => {
    await withRegistry(abacusFile, (registry, model) => {
      const m = model('abacusai:route-llm');
      expect(m.contextWindow).toBe(128_000);
      expect(m.contextWindowProvenance).toBe('catalog');
      expect(m.contextWindowOrigin).toEqual({ kind: 'catalog', catalogProviderId: 'abacus' });
      expect(registry.getKnownContextWindowForModel(m)).toBe(128_000);
      expect(registry.getContextWindowForModel(m)).toBe(128_000);
    });
  });

  test('2. absent from its own provider: the value most other providers share', async () => {
    await withRegistry(abacusFile, (registry, model) => {
      const m = model('abacusai:glm-9');
      expect(m.contextWindow).toBe(200_000);
      expect(m.contextWindowProvenance).toBe('catalog');
      expect(m.contextWindowOrigin).toEqual({ kind: 'consensus', providers: 3, agreeing: 2 });
      expect(registry.getKnownContextWindowForModel(m)).toBe(200_000);
    });
  });

  test('3. a tie goes to the smaller value', async () => {
    await withRegistry(abacusFile, (_registry, model) => {
      const m = model('abacusai:kimi-9');
      expect(m.contextWindow).toBe(131_072);
      expect(m.contextWindowOrigin).toEqual({ kind: 'consensus', providers: 2, agreeing: 1 });
    });
  });

  test('4. vendor-prefixed ids match, on the catalog side and on ours', async () => {
    await withRegistry(abacusFile, (_registry, model) => {
      // anthropic and openrouter (as anthropic/claude-sonnet-9) say 1M, vertex 200k.
      for (const key of ['abacusai:claude-sonnet-9', 'abacusai:anthropic/claude-sonnet-9']) {
        const m = model(key);
        expect(m.contextWindow).toBe(1_000_000);
        expect(m.contextWindowOrigin).toEqual({ kind: 'consensus', providers: 3, agreeing: 2 });
      }
    });
  });

  test('5. the family default only when no provider lists the model, and it stays a guess', async () => {
    await withRegistry(abacusFile, (registry, model) => {
      const m = model('abacusai:flux_pro');
      expect(m.contextWindow).toBe(inferFallbackContextWindow('abacusai', 'flux_pro'));
      expect(m.contextWindow).not.toBe(8192);
      expect(m.contextWindowProvenance).toBe('fallback');
      expect(m.contextWindowOrigin).toEqual({ kind: 'family_default' });
      expect(registry.getKnownContextWindowForModel(m)).toBeNull();
    });
  });

  test('a provider-file model with no window stated resolves the same way', async () => {
    await withRegistry(abacusFile, (_registry, model) => {
      const m = model('abacusai:no-window-stated');
      expect(m.contextWindow).not.toBe(8192);
      expect(m.contextWindowOrigin).toEqual({ kind: 'family_default' });
    });
  });

  test('a real provider-file value other than the old guess is kept', async () => {
    await withRegistry(abacusFile, (_registry, model) => {
      const m = model('abacusai:measured-by-hand');
      expect(m.contextWindow).toBe(32_000);
      expect(m.contextWindowProvenance).toBe('configured_cap');
      expect(m.contextWindowOrigin).toEqual({ kind: 'provider_file' });
    });
  });
});

describe('what the catalog never replaces', () => {
  test('a local provider keeps its own figure (custom file at a local address)', async () => {
    await withRegistry(
      (root) => providerFile(root, 'lmstudio-box', 'http://192.168.1.20:1234/v1', [{ id: 'qwen3-local', contextWindow: 8192 }]),
      (_registry, model) => {
        const m = model('lmstudio-box:qwen3-local');
        expect(m.contextWindow).toBe(8192);
        expect(m.contextWindowProvenance).toBe('configured_cap');
      },
    );
  });

  test('a local provider keeps its own figure (discovered server)', async () => {
    const server: DiscoveredServer = {
      name: 'ollama',
      host: '127.0.0.1',
      port: 11434,
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['qwen3-local'],
      serverType: 'ollama',
      modelContextWindows: { 'qwen3-local': 8192 },
    };
    await withRegistry(() => {}, (registry, model) => {
      registry.registerDiscoveredProviders([server]);
      const m = model('ollama:qwen3-local');
      expect(m.contextWindow).toBe(8192);
      expect(m.contextWindowProvenance).toBe('provider_api');
    });
  });

  test('a user override wins over the catalog figure', async () => {
    await withRegistry(abacusFile, (registry, model) => {
      registry.setModelContextCap('abacusai:route-llm', 50_000);
      const m = model('abacusai:route-llm');
      expect(m.contextWindow).toBe(50_000);
      expect(m.contextWindowProvenance).toBe('configured_cap');
      expect(m.contextWindowOrigin).toEqual({ kind: 'user_override' });
      registry.clearModelContextCap('abacusai:route-llm');
      expect(model('abacusai:route-llm').contextWindow).toBe(128_000);
    });
  });

  test('an accepted request smaller than the catalog figure leaves it; a larger one raises it', async () => {
    await withRegistry(abacusFile, (registry, model) => {
      // The live floor on the owner's machine: 39038 was accepted while the file said 8192.
      registry.reconcileObservedContextWindow('abacusai:route-llm', 39_038);
      expect(model('abacusai:route-llm').contextWindow).toBe(128_000);
      expect(model('abacusai:route-llm').contextWindowProvenance).toBe('catalog');

      registry.reconcileObservedContextWindow('abacusai:route-llm', 150_000);
      const m = model('abacusai:route-llm');
      expect(m.contextWindowProvenance).toBe('accepted_floor');
      expect(m.contextWindow).toBe(150_000);
      expect(registry.getContextWindowForModel(m)).toBe(150_000);
    });
  });
});
