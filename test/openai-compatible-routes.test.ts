import { describe, expect, test } from 'bun:test';
import { dispatchOpenAICompatibleRoutes } from '../packages/sdk/src/platform/daemon/http/openai-compatible-routes.js';
import type { LLMProvider } from '../packages/sdk/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../packages/sdk/src/platform/providers/registry.js';
import type { ModelDefinition } from '../packages/sdk/src/platform/providers/registry-types.js';

function makeModel(provider: string, id: string): ModelDefinition {
  return {
    id,
    provider,
    registryKey: `${provider}:${id}`,
    displayName: `${provider} ${id}`,
    description: 'test model',
    capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
    contextWindow: 8192,
    selectable: true,
    tier: 'standard',
  };
}

function makeProvider(): LLMProvider & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    name: 'openai',
    models: ['gpt-test'],
    requests,
    async chat(params) {
      requests.push(params);
      params.onDelta?.({ content: 'hello' });
      params.onDelta?.({ content: ' world' });
      return {
        content: 'hello world',
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 2 },
        stopReason: 'completed',
      };
    },
  };
}

function makeRegistry(provider: LLMProvider): Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getForModel'> {
  const model = makeModel('openai', 'gpt-test');
  return {
    listModels: () => [model],
    getCurrentModel: () => model,
    getForModel: () => provider,
  };
}

function makeContext(provider: LLMProvider) {
  return {
    providerRegistry: makeRegistry(provider),
    parseJsonBody: async (request: Request) => await request.json() as Record<string, unknown>,
    recordApiResponse: (_request: Request, _path: string, response: Response) => response,
  };
}

function request(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:3421${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('OpenAI-compatible daemon routes', () => {
  test('lists registry models and GoodVibes aliases', async () => {
    const provider = makeProvider();
    const response = await dispatchOpenAICompatibleRoutes(request('/v1/models'), makeContext(provider));
    expect(response?.status).toBe(200);
    const body = await response!.json() as { data: Array<{ id: string }> };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain('goodvibes/current');
    expect(ids).toContain('goodvibes/default');
    expect(ids).toContain('openai:gpt-test');
    expect(ids).toContain('gpt-test');
  });

  test('maps chat completions requests to provider chat responses', async () => {
    const provider = makeProvider();
    const response = await dispatchOpenAICompatibleRoutes(request('/v1/chat/completions', {
      model: 'openai:gpt-test',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'say hello' },
      ],
    }), makeContext(provider));
    expect(response?.status).toBe(200);
    const body = await response!.json() as {
      object: string;
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('openai:gpt-test');
    expect(body.choices[0]?.message.content).toBe('hello world');
    expect(body.usage.total_tokens).toBe(5);
    expect(provider.requests.length).toBe(1);
  });

  test('streams OpenAI-style SSE chunks', async () => {
    const provider = makeProvider();
    const response = await dispatchOpenAICompatibleRoutes(request('/v1/chat/completions', {
      model: 'goodvibes/current',
      stream: true,
      messages: [{ role: 'user', content: 'stream' }],
    }), makeContext(provider));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toContain('text/event-stream');
    const text = await response!.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"content":" world"');
    expect(text).toContain('data: [DONE]');
  });
});
