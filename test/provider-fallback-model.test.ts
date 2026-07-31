/**
 * Unit tests for buildFallbackModelDefinition / ensureConfiguredModelIsRoutable
 * — the pre-catalog fallback registration for the configured model.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildFallbackModelDefinition,
  ensureConfiguredModelIsRoutable,
} from '../packages/sdk/src/platform/providers/fallback-model.ts';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';
import type { ConfigManager } from '../packages/sdk/src/platform/config/manager.ts';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistryOptions(config: Readonly<Record<string, unknown>> = {}): RegistryOptions {
  const configManager = {
    get: (key: string) => config[key],
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/provider-fallback-model-test',
  } as unknown as RegistryOptions['configManager'];

  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as RegistryOptions['subscriptionManager'];

  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
    setModelFactsSource: () => {},
    canHandle: () => true,
  } as unknown as RegistryOptions['capabilityRegistry'];

  const cacheHitTracker = { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'];
  const favoritesStore = { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'];
  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as RegistryOptions['benchmarkStore'];
  const secretsManager = {} as unknown as RegistryOptions['secretsManager'];
  const serviceRegistry = {} as unknown as RegistryOptions['serviceRegistry'];

  return {
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
  };
}

describe('buildFallbackModelDefinition', () => {
  test('marks the definition as a fallback with a provider-qualified registryKey', () => {
    const definition = buildFallbackModelDefinition('anthropic', 'claude-fallback-test');
    expect(definition.registryKey).toBe('anthropic:claude-fallback-test');
    expect(definition.contextWindowProvenance).toBe('fallback');
    expect(definition.selectable).toBe(true);
  });

  test('a reasoning-family provider (anthropic/openai/gemini/google) gets a reasoningEffort spec and marks reasoning+multimodal capable', () => {
    const anthropic = buildFallbackModelDefinition('anthropic', 'claude-x');
    expect(anthropic.capabilities.reasoning).toBe(true);
    expect(anthropic.capabilities.multimodal).toBe(true);
    expect(anthropic.reasoningEffort).toBeDefined();

    const openai = buildFallbackModelDefinition('openai', 'gpt-x');
    expect(openai.reasoningEffort).toBeDefined();
  });

  test('a non-reasoning-family provider gets no reasoningEffort spec and is marked non-reasoning', () => {
    const definition = buildFallbackModelDefinition('groq', 'llama-x');
    expect(definition.capabilities.reasoning).toBe(false);
    expect(definition.capabilities.multimodal).toBe(false);
    expect(definition.reasoningEffort).toBeUndefined();
  });

  test('infers the context window from the family-aware resolver rather than a flat constant', () => {
    // Anthropic's curated family window (200k) differs from a flat guess,
    // proving this delegates to inferFallbackContextWindow rather than
    // hardcoding a provider-tier split.
    const anthropic = buildFallbackModelDefinition('anthropic', 'claude-x');
    expect(anthropic.contextWindow).toBe(200_000);

    const gemini = buildFallbackModelDefinition('google', 'gemini-x');
    expect(gemini.contextWindow).toBe(1_000_000);
  });

  test('every fallback definition declares tool calling and code editing support', () => {
    const definition = buildFallbackModelDefinition('groq', 'llama-x');
    expect(definition.capabilities.toolCalling).toBe(true);
    expect(definition.capabilities.codeEditing).toBe(true);
  });
});

describe('ensureConfiguredModelIsRoutable', () => {
  test('is a no-op when the configured model is not provider-qualified', () => {
    const registry = createLaunchTolerantAwareRegistry();
    ensureConfiguredModelIsRoutable(registry, makeConfigManager('not-qualified'));
    expect(registry.listModels().some((m) => m.registryKey === 'not-qualified')).toBe(false);
  });

  test('is a no-op when the configured model is already in the live catalog', () => {
    const registry = createLaunchTolerantAwareRegistry();
    const [existing] = registry.listModels();
    if (!existing) throw new Error('test setup expects at least one built-in model to exist');
    const before = registry.listModels().length;
    ensureConfiguredModelIsRoutable(registry, makeConfigManager(existing.registryKey));
    expect(registry.listModels().length).toBe(before);
  });

  test('is a no-op when the configured provider is not registered', () => {
    const registry = createLaunchTolerantAwareRegistry();
    expect(() => ensureConfiguredModelIsRoutable(registry, makeConfigManager('no-such-provider:some-model'))).not.toThrow();
    expect(registry.listModels().some((m) => m.registryKey === 'no-such-provider:some-model')).toBe(false);
  });

  test('registers a runtime fallback model when the provider is registered but the model is unknown to the catalog', () => {
    const registry = createLaunchTolerantAwareRegistry();
    const providerId = registry.listModels()[0]?.provider;
    if (!providerId) throw new Error('test setup expects at least one built-in provider to exist');
    const configuredModel = `${providerId}:a-model-not-in-the-catalog-yet`;

    ensureConfiguredModelIsRoutable(registry, makeConfigManager(configuredModel));

    expect(registry.listModels().some((m) => m.registryKey === configuredModel)).toBe(true);
  });
});

function makeConfigManager(providerModel: string): ConfigManager {
  return {
    get: (key: string) => (key === 'provider.model' ? providerModel : undefined),
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/provider-fallback-model-test',
  } as unknown as ConfigManager;
}

function createLaunchTolerantAwareRegistry(): ProviderRegistry {
  return new ProviderRegistry(makeRegistryOptions());
}
