/**
 * Cost provenance over the wire: every verb that serves priced dollars also
 * says WHERE the rates came from (costSource: user / provider / catalog /
 * mixed) and, for dated sources, the pricing snapshot's as-of date — so a
 * surface can render "your price" vs "catalog price, as of <date>" without
 * deriving provenance client-side.
 *
 * Covers each source state end-to-end at the verb/snapshot boundary:
 * user (undated), provider (dated), catalog (dated), unknown/unpriced
 * (absent — never fabricated), and 'mixed' for aggregates.
 */
import { describe, expect, test } from 'bun:test';
import {
  CostAttributionService,
  type ResolvePricing,
} from '../packages/sdk/src/platform/runtime/cost/attribution.ts';
import { QuotaWindowTracker } from '../packages/sdk/src/platform/runtime/cost/quota-window.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerCostGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/cost.ts';
import { getProviderUsageSnapshot } from '../packages/sdk/src/platform/providers/runtime-snapshot.ts';
import { mergeCostSource, mergePricingAsOf, mergeWorkItemUsage, emptyWorkItemUsage } from '../packages/sdk/src/platform/orchestration/types.ts';
import { adaptAgent, type AgentAdapterContext } from '../packages/sdk/src/platform/runtime/fleet/adapters/agent.ts';
import type { AgentRecord } from '../packages/sdk/src/platform/tools/agent/index.ts';

const ctx = { context: { admin: true } } as const;

/**
 * A resolver covering all four resolvable shapes: a user-priced model
 * (undated), a provider-priced model (dated), two catalog-priced models
 * (different dates), and everything else unknown.
 */
const provenancePricing: ResolvePricing = (model) => {
  switch (model) {
    case 'user-model':
      return { input: 1, output: 2, source: 'user' };
    case 'provider-model':
      return { input: 3, output: 6, source: 'provider', asOf: '2026-07-10' };
    case 'catalog-model':
      return { input: 5, output: 10, source: 'catalog', asOf: '2026-07-01' };
    case 'catalog-model-newer':
      return { input: 5, output: 10, source: 'catalog', asOf: '2026-07-08' };
    default:
      return null;
  }
};

function record(model: string, agentId: string): {
  at: number; model: string; agentId: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
} {
  return { at: Date.now(), model, agentId, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

describe('cost attribution provenance', () => {
  function serviceWith(...records: ReturnType<typeof record>[]): CostAttributionService {
    const svc = new CostAttributionService({ resolvePricing: provenancePricing });
    for (const rec of records) svc.record(rec);
    return svc;
  }

  test('a user-priced row reports costSource user with no date (user prices are undated)', () => {
    const result = serviceWith(record('user-model', 'a1')).attribution('24h', 'agent');
    const row = result.rows.find((r) => r.key === 'a1')!;
    expect(row.costSource).toBe('user');
    expect(row.pricingAsOf).toBeNull();
  });

  test('provider- and catalog-priced rows carry their source and as-of date', () => {
    const result = serviceWith(record('provider-model', 'p1'), record('catalog-model', 'c1')).attribution('24h', 'agent');
    const providerRow = result.rows.find((r) => r.key === 'p1')!;
    expect(providerRow.costSource).toBe('provider');
    expect(providerRow.pricingAsOf).toBe('2026-07-10');
    const catalogRow = result.rows.find((r) => r.key === 'c1')!;
    expect(catalogRow.costSource).toBe('catalog');
    expect(catalogRow.pricingAsOf).toBe('2026-07-01');
  });

  test('an unpriced row reports null provenance — never fabricated', () => {
    const result = serviceWith(record('mystery-model', 'u1')).attribution('24h', 'agent');
    const row = result.rows.find((r) => r.key === 'u1')!;
    expect(row.costState).toBe('unpriced');
    expect(row.costSource).toBeNull();
    expect(row.pricingAsOf).toBeNull();
  });

  test('a row mixing sources reports mixed with the OLDEST as-of date', () => {
    const result = serviceWith(
      record('user-model', 'shared'),
      record('catalog-model-newer', 'shared'),
      record('catalog-model', 'shared'),
    ).attribution('24h', 'agent');
    const row = result.rows.find((r) => r.key === 'shared')!;
    expect(row.costSource).toBe('mixed');
    expect(row.pricingAsOf).toBe('2026-07-01');
    // The top-level aggregate reports the same honest mix.
    expect(result.costSource).toBe('mixed');
    expect(result.pricingAsOf).toBe('2026-07-01');
  });

  test('cost.attribution.get serves costSource and pricingAsOf over the verb boundary for every source state', async () => {
    const catalog = new GatewayMethodCatalog();
    const costAttribution = new CostAttributionService({ resolvePricing: provenancePricing });
    for (const [model, agent] of [
      ['user-model', 'user-agent'],
      ['provider-model', 'provider-agent'],
      ['catalog-model', 'catalog-agent'],
      ['mystery-model', 'unknown-agent'],
    ] as const) {
      costAttribution.record(record(model, agent));
    }
    registerCostGatewayMethods(catalog, { costAttribution, quotaWindow: new QuotaWindowTracker() });
    const out = await catalog.invoke('cost.attribution.get', { ...ctx, body: { window: '24h', dimension: 'agent' } }) as {
      costSource: string | null;
      pricingAsOf: string | null;
      rows: { key: string; costSource: string | null; pricingAsOf: string | null }[];
    };
    const byKey = new Map(out.rows.map((r) => [r.key, r]));
    expect(byKey.get('user-agent')).toMatchObject({ costSource: 'user', pricingAsOf: null });
    expect(byKey.get('provider-agent')).toMatchObject({ costSource: 'provider', pricingAsOf: '2026-07-10' });
    expect(byKey.get('catalog-agent')).toMatchObject({ costSource: 'catalog', pricingAsOf: '2026-07-01' });
    expect(byKey.get('unknown-agent')).toMatchObject({ costSource: null, pricingAsOf: null });
    // Aggregate across user+provider+catalog is honestly 'mixed', dated by the oldest snapshot.
    expect(out.costSource).toBe('mixed');
    expect(out.pricingAsOf).toBe('2026-07-01');
  });
});

describe('providers.usage.get pricing provenance', () => {
  type ResolveModelPricing = (model: string, provider?: string) =>
    | { status: 'priced'; source: 'user' | 'provider' | 'catalog'; asOf?: string; rates: { inputPerMTok: number; outputPerMTok: number } }
    | { status: 'unknown' };

  function stubRegistry(models: readonly { id: string }[], resolve: ResolveModelPricing) {
    return {
      getRegistered: () => ({ name: 'stub', models: models.map((m) => m.id) }),
      getCurrentModel: () => null,
      listModels: () => models.map((m, i) => ({
        id: m.id,
        registryKey: `stub:${m.id}`,
        displayName: m.id,
        selectable: true,
        contextWindow: 128000,
        provider: 'stub',
        index: i,
      })),
      resolveModelPricing: resolve,
      describeRuntime: async () => null,
    // The Pick<> the snapshot functions accept is structural; the stub covers exactly those members.
    } as unknown as Parameters<typeof getProviderUsageSnapshot>[0];
  }

  test('each priced model carries its own source (and date for dated sources); the snapshot reports mixed + oldest date', async () => {
    const registry = stubRegistry(
      [{ id: 'user-model' }, { id: 'catalog-model' }, { id: 'catalog-model-newer' }, { id: 'mystery-model' }],
      ((model: string) => {
        if (model === 'user-model') return { status: 'priced', source: 'user', rates: { inputPerMTok: 1, outputPerMTok: 2 } };
        if (model === 'catalog-model') return { status: 'priced', source: 'catalog', asOf: '2026-07-01', rates: { inputPerMTok: 5, outputPerMTok: 10 } };
        if (model === 'catalog-model-newer') return { status: 'priced', source: 'catalog', asOf: '2026-07-08', rates: { inputPerMTok: 5, outputPerMTok: 10 } };
        return { status: 'unknown' };
      }) as ResolveModelPricing,
    );
    const snapshot = (await getProviderUsageSnapshot(registry, 'stub'))!;
    const byId = new Map(snapshot.models.map((m) => [m.id, m]));
    expect(byId.get('user-model')!.pricing).toMatchObject({ source: 'user' });
    expect(byId.get('user-model')!.pricing!.asOf).toBeUndefined();
    expect(byId.get('catalog-model')!.pricing).toMatchObject({ source: 'catalog', asOf: '2026-07-01' });
    expect(byId.get('mystery-model')!.pricing).toBeUndefined();
    expect(snapshot.pricingSource).toBe('mixed');
    expect(snapshot.pricingAsOf).toBe('2026-07-01');
  });

  test('a single-source provider reports that source; no priced models reports none with no date', async () => {
    const catalogOnly = stubRegistry(
      [{ id: 'catalog-model' }],
      ((model: string) => (model === 'catalog-model'
        ? { status: 'priced', source: 'catalog', asOf: '2026-07-01', rates: { inputPerMTok: 5, outputPerMTok: 10 } }
        : { status: 'unknown' })) as ResolveModelPricing,
    );
    const catalogSnapshot = (await getProviderUsageSnapshot(catalogOnly, 'stub'))!;
    expect(catalogSnapshot.pricingSource).toBe('catalog');
    expect(catalogSnapshot.pricingAsOf).toBe('2026-07-01');

    const unpriced = stubRegistry([{ id: 'mystery-model' }], (() => ({ status: 'unknown' })) as ResolveModelPricing);
    const unpricedSnapshot = (await getProviderUsageSnapshot(unpriced, 'stub'))!;
    expect(unpricedSnapshot.pricingSource).toBe('none');
    expect(unpricedSnapshot.pricingAsOf).toBeUndefined();
  });
});

describe('fleet cost provenance', () => {
  test('a priced agent node is stamped with the resolver provenance at pricing time', () => {
    const record: AgentRecord = {
      id: 'agent-1',
      template: 'engineer',
      task: 'do work',
      status: 'running',
      startedAt: Date.now() - 1000,
      model: 'catalog-model',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 },
      toolCallCount: 0,
    } as unknown as AgentRecord;
    const ctx = {
      activity: new Map(),
      liveness: false,
      stalledThresholdMs: 120000,
      pendingApprovalAgentIds: new Set(),
      pendingApprovalSessionIds: new Set(),
      sessionIdByAgentId: new Map(),
      chainIds: new Set(),
      subtaskIds: new Set(),
      workItemIds: new Set(),
      agentIdByOrchestrationNodeId: new Map(),
      agentIds: new Set(['agent-1']),
      priceUsage: () => 0.0125,
      priceProvenance: () => ({ source: 'catalog' as const, asOf: '2026-07-01' }),
      messageBusPresent: false,
      now: Date.now(),
    } as unknown as AgentAdapterContext;
    const node = adaptAgent(record, ctx);
    expect(node.costState).toBe('priced');
    expect(node.costSource).toBe('catalog');
    expect(node.pricingAsOf).toBe('2026-07-01');
  });

  test('an unpriced agent node carries no provenance', () => {
    const record: AgentRecord = {
      id: 'agent-2',
      template: 'engineer',
      task: 'do work',
      status: 'running',
      startedAt: Date.now() - 1000,
      model: 'mystery-model',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, llmCallCount: 1, turnCount: 1 },
      toolCallCount: 0,
    } as unknown as AgentRecord;
    const ctx = {
      activity: new Map(),
      liveness: false,
      stalledThresholdMs: 120000,
      pendingApprovalAgentIds: new Set(),
      pendingApprovalSessionIds: new Set(),
      sessionIdByAgentId: new Map(),
      chainIds: new Set(),
      subtaskIds: new Set(),
      workItemIds: new Set(),
      agentIdByOrchestrationNodeId: new Map(),
      agentIds: new Set(['agent-2']),
      priceUsage: () => null,
      priceProvenance: () => null,
      messageBusPresent: false,
      now: Date.now(),
    } as unknown as AgentAdapterContext;
    const node = adaptAgent(record, ctx);
    expect(node.costState).toBe('unpriced');
    expect(node.costSource).toBeUndefined();
    expect(node.pricingAsOf).toBeUndefined();
  });
});

describe('usage rollup provenance merge rules', () => {
  test('one shared source reports itself; disagreement is mixed; absence never overrides presence', () => {
    expect(mergeCostSource('catalog', 'catalog')).toBe('catalog');
    expect(mergeCostSource('catalog', 'user')).toBe('mixed');
    expect(mergeCostSource(undefined, 'provider')).toBe('provider');
    expect(mergeCostSource('mixed', 'catalog')).toBe('mixed');
    expect(mergeCostSource(undefined, undefined)).toBeUndefined();
  });

  test('the oldest as-of date wins', () => {
    expect(mergePricingAsOf('2026-07-01', '2026-07-08')).toBe('2026-07-01');
    expect(mergePricingAsOf(undefined, '2026-07-08')).toBe('2026-07-08');
    expect(mergePricingAsOf(undefined, undefined)).toBeUndefined();
  });

  test('mergeWorkItemUsage folds provenance through the same rules', () => {
    const a = { ...emptyWorkItemUsage(), inputTokens: 10, costUsd: 0.1, costState: 'priced' as const, costSource: 'catalog' as const, pricingAsOf: '2026-07-08' };
    const b = { ...emptyWorkItemUsage(), inputTokens: 20, costUsd: 0.2, costState: 'priced' as const, costSource: 'user' as const };
    const merged = mergeWorkItemUsage(a, b);
    expect(merged.costUsd).toBeCloseTo(0.3);
    expect(merged.costSource).toBe('mixed');
    expect(merged.pricingAsOf).toBe('2026-07-08');
  });
});
