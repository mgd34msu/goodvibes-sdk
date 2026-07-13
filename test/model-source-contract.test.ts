/**
 * Registration-time model-source contract check: a provider whose model
 * list is a genuinely empty, undated array must be rejected at registration
 * time (fail-closed), the same shape as the tool contract verifier. A
 * provider that declares a valid model source (or already has a non-empty
 * models list) must register normally.
 */
import { describe, expect, test } from 'bun:test';
import {
  formatProviderModelSourceRejection,
  verifyProviderModelSource,
} from '../packages/sdk/src/platform/providers/model-source-contract.js';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';

function makeRegistry(): ProviderRegistry {
  const configManager = {
    get: () => undefined,
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/model-source-contract-test',
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

function makeChatlessProvider(overrides: Partial<LLMProvider>): LLMProvider {
  return {
    name: 'seeded-test-provider',
    models: [],
    // Registration-time credential contract: doubles declare 'anonymous'.
    credentialAuthority: 'anonymous',
    chat: async () => { throw new Error('not implemented'); },
    ...overrides,
  } as LLMProvider;
}

describe('verifyProviderModelSource', () => {
  test('RED: a non-empty models array with no declared modelSource now FAILS (the bare-array escape hatch is closed)', () => {
    const violations = verifyProviderModelSource({ name: 'p', models: ['a', 'b'], modelSource: undefined });
    expect(violations.length).toBe(1);
    expect(violations[0]!.providerName).toBe('p');
    expect(violations[0]!.message).toContain('modelSource');
  });

  test('passes when models array is non-empty AND a valid modelSource is declared', () => {
    const violations = verifyProviderModelSource({ name: 'p', models: ['a'], modelSource: { kind: 'dated-static', asOf: '2026-07-12' } });
    expect(violations).toEqual([]);
  });

  test('passes with an empty models array when modelSource is live-discovery', () => {
    const violations = verifyProviderModelSource({ name: 'p', models: [], modelSource: { kind: 'live-discovery' } });
    expect(violations).toEqual([]);
  });

  test('passes with an empty models array when modelSource is catalog-backed', () => {
    const violations = verifyProviderModelSource({ name: 'p', models: [], modelSource: { kind: 'catalog-backed' } });
    expect(violations).toEqual([]);
  });

  test('passes with an empty models array when modelSource is dated-static with a non-empty asOf', () => {
    const violations = verifyProviderModelSource({
      name: 'p',
      models: [],
      modelSource: { kind: 'dated-static', asOf: '2026-07-12' },
    });
    expect(violations).toEqual([]);
  });

  test('fails a dated-static declaration with an empty asOf', () => {
    const violations = verifyProviderModelSource({
      name: 'p',
      models: [],
      modelSource: { kind: 'dated-static', asOf: '' },
    });
    expect(violations.length).toBe(1);
  });

  test('fails an empty models array with no modelSource declared at all', () => {
    const violations = verifyProviderModelSource({ name: 'seeded-empty', models: [], modelSource: undefined });
    expect(violations.length).toBe(1);
    expect(violations[0]!.providerName).toBe('seeded-empty');
    expect(violations[0]!.message).toContain('seeded-empty');
    expect(violations[0]!.message).toContain('modelSource');
  });

  test('formatProviderModelSourceRejection joins all violation messages', () => {
    const violations = verifyProviderModelSource({ name: 'x', models: [], modelSource: undefined });
    const formatted = formatProviderModelSourceRejection(violations);
    expect(formatted).toContain('x');
  });
});

describe('ProviderRegistry.register — fail-closed on a dead model source (red test)', () => {
  test('a seeded provider with an empty models array and no modelSource is REJECTED at registration', () => {
    const registry = makeRegistry();
    const badProvider = makeChatlessProvider({ models: [] });
    expect(() => registry.register(badProvider)).toThrow(/no usable model source/i);
  });

  test('the rejected provider never becomes retrievable', () => {
    const registry = makeRegistry();
    const badProvider = makeChatlessProvider({ models: [] });
    try {
      registry.register(badProvider);
    } catch {
      // expected
    }
    expect(registry.has('seeded-test-provider')).toBe(false);
  });

  test('a seeded provider with a declared live-discovery source registers successfully even with zero models today', () => {
    const registry = makeRegistry();
    const goodProvider = makeChatlessProvider({ models: [], modelSource: { kind: 'live-discovery' } });
    expect(() => registry.register(goodProvider)).not.toThrow();
    expect(registry.has('seeded-test-provider')).toBe(true);
  });

  test('RED: a seeded provider with a non-empty static models list but no modelSource declared is now REJECTED at registration', () => {
    const registry = makeRegistry();
    const badProvider = makeChatlessProvider({ models: ['model-a', 'model-b'] });
    expect(() => registry.register(badProvider)).toThrow(/no usable model source/i);
    expect(registry.has('seeded-test-provider')).toBe(false);
  });

  test('a seeded provider with a non-empty static models list AND a declared dated-static modelSource registers successfully', () => {
    const registry = makeRegistry();
    const goodProvider = makeChatlessProvider({
      models: ['model-a', 'model-b'],
      modelSource: { kind: 'dated-static', asOf: '2026-07-13' },
    });
    expect(() => registry.register(goodProvider)).not.toThrow();
    expect(registry.has('seeded-test-provider')).toBe(true);
  });
});
