/**
 * companion-adapter-model-resolution.test.ts
 *
 * Regression test for: companion adapter passes compound registry key
 * ("inception:mercury-2") to provider.chat() instead of bare model id
 * ("mercury-2"), causing 400 invalid_request_error from upstream compat APIs.
 *
 * Root cause: createCompanionProviderAdapter() used options.model directly as
 * the `model` field in provider.chat(). options.model is the registry key
 * (with provider prefix); upstream compat APIs (InceptionLabs, Venice,
 * Cerebras, Groq, etc.) only accept bare ids.
 *
 * Fix: resolve the ModelDefinition via the registry and use def.id (bare),
 * with getBaseModelId() as a safe fallback.
 */

import { describe, expect, test } from 'bun:test';
import { createCompanionProviderAdapter } from '../packages/sdk/src/platform/daemon/facade-composition.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../packages/sdk/src/platform/providers/interface.js';
import type { ToolDefinition } from '../packages/sdk/src/platform/types/tools.js';

// ---------------------------------------------------------------------------
// Stub helpers
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
 * Minimal stub ProviderRegistry that knows about a single model.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompanionProviderAdapter — model id resolution', () => {
  test('R1: passes bare model id to provider.chat() when options.model is a registry key', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inception:mercury-2', provider: 'inceptionlabs' },
    );

    // Drain stream
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    // The adapter must pass bare "mercury-2", NOT "inception:mercury-2"
    expect(recordingProvider.recordedModel).toBe('mercury-2');
    expect(recordingProvider.recordedModel).not.toBe('inception:mercury-2');
  });

  test('R2: passes bare model id when options.provider is not supplied (by registryKey lookup)', async () => {
    const modelDef = makeModelDef('mercury-2', 'inceptionlabs');
    const recordingProvider = makeRecordingProvider('inception');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'inception:mercury-2' },  // no options.provider
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('mercury-2');
  });

  test('R3: fallback split-on-colon when model def is not in registry', async () => {
    // Registry that returns no model definitions (unknown model)
    const fallbackProvider = makeRecordingProvider('unknown-provider');
    const modelDef = makeModelDef('unknown-model', 'unknown-provider');
    const emptyRegistry: ProviderRegistry = {
      getForModel(): LLMProvider { return fallbackProvider; },
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

    // Fallback: split on last ':' gives bare "some-model-id"
    expect(fallbackProvider.recordedModel).toBe('some-model-id');
  });

  test('R4: bare model id (no colon) is passed through unchanged', async () => {
    const modelDef = makeModelDef('gpt-4o', 'openai');
    const recordingProvider = makeRecordingProvider('openai');
    const registry = makeStubRegistry(modelDef, recordingProvider);

    const adapter = createCompanionProviderAdapter(registry);
    const stream = adapter.chatStream(
      [{ role: 'user', content: 'hello' }],
      { model: 'gpt-4o', provider: 'openai' },
    );

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(recordingProvider.recordedModel).toBe('gpt-4o');
  });

  test('R5: no options.model falls back to getCurrentModel().id (bare)', async () => {
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

    // getCurrentModel().id is 'claude-sonnet' (bare — no prefix)
    expect(recordingProvider.recordedModel).toBe('claude-sonnet');
  });

  test('R6: forwards companion remote-session tools to provider.chat()', async () => {
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
