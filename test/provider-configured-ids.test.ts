import { describe, expect, test } from 'bun:test';
import { getConfiguredProviderIds } from '../packages/sdk/src/platform/providers/credentials.js';
import { computeConfiguredProviderIds } from '../packages/sdk/src/platform/providers/registry-configured-ids.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { CatalogModel } from '../packages/sdk/src/platform/providers/model-catalog.js';

const TEST_ENV_VAR = 'GOODVIBES_TEST_PROVIDER_CONFIGURED_IDS_API_KEY';

function makeCatalogModel(providerId: string, providerEnvVars: string[]): CatalogModel {
  return {
    id: `${providerId}/test-model`,
    name: `${providerId} test model`,
    provider: providerId,
    providerId,
    providerEnvVars,
    pricing: { input: 0, output: 0 },
    tier: 'paid',
  };
}

function makeProvider(name: string, configured: boolean): LLMProvider {
  return {
    name,
    models: [],
    chat: async () => ({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'completed',
    }),
    isConfigured: () => configured,
  };
}

function withTestEnv(fn: () => void): void {
  const previous = process.env[TEST_ENV_VAR];
  process.env[TEST_ENV_VAR] = 'env-key';
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[TEST_ENV_VAR];
    } else {
      process.env[TEST_ENV_VAR] = previous;
    }
  }
}

function expectConfiguredSignals(ids: string[]): void {
  const configured = new Set(ids);
  expect(configured).toEqual(new Set([
    'env-provider',
    'anonymous-provider',
    'google',
    'inception',
    'custom-config',
    'synthetic',
    'self-report',
  ]));
}

describe('configured provider id helpers', () => {
  const catalogModels = [
    makeCatalogModel('env-provider', [TEST_ENV_VAR]),
    makeCatalogModel('anonymous-provider', []),
  ];
  const providers = new Map<string, LLMProvider>([
    ['self-report', makeProvider('self-report', true)],
    ['not-configured', makeProvider('not-configured', false)],
  ]);
  const configApiKeys = {
    gemini: 'gemini-config-key',
    inceptionlabs: 'inception-config-key',
    'custom-config': 'custom-config-key',
    empty: '',
  };

  test('computeConfiguredProviderIds preserves env, config, synthetic, and provider self-report signals', () => {
    withTestEnv(() => {
      const ids = computeConfiguredProviderIds(
        catalogModels,
        providers,
        () => new Set(['synthetic-backend']),
        () => configApiKeys,
      );

      expectConfiguredSignals(ids);
    });
  });

  test('computeConfiguredProviderIds propagates config API key load failures', () => {
    expect(() => computeConfiguredProviderIds(
      catalogModels,
      providers,
      () => new Set(['synthetic-backend']),
      () => {
        throw new Error('config API key load failed');
      },
    )).toThrow('config API key load failed');
  });

  test('getConfiguredProviderIds preserves env, config, synthetic, and provider self-report signals', () => {
    withTestEnv(() => {
      const ids = getConfiguredProviderIds(
        catalogModels,
        new Set(['synthetic-backend']),
        providers,
        () => configApiKeys,
      );

      expectConfiguredSignals(ids);
    });
  });

  test('getConfiguredProviderIds propagates config API key load failures', () => {
    expect(() => getConfiguredProviderIds(
      catalogModels,
      new Set(['synthetic-backend']),
      providers,
      () => {
        throw new Error('config API key load failed');
      },
    )).toThrow('config API key load failed');
  });
});
