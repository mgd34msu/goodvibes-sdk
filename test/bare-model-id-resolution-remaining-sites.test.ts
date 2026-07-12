/**
 * "Bare model IDs just work" — proves the shared resolver (model-id-resolution.ts)
 * is wired into the remaining mapped sites not already covered by
 * model-routes.test.ts, openai-compatible-routes.test.ts,
 * provider-registry-canonical-api.test.ts, and feature-flag-gates.test.ts:
 *   - media/builtin-image-understanding.ts resolveModel
 *   - providers/provider-api.ts resolveModelOrThrow / listBenchmarks
 *   - automation/manager-runtime-helpers.ts buildDefaultExecution (registry threaded)
 *   - control-plane/session-intents.ts buildSharedSessionAgentSpawnRoutingInput (registry threaded)
 *   - tools/agent/manager.ts AgentManager.spawn() (registry threaded)
 */
import { describe, expect, test } from 'bun:test';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import { createBuiltinImageUnderstandingProvider } from '../packages/sdk/src/platform/media/builtin-image-understanding.js';
import { createProviderApi, type ProviderApiDependencies } from '../packages/sdk/src/platform/providers/provider-api.js';
import { buildDefaultExecution } from '../packages/sdk/src/platform/automation/manager-runtime-helpers.js';
import { buildSharedSessionAgentSpawnRoutingInput } from '../packages/sdk/src/platform/control-plane/session-intents.js';
import { AgentManager } from '../packages/sdk/src/platform/tools/agent/manager.js';

function makeModel(provider: string, id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: 'test model',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: true },
    contextWindow: 8192,
    selectable: true,
    tier: 'standard',
    ...overrides,
  };
}

describe('media/builtin-image-understanding.ts — bare model id resolution', () => {
  test('a unique bare model id resolves and reaches the real provider', async () => {
    const model = makeModel('gemini', 'vision-model');
    const provider: LLMProvider = {
      name: 'gemini',
      models: ['vision-model'],
      async chat() {
        return { content: '{"description":"a cat","text":"","labels":["cat"]}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      },
    };
    const registry = {
      getCurrentModel: () => model,
      getForModel: () => provider,
      listModels: () => [model],
      describeRuntime: async () => null,
    };
    const mediaProvider = createBuiltinImageUnderstandingProvider(registry, {
      readContent: async () => { throw new Error('not used — dataBase64 supplied directly'); },
    });
    const result = await mediaProvider.analyze({
      artifact: { mimeType: 'image/png', dataBase64: 'ZmFrZQ==', metadata: {} },
      modelId: 'vision-model',
      metadata: {},
    });
    expect(result.metadata.modelId).toBe('vision-model');
    expect(result.description).toBe('a cat');
  });

  test('an ambiguous bare model id is rejected with the real candidates, never a silent guess', async () => {
    const geminiModel = makeModel('gemini', 'shared-vision');
    const openaiModel = makeModel('openai', 'shared-vision');
    const registry = {
      getCurrentModel: () => geminiModel,
      getForModel: (): LLMProvider => { throw new Error('provider lookup should not run for an ambiguous bare model id'); },
      listModels: () => [geminiModel, openaiModel],
      describeRuntime: async () => null,
    };
    const mediaProvider = createBuiltinImageUnderstandingProvider(registry, {
      readContent: async () => { throw new Error('not used'); },
    });
    await expect(mediaProvider.analyze({
      artifact: { mimeType: 'image/png', dataBase64: 'ZmFrZQ==', metadata: {} },
      modelId: 'shared-vision',
      metadata: {},
    })).rejects.toThrow(/gemini:shared-vision.*openai:shared-vision/);
  });
});

describe('providers/provider-api.ts — bare model id resolution', () => {
  function makeDeps(models: ModelDefinition[]): ProviderApiDependencies {
    const pinned: Array<{ registryKey: string; pinnedAt: string }> = [];
    return {
      providerRegistry: {
        listModels: () => models,
        getCurrentModel: () => models[0]!,
        getForModel: () => ({ name: models[0]!.provider }) as LLMProvider,
        findAlternativeModel: () => null,
        getSyntheticModelInfoFromCatalog: () => null,
        getCostFromCatalog: () => ({ input: 0, output: 0 }),
        getPricingForModel: () => null,
        getCatalogModelDefinitions: () => [],
        has: () => true,
        require: () => ({ name: models[0]!.provider }) as LLMProvider,
        tryGet: () => undefined,
        getContextWindowForModel: () => 8192,
        getRegistered: () => ({ name: models[0]!.provider }) as LLMProvider,
        getSelectableModels: () => models,
        listProviders: () => [],
        registerDiscoveredProviders: () => {},
        refreshCatalog: async () => {},
        refreshLiveModelDiscovery: async () => [],
        refreshModelLimits: async () => 0,
        setCurrentModel: () => {},
        describeRuntime: async () => null,
      },
      favoritesStore: {
        load: async () => ({ pinned: [...pinned], history: [] }),
        pinModel: async (registryKey: string) => { pinned.push({ registryKey, pinnedAt: new Date().toISOString() }); },
        unpinModel: async (registryKey: string) => {
          const idx = pinned.findIndex((entry) => entry.registryKey === registryKey);
          if (idx >= 0) pinned.splice(idx, 1);
        },
        recordUsage: async () => {},
      },
      benchmarkStore: {
        getBenchmarks: () => undefined,
        refreshBenchmarks: async () => 0,
      },
    };
  }

  test('pinModel resolves a unique bare model id via the shared resolver', async () => {
    const model = makeModel('anthropic', 'claude-fable-5');
    const api = createProviderApi(makeDeps([model]));
    const favorites = await api.pinModel('claude-fable-5');
    expect(favorites.pinned.some((entry) => entry.registryKey === 'anthropic:claude-fable-5')).toBe(true);
  });

  test('listBenchmarks({registryKeys}) resolves a bare model id in the filter list', async () => {
    const model = makeModel('anthropic', 'claude-fable-5');
    const api = createProviderApi(makeDeps([model]));
    // No benchmark data registered — this proves resolution succeeds (no throw)
    // rather than the old format-lecture rejection; an empty result is expected.
    const records = await api.listBenchmarks({ registryKeys: ['claude-fable-5'] });
    expect(records).toEqual([]);
  });

  test('pinModel rejects an ambiguous bare model id with the real candidates', async () => {
    const modelA = makeModel('anthropic', 'shared-name');
    const modelB = makeModel('openai', 'shared-name');
    const api = createProviderApi(makeDeps([modelA, modelB]));
    await expect(api.pinModel('shared-name')).rejects.toThrow(/anthropic:shared-name.*openai:shared-name/);
  });
});

describe('automation/manager-runtime-helpers.ts — bare model id resolution (registry threaded)', () => {
  const configManager = { get: () => undefined } as unknown as Parameters<typeof buildDefaultExecution>[1];

  test('a unique bare model id auto-qualifies when the registry is threaded through', () => {
    const models = [makeModel('anthropic', 'claude-fable-5')];
    const execution = buildDefaultExecution({
      name: 'job',
      prompt: 'do work',
      schedule: { kind: 'every', intervalMs: 60_000 },
      model: 'claude-fable-5',
    }, configManager, models);
    expect(execution.modelId).toBe('anthropic:claude-fable-5');
  });

  test('an ambiguous bare model id is rejected with the real candidates when the registry is threaded through', () => {
    const models = [makeModel('anthropic', 'shared-name'), makeModel('openai', 'shared-name')];
    expect(() => buildDefaultExecution({
      name: 'job',
      prompt: 'do work',
      schedule: { kind: 'every', intervalMs: 60_000 },
      model: 'shared-name',
    }, configManager, models)).toThrow(/anthropic:shared-name.*openai:shared-name/);
  });

  test('without a threaded registry, the prior format-only validation is unchanged', () => {
    expect(() => buildDefaultExecution({
      name: 'job',
      prompt: 'do work',
      schedule: { kind: 'every', intervalMs: 60_000 },
      model: 'bare-model',
    }, configManager)).toThrow(/must be a provider-qualified registry key/);
  });
});

describe('control-plane/session-intents.ts — bare model id resolution (registry threaded)', () => {
  test('a unique bare model id auto-qualifies when modelCandidates is supplied', () => {
    const models = [{ id: 'claude-fable-5', provider: 'anthropic', registryKey: 'anthropic:claude-fable-5' }];
    const result = buildSharedSessionAgentSpawnRoutingInput(
      { modelId: 'claude-fable-5' },
      { modelCandidates: models },
    );
    expect(result.model).toBe('anthropic:claude-fable-5');
  });

  test('an ambiguous bare model id is rejected with the real candidates when modelCandidates is supplied', () => {
    const models = [
      { id: 'shared-name', provider: 'anthropic', registryKey: 'anthropic:shared-name' },
      { id: 'shared-name', provider: 'openai', registryKey: 'openai:shared-name' },
    ];
    expect(() => buildSharedSessionAgentSpawnRoutingInput(
      { modelId: 'shared-name' },
      { modelCandidates: models },
    )).toThrow(/anthropic:shared-name.*openai:shared-name/);
  });
});

describe('tools/agent/manager.ts AgentManager.spawn() — bare model id resolution (registry threaded)', () => {
  test('a unique bare model id auto-qualifies when providerRegistry is configured', () => {
    const models = [makeModel('anthropic', 'claude-fable-5')];
    const manager = new AgentManager({
      configManager: { get: () => null },
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      providerRegistry: { listModels: () => models },
    });
    const record = manager.spawn({
      mode: 'spawn',
      task: 'do work',
      model: 'claude-fable-5',
    });
    expect(record.model).toBe('anthropic:claude-fable-5');
  });

  test('an ambiguous bare model id is rejected with the real candidates when providerRegistry is configured', () => {
    const models = [makeModel('anthropic', 'shared-name'), makeModel('openai', 'shared-name')];
    const manager = new AgentManager({
      configManager: { get: () => null },
      messageBus: { registerAgent() {} },
      archetypeLoader: { loadArchetype: () => null },
      providerRegistry: { listModels: () => models },
    });
    expect(() => manager.spawn({
      mode: 'spawn',
      task: 'do work',
      model: 'shared-name',
    })).toThrow(/anthropic:shared-name.*openai:shared-name/);
  });
});
