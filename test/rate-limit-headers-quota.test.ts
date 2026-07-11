/**
 * rate-limit-headers-quota.test.ts
 *
 * Parsing standard rate-limit headers on EVERY response (not just 429s) into a
 * quota snapshot: the header parser, the QuotaWindowTracker.snapshot view, and
 * the quota.snapshot.get gateway verb.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseRateLimitHeaders,
  parseOpenAiResetDurationMs,
  parseRetryAfterMs,
} from '../packages/sdk/src/platform/providers/rate-limit-headers.ts';
import { QuotaWindowTracker } from '../packages/sdk/src/platform/runtime/cost/quota-window.ts';
import { GatewayMethodCatalog } from '../packages/sdk/src/platform/control-plane/method-catalog.ts';
import { registerCostGatewayMethods } from '../packages/sdk/src/platform/control-plane/routes/cost.ts';
import { CostAttributionService } from '../packages/sdk/src/platform/runtime/cost/attribution.ts';

const NOW = 1_000_000;

describe('parseRateLimitHeaders', () => {
  test('parses Anthropic requests headers (ISO reset) and retry-after', () => {
    const resetIso = new Date(NOW + 30_000).toISOString();
    const parsed = parseRateLimitHeaders(new Headers({
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '42',
      'anthropic-ratelimit-requests-reset': resetIso,
      'retry-after': '5',
    }), NOW);
    expect(parsed).not.toBeNull();
    expect(parsed!.limit).toBe(1000);
    expect(parsed!.remaining).toBe(42);
    expect(parsed!.resetAt).toBe(Date.parse(resetIso));
    expect(parsed!.retryAfterMs).toBe(5000);
  });

  test('parses OpenAI x-ratelimit headers (duration reset) preferring requests', () => {
    const parsed = parseRateLimitHeaders({
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': '499',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-remaining-tokens': '90000',
    }, NOW);
    expect(parsed!.limit).toBe(500);
    expect(parsed!.remaining).toBe(499); // requests preferred over tokens
    expect(parsed!.resetAt).toBe(NOW + 6 * 60_000);
  });

  test('falls back to the tokens dimension when only tokens headers are present', () => {
    const parsed = parseRateLimitHeaders({ 'x-ratelimit-remaining-tokens': '12345' }, NOW);
    expect(parsed!.remaining).toBe(12345);
  });

  test('returns null when no recognized header is present', () => {
    expect(parseRateLimitHeaders({ 'content-type': 'text/event-stream' }, NOW)).toBeNull();
  });

  test('duration and retry-after helpers', () => {
    expect(parseOpenAiResetDurationMs('1h2m3s')).toBe(3_723_000);
    expect(parseOpenAiResetDurationMs('500ms')).toBe(500);
    expect(parseOpenAiResetDurationMs('2')).toBe(2000);
    expect(parseRetryAfterMs('7', NOW)).toBe(7000);
    expect(parseRetryAfterMs(new Date(NOW + 10_000).toUTCString(), NOW)).toBeGreaterThanOrEqual(9000);
  });
});

describe('QuotaWindowTracker.snapshot', () => {
  test('honest no-observation when nothing has been recorded', () => {
    const t = new QuotaWindowTracker({ now: () => NOW });
    const snap = t.snapshot('anthropic');
    expect(snap.hasSignal).toBe(false);
    expect(snap.remaining).toBeUndefined();
    expect(snap.recentRateLimitCount).toBe(0);
  });

  test('reflects the most recent observed remaining/limit/reset and active cooldown', () => {
    const t = new QuotaWindowTracker({ now: () => NOW });
    t.record({ provider: 'anthropic', at: NOW - 1000, limit: 1000, remaining: 900, resetAt: NOW + 60_000 });
    t.record({ provider: 'anthropic', at: NOW - 500, remaining: 850, retryAfterMs: 4000 });
    const snap = t.snapshot('anthropic');
    expect(snap.hasSignal).toBe(true);
    expect(snap.remaining).toBe(850);
    expect(snap.limit).toBe(1000);
    expect(snap.resetAt).toBe(NOW + 60_000);
    expect(snap.activeCooldownMs).toBe(3500); // 4000 - (NOW - (NOW-500))
    expect(snap.recentRateLimitCount).toBe(1);
  });
});

describe('quota.snapshot.get gateway verb', () => {
  test('registers and returns the tracker snapshot', async () => {
    const catalog = new GatewayMethodCatalog();
    const quotaWindow = new QuotaWindowTracker({ now: () => NOW });
    quotaWindow.record({ provider: 'anthropic', at: NOW, limit: 100, remaining: 7 });
    registerCostGatewayMethods(catalog, {
      costAttribution: new CostAttributionService({ resolvePricing: () => null }),
      quotaWindow,
    });
    expect(catalog.hasHandler('quota.snapshot.get')).toBe(true);
    const result = await catalog.invoke('quota.snapshot.get', { context: { admin: true }, body: { provider: 'anthropic' } }) as { hasSignal: boolean; remaining: number };
    expect(result.hasSignal).toBe(true);
    expect(result.remaining).toBe(7);
  });

  test('quota.snapshot.get requires a provider', async () => {
    const catalog = new GatewayMethodCatalog();
    registerCostGatewayMethods(catalog, {
      costAttribution: new CostAttributionService({ resolvePricing: () => null }),
      quotaWindow: new QuotaWindowTracker(),
    });
    await expect(catalog.invoke('quota.snapshot.get', { context: { admin: true }, body: {} })).rejects.toThrow(/provider/);
  });
});
