/**
 * The registry-level "picker-open re-check" hook: ProviderRegistry.refreshLiveModelDiscovery()
 * is what a picker-open handler (or an explicit user refresh command) calls. Proves, under a
 * mocked provider API, that a brand-new model neither the registry's static baseline nor the
 * third-party catalog knows about yet becomes selectable immediately after the check — the
 * root problem this item exists to fix.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import { ANTHROPIC_DATED_STATIC_MODELS } from '../packages/sdk/src/platform/providers/anthropic.js';

// Each registry gets its own fresh persistence root so the on-disk
// provider-models cache never leaks state between tests (or between runs).
function makeRegistry(): ProviderRegistry {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-provider-registry-live-model-discovery-'));
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
  const cacheHitTracker = { record: () => {} } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'];
  const favoritesStore = { load: async () => ({ pinned: [], history: [] }) } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'];
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

async function withMockedFetch<T>(
  handler: (url: string) => Response | Promise<Response>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const original = globalThis.fetch;
  // @ts-expect-error — test double, narrower than the full fetch overload set
  globalThis.fetch = async (url: string | URL | Request) => handler(String(url));
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe('ProviderRegistry.refreshLiveModelDiscovery — the picker-open re-check hook', () => {
  test('a brand-new model from a mocked Anthropic /v1/models response becomes selectable', async () => {
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
    try {
      const registry = makeRegistry();

      // Before any refresh: the brand-new model is not selectable yet.
      expect(registry.listModels().some((m) => m.registryKey === 'anthropic:claude-brand-new-model')).toBe(false);

      await withMockedFetch(
        (url) => {
          if (url.includes('api.anthropic.com/v1/models')) {
            return new Response(
              JSON.stringify({
                data: [...ANTHROPIC_DATED_STATIC_MODELS, 'claude-brand-new-model'].map((id) => ({ id })),
              }),
              { status: 200 },
            );
          }
          // Any other provider's live-discovery call in this sweep — fail closed to dated-static.
          return new Response('not found', { status: 404 });
        },
        async () => {
          const reports = await registry.refreshLiveModelDiscovery('anthropic', { force: true });
          expect(reports.length).toBe(1);
          expect(reports[0]!.providerId).toBe('anthropic');
          expect(reports[0]!.source).toBe('live');
          expect(reports[0]!.added).toContain('claude-brand-new-model');
        },
      );

      // After the picker-open re-check: the brand-new model is selectable and
      // the existing catalog-backed models are untouched.
      const models = registry.listModels();
      const newModel = models.find((m) => m.registryKey === 'anthropic:claude-brand-new-model');
      expect(newModel).toBeDefined();
      expect(newModel!.selectable).toBe(true);
      expect(newModel!.provider).toBe('anthropic');
    } finally {
      if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = originalKey;
    }
  });

  test('refreshLiveModelDiscovery with no providerId sweeps every provider that implements refreshModels()', async () => {
    const registry = makeRegistry();
    await withMockedFetch(
      () => new Response('offline', { status: 500 }),
      async () => {
        const reports = await registry.refreshLiveModelDiscovery(undefined, { force: true });
        const providerIds = reports.map((r) => r.providerId);
        // Anthropic, OpenAI, and Gemini all implement refreshModels().
        expect(providerIds).toContain('anthropic');
        expect(providerIds).toContain('openai');
        expect(providerIds).toContain('gemini');
        // Gateway/compat providers implement refreshModels() too, so the
        // sweep covers them; with the endpoint offline each reports its
        // dated-static fallback honestly instead of erroring the sweep.
        expect(providerIds).toContain('openrouter');
        const openrouterReport = reports.find((r) => r.providerId === 'openrouter');
        expect(openrouterReport?.models.length).toBeGreaterThan(0);
      },
    );
  });

  test('a failed refresh for one provider does not throw and still reports an honest reason', async () => {
    const registry = makeRegistry();
    await withMockedFetch(
      () => new Response('service unavailable', { status: 503 }),
      async () => {
        const reports = await registry.refreshLiveModelDiscovery('anthropic', { force: true });
        expect(reports.length).toBe(1);
        expect(reports[0]!.error).toBeDefined();
        // Still resolves to a usable model list (cache or dated-static), never empty.
        expect(reports[0]!.models.length).toBeGreaterThan(0);
      },
    );
  });
});
