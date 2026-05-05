/**
 * companion-adapter-model-resolution.test.ts
 *
 * Verifies that the companion adapter resolves a registry key to the
 * provider-local model id before calling provider.chat().
 */

import { describe, expect, test } from 'bun:test';
import { createCompanionProviderAdapter } from '../packages/sdk/src/platform/daemon/facade-composition.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../packages/sdk/src/platform/providers/interface.js';
import type { ToolDefinition } from '../packages/sdk/src/platform/types/tools.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Records the model field received by provider.chat() for assertion. */
function makeRecordingProvider(name: string): LLMProvider & { recordedModel: string | null; recordedTools: ToolDefinition[] | undefined } {
  const stub = {
    name,
    models: [],
    recordedModel: null as string | null,
    recordedTools: undefined as ToolDefinition[] | undefined,
    isConfigured() { return true; },
    async chat(params: ChatRequest): Promise<ChatResponse> {
      stub.recordedModel = params.model;
      stub.recordedTools = params.tools;
      return { content: 'ok', stopReason: 'completed', toolCalls: [] };
    },
  };
  return stub;
}

function makeModelDef(id: string, provider: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: '',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
  };
}

/**
 * Minimal ProviderRegistry implementation that knows about a single model.
 */
function makeStubRegistry(
  modelDef: ModelDefinition,
  provider: LLMProvider,
): ProviderRegistry {
  return {
    getForModel(_modelId: string, _provider?: string): LLMProvider {
      return provider;
    },
    listModels(): ModelDefinition[] {
      return [modelDef];
    },
    getCurrentModel(): ModelDefinition {
      return modelDef;
    },
    // Other ProviderRegistry methods not used by the adapter under test
  } as unknown as ProviderRegistry;
}

function makeMultiModelRegistry(
  modelDefs: readonly ModelDefinition[],
  providers: Readonly<Record<string, LLMProvider>>,
): ProviderRegistry {
  return {
    getForModel(modelId: string, provider?: string): LLMProvider {
      const def = provider
        ? modelDefs.find((model) => (model.registryKey === modelId || model.id === modelId) && model.provider === provider)
        : modelDefs.find((model) => model.registryKey === modelId);
      const resolvedProvider = def?.provider ?? provider;
      const selectedProvider = resolvedProvider ? providers[resolvedProvider] : undefined;
      if (!selectedProvider) throw new Error('provider not found');
      return selectedProvider;
    },
    listModels(): ModelDefinition[] {
      return [...modelDefs];
    },
    getCurrentModel(): ModelDefinition {
      return modelDefs[0]!;
    },
  } as unknown as ProviderRegistry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompanionProviderAdapter — model id resolution', () => {
  test('passes provider-local model id to provider.chat() when options.model is a registry key', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inceptionlabs:mercury-2', provider: 'inceptionlabs' },
    );

    // Drain stream
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    // The adapter must pass provider-local "mercury-2", NOT "inceptionlabs:mercury-2"
    expect(recordingProvider.recordedModel).toBe('mercury-2');
    expect(recordingProvider.recordedModel).not.toBe('inceptionlabs:mercury-2');
  });

  test('passes provider-local model id when options.provider is not supplied by registryKey lookup', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inceptionlabs:mercury-2' },  // no options.provider
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('mercury-2');
  });

  test('unknown registry key returns an error instead of guessing from the prefix', async () => {
    // Registry that returns no model definitions (unknown model)
    const unexpectedProvider = makeRecordingProvider('unknown-provider');
    const modelDef = makeModelDef('unknown-model', 'unknown-provider');
    const emptyRegistry: ProviderRegistry = {
      getForModel(): LLMProvider { return unexpectedProvider; },
      listModels(): ModelDefinition[] { return []; },  // empty — no def found
      getCurrentModel(): ModelDefinition { return modelDef; },
    } as unknown as ProviderRegistry;

    const adapter = createCompanionProviderAdapter(emptyRegistry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'someprovider:some-model-id' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(unexpectedProvider.recordedModel).toBeNull();
    expect(chunks).toContainEqual({
      type: 'error',
      error: "Model 'someprovider:some-model-id' is not in the provider registry.",
    });
  });

  test('provider-qualified registryKey disambiguates duplicate model ids', async () => {
    const openaiModel = makeModelDef('gpt-4o', 'openai');
    const azureModel = makeModelDef('gpt-4o', 'azure-openai');
    const openaiProvider = makeRecordingProvider('openai');
    const azureProvider = makeRecordingProvider('azure-openai');
    const registry = makeMultiModelRegistry(
      [openaiModel, azureModel],
      { openai: openaiProvider, 'azure-openai': azureProvider },
    );

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'azure-openai:gpt-4o' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(azureProvider.recordedModel).toBe('gpt-4o');
    expect(openaiProvider.recordedModel).toBeNull();
  });

  test('no options.model selects the current provider-qualified registry key', async () => {
    const modelDef = makeModelDef('claude-sonnet', 'anthropic');
    const recordingProvider = makeRecordingProvider('anthropic');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      {},  // no model specified
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('claude-sonnet');
  });

  test('forwards companion remote-session tools to provider.chat()', async () => {
    const modelDef = makeModelDef('gpt-5.4', 'openai');
    const recordingProvider = makeRecordingProvider('openai');
    const registry = makeStubRegistry(modelDef, recordingProvider);
    const tools: ToolDefinition[] = [
      {
        name: 'read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'what tools do you have?' }],
      { model: 'openai:gpt-5.4', provider: 'openai', tools },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedTools?.map((tool) => tool.name)).toEqual(['read']);
  });
});
