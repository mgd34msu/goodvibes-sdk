/**
 * Model pricing resolution — the one resolver per (provider, model) pair.
 *
 * Covers the acceptance bar for tracked-current-and-used pricing:
 *   - a gateway model's session cost equals hand-multiplied usage x price
 *   - the same model id at two providers resolves different prices
 *   - an absent-from-catalog model resolves UNKNOWN (not $0, not free) and
 *     its spend sums as unpriced
 *   - a registration-supplied price on a custom provider prices from the
 *     first turn
 *   - a manual config price OVERRIDING a catalog price applies immediately
 *     with source 'user'
 *   - a dollar budget triggers on a non-frontier model's priced actuals
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import {
  getCatalogCachePath,
  getCatalogTmpPath,
  getCostFromPricingCatalog,
  saveCatalogCache,
  type CatalogModel,
} from '../packages/sdk/src/platform/providers/model-catalog.js';
import { computeUsageCostUsd, computeUsageCostUsdCents } from '../packages/sdk/src/platform/providers/model-pricing.js';
import { CostAttributionService, type ResolvePricing } from '../packages/sdk/src/platform/runtime/cost/attribution.js';
import { checkBudget, budgetBlindSpot } from '../packages/sdk/src/platform/orchestration/budget.js';
import type { WorkItem, Workstream } from '../packages/sdk/src/platform/orchestration/types.js';

// ---------------------------------------------------------------------------
// Harness (mirrors provider-registry-canonical-api.test.ts)
// ---------------------------------------------------------------------------

function makeRegistry(
  root: string,
  config: Readonly<Record<string, unknown>> = {},
): ProviderRegistry {
  return new ProviderRegistry({
    configManager: {
      get: (key: string) => config[key],
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
    favoritesStore: { load: async () => ({ pinned: [], history: [] }) } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'],
    benchmarkStore: {
      getBenchmarks: () => undefined,
      getTopBenchmarkModelIds: () => [],
    } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'],
    secretsManager: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'],
    serviceRegistry: {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'],
    featureFlags: null,
    runtimeBus: null,
  });
}

function makeCatalogModel(
  id: string,
  providerId: string,
  pricing: CatalogModel['pricing'],
  tier: CatalogModel['tier'] = 'paid',
): CatalogModel {
  return {
    id,
    name: id,
    provider: providerId,
    providerId,
    providerEnvVars: [],
    pricing,
    tier,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  };
}

/** Registry with the given catalog models loaded from a warm disk cache. */
function registryWithCatalog(
  root: string,
  models: CatalogModel[],
  config: Readonly<Record<string, unknown>> = {},
): ProviderRegistry {
  saveCatalogCache(models, getCatalogCachePath(root), getCatalogTmpPath(root));
  const registry = makeRegistry(root, config);
  registry.initCatalog();
  return registry;
}

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'gv-model-pricing-'));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolveModelPricing', () => {
  test("a gateway model's session cost equals hand-multiplied usage x price", () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('deepseek/deepseek-chat', 'openrouter', { input: 0.5, output: 1.5 }),
      ]);
      const resolved = registry.resolveModelPricing('deepseek/deepseek-chat', 'openrouter');
      expect(resolved.status).toBe('priced');
      if (resolved.status !== 'priced') return;
      expect(resolved.source).toBe('catalog');
      expect(resolved.asOf).toBeDefined();

      // Session cost through the SAME wiring the gateway cost verbs use.
      const resolvePricing: ResolvePricing = (model, provider) => {
        if (!model) return null;
        const r = registry.resolveModelPricing(model, provider);
        if (r.status !== 'priced') return null;
        return { input: r.rates.inputPerMTok, output: r.rates.outputPerMTok, cacheRead: r.rates.cacheReadPerMTok, cacheWrite: r.rates.cacheWritePerMTok };
      };
      const svc = new CostAttributionService({ resolvePricing });
      svc.record({
        at: Date.now(),
        provider: 'openrouter',
        model: 'deepseek/deepseek-chat',
        sessionId: 's-1',
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const bySession = svc.attribution('24h', 'session');
      // Hand math: 2M x $0.5/M + 1M x $1.5/M = $1.00 + $1.50 = $2.50.
      expect(bySession.totalCostUsd).toBeCloseTo(2.5, 10);
      expect(bySession.costState).toBe('priced');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the same model id at two providers resolves different prices from their entries', () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('llama-3.3-70b', 'groq', { input: 0.59, output: 0.79 }),
        makeCatalogModel('llama-3.3-70b', 'together', { input: 0.88, output: 0.88 }),
      ]);
      const atGroq = registry.resolveModelPricing('llama-3.3-70b', 'groq');
      const atTogether = registry.resolveModelPricing('llama-3.3-70b', 'together');
      expect(atGroq.status).toBe('priced');
      expect(atTogether.status).toBe('priced');
      if (atGroq.status !== 'priced' || atTogether.status !== 'priced') return;
      expect(atGroq.rates.inputPerMTok).toBe(0.59);
      expect(atTogether.rates.inputPerMTok).toBe(0.88);
      // Without a provider, conflicting entries are honestly unknown — never
      // a silent pick of the wrong provider's rate.
      expect(registry.resolveModelPricing('llama-3.3-70b').status).toBe('unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an absent-from-catalog model resolves UNKNOWN (not $0, not free) and sums as unpriced', () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('known-model', 'acme', { input: 1, output: 2 }),
      ]);
      const resolved = registry.resolveModelPricing('mystery-model', 'acme');
      expect(resolved).toEqual({ status: 'unknown' });
      expect(computeUsageCostUsd(resolved, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();

      const resolvePricing: ResolvePricing = (model, provider) => {
        if (!model) return null;
        const r = registry.resolveModelPricing(model, provider);
        return r.status === 'priced' ? { input: r.rates.inputPerMTok, output: r.rates.outputPerMTok } : null;
      };
      const svc = new CostAttributionService({ resolvePricing });
      svc.record({
        at: Date.now(),
        provider: 'acme',
        model: 'mystery-model',
        sessionId: 's-2',
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const byModel = svc.attribution('24h', 'model');
      const row = byModel.rows.find((r) => r.key === 'mystery-model');
      expect(row?.costUsd).toBeNull();
      expect(row?.costState).toBe('unpriced');
      // The unpriced tokens are still counted — "N tokens unpriced", never $0.
      expect(row?.tokens.inputTokens).toBe(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a registration-supplied price on a custom provider prices from the first turn', async () => {
    const root = scratchDir();
    try {
      const providersDir = join(root, 'providers');
      mkdirSync(providersDir, { recursive: true });
      writeFileSync(join(providersDir, 'selfhost.json'), JSON.stringify({
        name: 'selfhost',
        displayName: 'Self-hosted',
        type: 'openai-compat',
        baseURL: 'http://localhost:8080/v1',
        models: [{
          id: 'local-llama',
          displayName: 'Local Llama',
          contextWindow: 32_768,
          capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
          pricing: { input: 0.1, output: 0.2, cacheRead: 0.01 },
        }],
      }));
      const registry = makeRegistry(root);
      await registry.loadCustomProviders();
      const resolved = registry.resolveModelPricing('local-llama', 'selfhost');
      expect(resolved.status).toBe('priced');
      if (resolved.status !== 'priced') return;
      expect(resolved.source).toBe('user');
      expect(resolved.rates).toEqual({
        inputPerMTok: 0.1,
        outputPerMTok: 0.2,
        cacheReadPerMTok: 0.01,
        cacheWritePerMTok: undefined,
      });
      // First-turn cost: usage x the registration price, cache-read at its
      // explicit rate. 1M in + 1M out + 1M cache-read.
      const cents = computeUsageCostUsdCents(resolved, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }, 'selfhost');
      expect(cents).toBeCloseTo((0.1 + 0.2 + 0.01) * 100, 10);
      // A model the registration did NOT price stays unpriced — omitting
      // pricing never means free.
      writeFileSync(join(providersDir, 'selfhost2.json'), JSON.stringify({
        name: 'selfhost2',
        displayName: 'Self-hosted 2',
        type: 'openai-compat',
        baseURL: 'http://localhost:8081/v1',
        models: [{
          id: 'local-mystery',
          displayName: 'Local Mystery',
          contextWindow: 8192,
          capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
        }],
      }));
      await registry.loadCustomProviders();
      expect(registry.resolveModelPricing('local-mystery', 'selfhost2')).toEqual({ status: 'unknown' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a manual price OVERRIDING a catalog price takes effect immediately with source 'user'", () => {
    const root = scratchDir();
    try {
      // Mutable config record — the resolver reads it live on every call,
      // exactly like ConfigManager after a set() (no restart, no re-register).
      const config: Record<string, unknown> = {};
      const registry = registryWithCatalog(root, [
        makeCatalogModel('gpt-catalog-priced', 'openai', { input: 3, output: 12 }),
      ], config);

      const before = registry.resolveModelPricing('gpt-catalog-priced', 'openai');
      expect(before.status).toBe('priced');
      if (before.status !== 'priced') return;
      expect(before.source).toBe('catalog');
      expect(before.rates.inputPerMTok).toBe(3);

      config['pricing.modelPrices'] = {
        'openai:gpt-catalog-priced': { input: 1.5, output: 6, cacheWrite: 1.875 },
      };
      const after = registry.resolveModelPricing('gpt-catalog-priced', 'openai');
      expect(after.status).toBe('priced');
      if (after.status !== 'priced') return;
      expect(after.source).toBe('user');
      expect(after.rates.inputPerMTok).toBe(1.5);
      expect(after.rates.outputPerMTok).toBe(6);
      expect(after.rates.cacheWritePerMTok).toBe(1.875);
      // Manual prices carry no asOf — they are the owner's standing rate.
      expect(after.asOf).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('subscription-tier surfaces resolve as subscription, never a fake per-token price', () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('copilot-model', 'github-copilot', null, 'subscription'),
      ]);
      const resolved = registry.resolveModelPricing('copilot-model', 'github-copilot');
      expect(resolved).toEqual({ status: 'subscription' });
      expect(computeUsageCostUsd(resolved, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a provider:model registry key resolves like the split pair; :free suffixes do not misparse', () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('llama-3.3-70b', 'groq', { input: 0.59, output: 0.79 }),
        makeCatalogModel('deepseek/deepseek-r1:free', 'openrouter', { input: 0, output: 0 }, 'free'),
      ]);
      const viaKey = registry.resolveModelPricing('groq:llama-3.3-70b');
      expect(viaKey.status).toBe('priced');
      if (viaKey.status !== 'priced') return;
      expect(viaKey.rates.inputPerMTok).toBe(0.59);
      // 'deepseek/deepseek-r1:free' has a colon but its prefix is not a
      // provider — it must resolve as a bare model id (a genuine free entry
      // with explicit zero rates, not a coerced one).
      const free = registry.resolveModelPricing('deepseek/deepseek-r1:free');
      expect(free.status).toBe('priced');
      if (free.status !== 'priced') return;
      expect(free.rates.inputPerMTok).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Catalog honesty
// ---------------------------------------------------------------------------

describe('catalog pricing honesty', () => {
  test('getCostFromPricingCatalog returns null (not $0) for an absent or unpriced model', () => {
    const catalog = {
      models: [
        makeCatalogModel('priced-model', 'acme', { input: 2, output: 4 }),
        makeCatalogModel('unpriced-model', 'acme', null),
      ],
    };
    expect(getCostFromPricingCatalog('absent-model', catalog)).toBeNull();
    expect(getCostFromPricingCatalog('unpriced-model', catalog)).toBeNull();
    expect(getCostFromPricingCatalog('priced-model', catalog)).toEqual({ input: 2, output: 4 });
  });
});

// ---------------------------------------------------------------------------
// Dollar budgets on priced actuals — any model, not only frontier ones
// ---------------------------------------------------------------------------

describe('dollar budget on non-frontier actuals', () => {
  function makeItem(id: string, inputTokens: number, outputTokens: number, costUsd: number | null): WorkItem {
    return {
      id,
      title: id,
      status: 'done',
      usage: { inputTokens, outputTokens, costUsd },
    } as unknown as WorkItem;
  }

  test("a dollar budget triggers on a non-frontier model's actuals", () => {
    const root = scratchDir();
    try {
      const registry = registryWithCatalog(root, [
        makeCatalogModel('llama-3.3-70b', 'groq', { input: 0.59, output: 0.79 }),
      ]);
      // Price the actuals through the resolver — the same computation
      // services.ts priceUsage now performs.
      const priced = computeUsageCostUsd(
        registry.resolveModelPricing('groq:llama-3.3-70b'),
        { inputTokens: 10_000_000, outputTokens: 5_000_000 },
      );
      // Hand math: 10M x $0.59/M + 5M x $0.79/M = $5.90 + $3.95 = $9.85.
      expect(priced).toBeCloseTo(9.85, 10);

      const workstream = {
        id: 'ws-1',
        items: [makeItem('item-1', 10_000_000, 5_000_000, priced)],
        budget: { maxCostUsd: 5 },
      } as unknown as Workstream;
      const check = checkBudget(workstream);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('$9.85');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dollar budget's state reports its unpriced blind spot honestly", () => {
    const workstream = {
      id: 'ws-2',
      items: [
        makeItem('priced', 1000, 500, 0.5),
        makeItem('unpriced', 8000, 2000, null),
      ],
      budget: { maxCostUsd: 10 },
    } as unknown as Workstream;
    const check = checkBudget(workstream);
    expect(check.allowed).toBe(true);
    expect(check.unpricedTokens).toBe(10_000);
    expect(check.unpricedItems).toBe(1);
    expect(budgetBlindSpot(workstream)).toEqual({ unpricedTokens: 10_000, unpricedItems: 1 });
  });
});

// ---------------------------------------------------------------------------
// Emit-site cost stamping — the seam that makes pricing "actually used"
// ---------------------------------------------------------------------------

describe('emit-site cost stamping', () => {
  test('a ToolLLM call emits costUsdCents = usage x resolved price with its source', async () => {
    const { RuntimeEventBus } = await import('../packages/sdk/src/platform/runtime/events/index.ts');
    const { ToolLLM } = await import('../packages/sdk/src/platform/config/tool-llm.ts');
    const bus = new RuntimeEventBus();
    const events: Array<Record<string, unknown>> = [];
    bus.onDomain('turn', (envelope) => {
      const event = envelope.payload as Record<string, unknown> & { type: string };
      if (event.type === 'LLM_RESPONSE_RECEIVED') events.push(event);
    });
    const provider = {
      name: 'selfhost',
      models: ['local-llama'],
      isConfigured: () => true,
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
        stopReason: 'completed',
      }),
    } as never;
    const toolLLM = new ToolLLM({
      configManager: { get: (key: string) => (key === 'tools.llmEnabled' ? true : '') } as never,
      providerRegistry: {
        getCurrentModel: () => ({ registryKey: 'selfhost:local-llama', provider: 'selfhost', id: 'local-llama' }),
        getForModel: () => provider,
        resolveModelPricing: () => ({
          status: 'priced',
          source: 'user',
          rates: { inputPerMTok: 0.1, outputPerMTok: 0.2 },
        }),
      } as never,
      runtimeBus: bus,
      sessionId: () => 'session-price',
    });
    await toolLLM.chat('plain');
    await Bun.sleep(1);
    expect(events.length).toBe(1);
    // Hand math: 1M x $0.1/M + 0.5M x $0.2/M = $0.20 = 20 cents.
    expect(events[0]!['costUsdCents']).toBeCloseTo(20, 10);
    expect(events[0]!['costSource']).toBe('user');
  });

  test('an unknown-price ToolLLM call emits NO costUsdCents and costSource unknown', async () => {
    const { RuntimeEventBus } = await import('../packages/sdk/src/platform/runtime/events/index.ts');
    const { ToolLLM } = await import('../packages/sdk/src/platform/config/tool-llm.ts');
    const bus = new RuntimeEventBus();
    const events: Array<Record<string, unknown>> = [];
    bus.onDomain('turn', (envelope) => {
      const event = envelope.payload as Record<string, unknown> & { type: string };
      if (event.type === 'LLM_RESPONSE_RECEIVED') events.push(event);
    });
    const provider = {
      name: 'acme',
      models: ['mystery-model'],
      isConfigured: () => true,
      chat: async () => ({
        content: 'ok',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 10 },
        stopReason: 'completed',
      }),
    } as never;
    const toolLLM = new ToolLLM({
      configManager: { get: (key: string) => (key === 'tools.llmEnabled' ? true : '') } as never,
      providerRegistry: {
        getCurrentModel: () => ({ registryKey: 'acme:mystery-model', provider: 'acme', id: 'mystery-model' }),
        getForModel: () => provider,
        resolveModelPricing: () => ({ status: 'unknown' }),
      } as never,
      runtimeBus: bus,
      sessionId: () => 'session-unpriced',
    });
    await toolLLM.chat('plain');
    await Bun.sleep(1);
    expect(events.length).toBe(1);
    expect('costUsdCents' in events[0]!).toBe(false);
    expect(events[0]!['costSource']).toBe('unknown');
  });
});
