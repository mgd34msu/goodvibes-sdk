/**
 * cost-attribution.test.ts
 *
 * CostAttributionService (cache-aware pricing, honest unpriced, 24h/7d windows,
 * per-dimension grouping) + QuotaWindowTracker (observed-signal-grounded
 * pre-fan-out assessment, honest "unknown") + the cost.attribution.get /
 * quota.fanout.get gateway verbs over a real catalog.
 */
import { describe, expect, test } from 'bun:test';
import {
  CostAttributionService,
  type ResolvePricing,
} from '../packages/sdk/src/platform/runtime/cost/attribution.ts';
import { QuotaWindowTracker } from '../packages/sdk/src/platform/runtime/cost/quota-window.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerCostGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/cost.ts';

const ctx = { context: { admin: true } } as const;
// $3/1M input, $15/1M output — an Anthropic-shaped model so cache multipliers apply.
const anthropicPricing: ResolvePricing = (model) => (model === 'claude-x' ? { input: 3, output: 15 } : null);

describe('CostAttributionService', () => {
  test('prices a record cache-aware (anthropic cache-read 0.1x, cache-write 1.25x of input)', () => {
    const svc = new CostAttributionService({ resolvePricing: anthropicPricing });
    const { costUsd, state } = svc.priceRecord({
      at: 0, provider: 'anthropic', model: 'claude-x',
      inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    });
    expect(state).toBe('priced');
    // 3 (input) + 0.3 (cacheRead 0.1x3) + 3.75 (cacheWrite 1.25x3) + 15 (output) = 22.05
    expect(costUsd).toBeCloseTo(22.05, 6);
  });

  test('an unknown model is honestly unpriced (null cost), never a fabricated amount', () => {
    const svc = new CostAttributionService({ resolvePricing: anthropicPricing });
    const { costUsd, state } = svc.priceRecord({
      at: 0, provider: 'mystery', model: 'unknown-model',
      inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(state).toBe('unpriced');
    expect(costUsd).toBeNull();
  });

  test('aggregates by dimension, splits priced vs unpriced, and marks a mixed total estimated', () => {
    let clock = 1_000_000_000_000;
    const svc = new CostAttributionService({ resolvePricing: anthropicPricing, now: () => clock });
    svc.record({ at: clock, provider: 'anthropic', model: 'claude-x', agentId: 'a1', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    svc.record({ at: clock, provider: 'mystery', model: 'unknown', agentId: 'a2', inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

    const byAgent = svc.attribution('24h', 'agent');
    expect(byAgent.dimension).toBe('agent');
    expect(byAgent.costState).toBe('estimated');
    expect(byAgent.totalCostUsd).toBeCloseTo(3, 6); // only the priced a1 contributes
    expect(byAgent.pricedRecordCount).toBe(1);
    expect(byAgent.unpricedRecordCount).toBe(1);
    const a1 = byAgent.rows.find((r) => r.key === 'a1')!;
    const a2 = byAgent.rows.find((r) => r.key === 'a2')!;
    expect(a1.costUsd).toBeCloseTo(3, 6);
    expect(a1.costState).toBe('priced');
    expect(a2.costUsd).toBeNull();
    expect(a2.costState).toBe('unpriced');
  });

  test('an all-unpriced total is null (not zero), costState unpriced', () => {
    const svc = new CostAttributionService({ resolvePricing: () => null });
    svc.record({ at: Date.now(), model: 'x', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const result = svc.attribution('7d', 'model');
    expect(result.totalCostUsd).toBeNull();
    expect(result.costState).toBe('unpriced');
  });

  test('the 24h window excludes records older than 24h', () => {
    let clock = 1_000_000_000_000;
    const svc = new CostAttributionService({ resolvePricing: anthropicPricing, now: () => clock });
    svc.record({ at: clock - 48 * 3600_000, provider: 'anthropic', model: 'claude-x', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    svc.record({ at: clock - 1 * 3600_000, provider: 'anthropic', model: 'claude-x', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(svc.attribution('24h', 'model').pricedRecordCount).toBe(1);
    expect(svc.attribution('7d', 'model').pricedRecordCount).toBe(2);
  });

  test('records with no tokens are dropped (nothing to attribute)', () => {
    const svc = new CostAttributionService({ resolvePricing: anthropicPricing });
    svc.record({ at: Date.now(), model: 'claude-x', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(svc.attribution('24h', 'model').rows).toEqual([]);
  });
});

describe('QuotaWindowTracker', () => {
  test('no observed signal -> honest unknown, never a fabricated certainty', () => {
    const tracker = new QuotaWindowTracker();
    const a = tracker.assessFanout({ provider: 'anthropic', agentCount: 10 });
    expect(a.verdict).toBe('unknown');
    expect(a.evidence.recentRateLimitCount).toBe(0);
  });

  test('an active cooldown (recent 429 retry-after) -> likely-exhausts with the cooldown as evidence', () => {
    let clock = 1_000_000_000_000;
    const tracker = new QuotaWindowTracker({ now: () => clock });
    tracker.record({ provider: 'anthropic', at: clock, retryAfterMs: 30_000 });
    clock += 5_000;
    const a = tracker.assessFanout({ provider: 'anthropic', agentCount: 5 });
    expect(a.verdict).toBe('likely-exhausts');
    expect(a.evidence.activeCooldownMs).toBeGreaterThan(0);
    expect(a.reason).toContain('cooldown');
  });

  test('an observed remaining below the fan-out call count -> likely-exhausts', () => {
    let clock = 1_000_000_000_000;
    const tracker = new QuotaWindowTracker({ now: () => clock });
    tracker.record({ provider: 'openai', at: clock, remaining: 3 });
    clock += 1_000;
    const a = tracker.assessFanout({ provider: 'openai', agentCount: 10, callsPerAgent: 1 });
    expect(a.verdict).toBe('likely-exhausts');
    expect(a.evidence.observedRemaining).toBe(3);
  });

  test('a signal with room and no active cooldown -> unlikely, evidence stated', () => {
    let clock = 1_000_000_000_000;
    const tracker = new QuotaWindowTracker({ now: () => clock });
    tracker.record({ provider: 'openai', at: clock, remaining: 1000 });
    clock += 1_000;
    const a = tracker.assessFanout({ provider: 'openai', agentCount: 5 });
    expect(a.verdict).toBe('unlikely');
    expect(a.evidence.observedRemaining).toBe(1000);
  });

  test('an expired cooldown no longer forces likely-exhausts', () => {
    let clock = 1_000_000_000_000;
    const tracker = new QuotaWindowTracker({ now: () => clock });
    tracker.record({ provider: 'anthropic', at: clock, retryAfterMs: 10_000 });
    clock += 11_000; // cooldown elapsed but still within lookback
    const a = tracker.assessFanout({ provider: 'anthropic', agentCount: 5 });
    expect(a.verdict).toBe('unlikely');
  });
});

describe('cost.attribution.get + quota.fanout.get gateway verbs', () => {
  function makeCatalog() {
    const catalog = new GatewayMethodCatalog();
    const costAttribution = new CostAttributionService({ resolvePricing: anthropicPricing });
    const quotaWindow = new QuotaWindowTracker();
    costAttribution.record({ at: Date.now(), provider: 'anthropic', model: 'claude-x', agentId: 'a1', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    registerCostGatewayMethods(catalog, { costAttribution, quotaWindow });
    return catalog;
  }

  test('both verbs register with handlers', () => {
    const catalog = makeCatalog();
    expect(catalog.hasHandler('cost.attribution.get')).toBe(true);
    expect(catalog.hasHandler('quota.fanout.get')).toBe(true);
  });

  test('cost.attribution.get returns the windowed attribution', async () => {
    const catalog = makeCatalog();
    const out = await catalog.invoke('cost.attribution.get', { ...ctx, body: { window: '24h', dimension: 'agent' } }) as { rows: { key: string }[]; costState: string };
    expect(out.rows.some((r) => r.key === 'a1')).toBe(true);
    expect(out.costState).toBe('priced');
  });

  test('cost.attribution.get rejects an invalid dimension with an honest 400', async () => {
    const catalog = makeCatalog();
    await expect(catalog.invoke('cost.attribution.get', { ...ctx, body: { window: '24h', dimension: 'nope' } })).rejects.toThrow(/dimension/);
  });

  test('quota.fanout.get returns unknown with no observed signal', async () => {
    const catalog = makeCatalog();
    const out = await catalog.invoke('quota.fanout.get', { ...ctx, body: { provider: 'anthropic', agentCount: 8 } }) as { verdict: string };
    expect(out.verdict).toBe('unknown');
  });

  test('quota.fanout.get requires provider + agentCount', async () => {
    const catalog = makeCatalog();
    await expect(catalog.invoke('quota.fanout.get', { ...ctx, body: { agentCount: 3 } })).rejects.toThrow(/provider/);
  });
});
