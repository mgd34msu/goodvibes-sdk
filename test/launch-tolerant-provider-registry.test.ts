/**
 * Unit tests for createLaunchTolerantProviderRegistry: a ProviderRegistry
 * construction that never throws over a missing provider API key, and leaves
 * no residue (env restored, provider left honestly unconfigured) once it has.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createLaunchTolerantProviderRegistry } from '../packages/sdk/src/platform/providers/launch-tolerant-registry.ts';
import { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.ts';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistryOptions(config: Readonly<Record<string, unknown>> = {}): RegistryOptions {
  const configManager = {
    get: (key: string) => config[key],
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/launch-tolerant-registry-test',
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

const TRACKED_ENV_VARS = ['OPENAI_API_KEY', 'OPENAI_KEY', 'GROQ_API_KEY'] as const;

describe('createLaunchTolerantProviderRegistry', () => {
  const savedEnv = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of TRACKED_ENV_VARS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    savedEnv.clear();
  });

  function stashEnv(key: string): void {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }

  test('constructs successfully with every tracked provider env var absent', () => {
    for (const key of TRACKED_ENV_VARS) {
      stashEnv(key);
      delete process.env[key];
    }

    expect(() => createLaunchTolerantProviderRegistry(makeRegistryOptions())).not.toThrow();
  });

  test('restores the real environment after construction (no placeholder leak)', () => {
    for (const key of TRACKED_ENV_VARS) {
      stashEnv(key);
      delete process.env[key];
    }

    createLaunchTolerantProviderRegistry(makeRegistryOptions());

    for (const key of TRACKED_ENV_VARS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  test('a provider constructed via the placeholder ends up unconfigured with an empty key', () => {
    for (const key of TRACKED_ENV_VARS) {
      stashEnv(key);
      delete process.env[key];
    }

    const registry = createLaunchTolerantProviderRegistry(makeRegistryOptions());
    const openai = registry.tryGet('openai') as { apiKey?: unknown; configured?: unknown } | undefined;

    expect(openai).toBeDefined();
    expect(openai?.apiKey).toBe('');
    // Not every provider class carries a mutable `configured` field (OpenAIProvider
    // computes it on demand rather than storing it) — the reset is conditional on
    // the field existing at all, so this only asserts it when present.
    if (openai && 'configured' in openai) expect(openai.configured).toBe(false);
  });

  test('a provider whose env var IS configured is left alone (real key preserved, no placeholder logic touches it)', () => {
    stashEnv('OPENAI_API_KEY');
    stashEnv('OPENAI_KEY');
    stashEnv('GROQ_API_KEY');
    process.env.OPENAI_API_KEY = 'real-test-key-value';
    delete process.env.OPENAI_KEY;
    delete process.env.GROQ_API_KEY;

    const registry = createLaunchTolerantProviderRegistry(makeRegistryOptions());
    const openai = registry.tryGet('openai') as { apiKey?: unknown; configured?: unknown } | undefined;

    expect(openai?.apiKey).toBe('real-test-key-value');
  });

  test('restores the real environment even when construction throws', () => {
    for (const key of TRACKED_ENV_VARS) {
      stashEnv(key);
      delete process.env[key];
    }

    const options = makeRegistryOptions();
    const throwingOptions = new Proxy(options, {
      get(target, prop, receiver) {
        if (prop === 'configManager') throw new Error('boom: construction failed');
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(() => createLaunchTolerantProviderRegistry(throwingOptions as RegistryOptions)).toThrow('boom: construction failed');

    for (const key of TRACKED_ENV_VARS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  test('a provider with one of several env vars configured is left alone (huggingface accepts 3 alternates)', () => {
    stashEnv('HF_API_KEY');
    stashEnv('HUGGINGFACE_API_KEY');
    stashEnv('HF_TOKEN');
    delete process.env.HF_API_KEY;
    process.env.HUGGINGFACE_API_KEY = 'already-configured-hf';
    delete process.env.HF_TOKEN;

    const registry = createLaunchTolerantProviderRegistry(makeRegistryOptions());
    const huggingface = registry.tryGet('huggingface') as { apiKey?: unknown } | undefined;

    expect(huggingface?.apiKey).toBe('already-configured-hf');

    delete process.env.HUGGINGFACE_API_KEY;
  });
});
