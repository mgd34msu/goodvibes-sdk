import { describe, expect, test } from 'bun:test';
import {
  HelperModel,
  HelperModelUnavailableError,
  HelperRouter,
  resolveToolLLM,
  ToolLLM,
  ToolLLMUnavailableError,
} from '../packages/sdk/src/platform/config/index.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

function model(provider = 'openai', id = 'gpt-4.1-mini'): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: id,
    description: id,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: false,
      multimodal: false,
    },
    contextWindow: 128_000,
    selectable: true,
  };
}

function provider(name: string, content = 'ok'): LLMProvider {
  return {
    name,
    models: [],
    async chat() {
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'completed',
      };
    },
  };
}

describe('tool LLM routing', () => {
  test('disabled tool LLM chat throws instead of returning an empty string', async () => {
    const toolLLM = new ToolLLM({
      configManager: { get: () => false },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
      },
    });

    await expect(toolLLM.chat('summarize')).rejects.toThrow(ToolLLMUnavailableError);
  });

  test('explicit tool route validates provider-qualified model ownership', () => {
    const deps = {
      configManager: {
        get: (key: string) => {
          if (key === 'tools.llmEnabled') return true;
          if (key === 'tools.llmProvider') return 'openai';
          if (key === 'tools.llmModel') return 'anthropic:claude-3-5-haiku';
          return '';
        },
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
      },
    };

    expect(() => resolveToolLLM(deps)).toThrow("conflicts with provider 'openai'");
  });

  test('explicit tool route uses registry lookup and provider-local model id', async () => {
    let lookup: { modelId: string; provider?: string | undefined } | undefined;
    let requestedModel: string | undefined;
    const routedProvider: LLMProvider = {
      ...provider('openai', 'tool response'),
      async chat(params) {
        requestedModel = params.model;
        return {
          content: 'tool response',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const toolLLM = new ToolLLM({
      configManager: {
        get: (key: string) => {
          if (key === 'tools.llmEnabled') return true;
          if (key === 'tools.llmProvider') return 'openai';
          if (key === 'tools.llmModel') return 'gpt-4.1-mini';
          return '';
        },
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: (modelId, providerId) => {
          lookup = { modelId, provider: providerId };
          return routedProvider;
        },
      },
    });

    await expect(toolLLM.chat('summarize')).resolves.toBe('tool response');
    expect(lookup).toEqual({ modelId: 'openai:gpt-4.1-mini', provider: 'openai' });
    expect(requestedModel).toBe('gpt-4.1-mini');
  });

  test('missing tool response content is not converted to an empty string', async () => {
    const badProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        return {
          content: undefined as unknown as string,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const toolLLM = new ToolLLM({
      configManager: {
        get: (key: string) => key === 'tools.llmEnabled',
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => badProvider,
      },
    });

    await expect(toolLLM.chat('summarize')).rejects.toThrow('did not include string content');
  });
});

describe('helper model routing', () => {
  test('helperOnly preserves optional helper absence as explicit null', async () => {
    const helper = new HelperModel({
      configManager: {
        get: () => false,
        getCategory: () => undefined,
      },
      providerRegistry: {
        getCurrentModel: () => {
          throw new Error('must not fall back to current model');
        },
        getForModel: () => provider('openai'),
      },
    });

    await expect(helper.chat('tool_summarize', 'summarize', { helperOnly: true })).resolves.toBeNull();
  });

  test('disabled non-optional helper chat throws instead of using the main model', async () => {
    const helper = new HelperModel({
      configManager: {
        get: () => false,
        getCategory: () => undefined,
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
      },
    });

    await expect(helper.chat('cache_strategy', 'plan')).rejects.toThrow(HelperModelUnavailableError);
  });

  test('enabled helper with no dedicated route does not fall back to main model', async () => {
    const helper = new HelperModel({
      configManager: {
        get: (key: string) => key === 'helper.enabled',
        getCategory: () => undefined,
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => provider('openai'),
      },
    });

    await expect(helper.chat('cache_strategy', 'plan')).rejects.toThrow(HelperModelUnavailableError);
  });

  test('per-provider helper route rejects provider/model conflicts without trying later routes', () => {
    const router = new HelperRouter({
      configManager: {
        get: (key: string) => {
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        },
        getCategory: () => ({
          providers: {
            openai: { provider: 'openai', model: 'anthropic:claude-3-5-haiku' },
          },
        }),
      },
      providerRegistry: {
        getCurrentModel: () => model('openai', 'gpt-4.1'),
        getForModel: () => provider('openai'),
      },
    });

    expect(() => router.resolve('cache_strategy')).toThrow("conflicts with provider 'openai'");
  });

  test('helper provider request failures are observable', async () => {
    const failingProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        throw new Error('provider unavailable');
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: (key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        },
        getCategory: () => undefined,
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => failingProvider,
      },
    });

    await expect(helper.chat('cache_strategy', 'plan')).rejects.toThrow('provider unavailable');
  });

  test('missing helper response content is not converted to an empty string', async () => {
    const badProvider: LLMProvider = {
      ...provider('openai'),
      async chat() {
        return {
          content: undefined as unknown as string,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'completed',
        };
      },
    };
    const helper = new HelperModel({
      configManager: {
        get: (key: string) => {
          if (key === 'helper.enabled') return true;
          if (key === 'helper.globalProvider') return 'openai';
          if (key === 'helper.globalModel') return 'gpt-4.1-mini';
          return '';
        },
        getCategory: () => undefined,
      },
      providerRegistry: {
        getCurrentModel: () => model(),
        getForModel: () => badProvider,
      },
    });

    await expect(helper.chat('cache_strategy', 'plan')).rejects.toThrow('did not include string content');
  });
});
