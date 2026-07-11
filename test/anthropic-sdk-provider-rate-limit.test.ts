/**
 * anthropic-sdk-provider-rate-limit.test.ts
 *
 * Rate-limit header capture for the shared AnthropicSdkProvider base class
 * (AmazonBedrockProvider + AnthropicVertexProvider both extend it, unchanged
 * otherwise). Verified against the installed @anthropic-ai/sdk MessageStream:
 * `get response(): Response | null | undefined`, populated once the stream
 * connects (well before finalMessage() resolves). Both Bedrock's `messages`
 * resource (re-exported verbatim from @anthropic-ai/sdk's Resources.Messages,
 * per @anthropic-ai/bedrock-sdk's client.d.ts) and Vertex's
 * (AnthropicVertexClient extends BaseAnthropic from the same SDK) return this
 * exact class from .stream(), so one read site covers both providers.
 */
import { describe, expect, test } from 'bun:test';
import { AnthropicSdkProvider } from '../packages/sdk/src/platform/providers/anthropic-sdk-provider.ts';

/** A fake MessageStream matching the real class's shape: async-iterable of SSE events, finalMessage(), and a response getter populated at "connect" time. */
function fakeMessageStream(opts: {
  events: readonly Record<string, unknown>[];
  finalUsage: { input_tokens: number; output_tokens: number };
  finalContent: unknown[];
  response?: Response | null;
}): AsyncIterable<Record<string, unknown>> & { finalMessage(): Promise<unknown>; response?: Response | null } {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of opts.events) yield event;
    },
    finalMessage: async () => ({ content: opts.finalContent, usage: opts.finalUsage }),
    response: opts.response,
  };
}

function makeProvider(streamResult: ReturnType<typeof fakeMessageStream>): AnthropicSdkProvider {
  return new AnthropicSdkProvider({
    name: 'test-anthropic-sdk',
    label: 'Test',
    defaultModel: 'claude-x',
    models: ['claude-x'],
    createClient: () => ({ messages: { stream: () => streamResult } }),
    auth: { mode: 'api-key', configured: true, detail: 'test' },
    streamProtocol: 'anthropic-sdk-stream',
  });
}

describe('AnthropicSdkProvider rate-limit capture (shared by Bedrock + Vertex)', () => {
  test('populates ChatResponse.rateLimit from stream.response headers', async () => {
    const response = new Response(null, {
      headers: {
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
      },
    });
    const stream = fakeMessageStream({
      events: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
      finalUsage: { input_tokens: 10, output_tokens: 5 },
      finalContent: [{ type: 'text', text: 'hi' }],
      response,
    });
    const provider = makeProvider(stream);
    const result = await provider.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.rateLimit).toBeDefined();
    expect(result.rateLimit!.limit).toBe(50);
    expect(result.rateLimit!.remaining).toBe(49);
  });

  test('honestly omits rateLimit when the stream never exposed a response (or carried no recognized header)', async () => {
    const stream = fakeMessageStream({
      events: [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
      finalUsage: { input_tokens: 10, output_tokens: 5 },
      finalContent: [{ type: 'text', text: 'hi' }],
      response: null,
    });
    const provider = makeProvider(stream);
    const result = await provider.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.rateLimit).toBeUndefined();
  });
});
