import { describe, expect, test } from 'bun:test';
import { AnthropicProvider } from '../packages/sdk/src/platform/providers/anthropic.js';
import {
  extractTextToolCalls,
  fromOpenAIToolCalls,
} from '../packages/sdk/src/platform/providers/tool-formats.js';

describe('provider streamed tool argument parsing', () => {
  test('drops malformed OpenAI accumulated arguments instead of returning empty args', () => {
    const toolCalls = fromOpenAIToolCalls([
      {
        id: 'call-bad',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":' },
      },
    ]);

    expect(toolCalls).toEqual([]);
  });

  test('keeps valid OpenAI accumulated arguments', () => {
    const toolCalls = fromOpenAIToolCalls([
      {
        id: 'call-ok',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);

    expect(toolCalls).toEqual([
      {
        id: 'call-ok',
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    ]);
  });

  test('drops malformed text-delimited tool calls instead of returning empty args', () => {
    const parsed = extractTextToolCalls(
      '<|toolcallbegin|>functions.read_file:0<|toolcallargumentbegin|>{"path":<|toolcallend|>',
    );

    expect(parsed.toolCalls).toEqual([]);
  });

  test('drops malformed Anthropic streamed input_json_delta arguments', async () => {
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-bad","name":"read_file"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof globalThis.fetch;
    try {
      const provider = new AnthropicProvider('test-key');
      const response = await provider.chat({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'read' }],
        tools: [{
          name: 'read_file',
          description: 'read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        }],
      });

      expect(response.stopReason).toBe('tool_call');
      expect(response.toolCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
