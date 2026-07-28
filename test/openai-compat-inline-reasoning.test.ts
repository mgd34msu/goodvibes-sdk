/**
 * Inline reasoning through the REAL OpenAICompatProvider.chat path.
 *
 * The splitter has its own unit tests (inline-reasoning-extraction.test.ts);
 * these drive an actual SSE stream through the provider so the wiring is
 * covered too: what lands in `response.content`, what reaches `onDelta` as
 * reasoning, and — the part that matters most — that the split can never
 * empty a reply.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { OpenAICompatProvider } from '../packages/sdk/src/platform/providers/openai-compat.js';

/**
 * Serve `pieces` as one OpenAI-compatible SSE completion stream.
 *
 * A piece given as `{ reasoning }` is emitted on the delta's own `reasoning`
 * field — the shape cerebras actually sends (verified against
 * api.cerebras.ai/v1 with gpt-oss-120b).
 */
type Piece = string | { readonly reasoning: string };

function sseServer(pieces: readonly Piece[], extra: { readonly toolCall?: boolean } = {}): Server<undefined> {
  return Bun.serve({
    port: 0,
    fetch() {
      const chunks: string[] = [];
      for (const piece of pieces) {
        const delta = typeof piece === 'string' ? { content: piece } : { reasoning: piece.reasoning };
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`);
      }
      if (extra.toolCall) {
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } }] },
            finish_reason: null,
          }],
        })}\n\n`);
      }
      chunks.push(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, delta: {}, finish_reason: extra.toolCall ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })}\n\n`);
      chunks.push('data: [DONE]\n\n');
      return new Response(chunks.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
}

function providerFor(server: Server<undefined>): OpenAICompatProvider {
  return new OpenAICompatProvider({
    name: 'inline-reasoning-test',
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: 'irrelevant-test-key',
    defaultModel: 'test-model',
    models: ['test-model'],
    // 'none' is what cerebras and groq are registered with. The split must
    // still happen: that flag records which reasoning PARAMETER the endpoint
    // accepts on the REQUEST, and a tag in the RESPONSE is self-describing.
    reasoningFormat: 'none',
  });
}

describe('OpenAICompatProvider.chat splits inline reasoning out of the answer', () => {
  let server: Server<undefined> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test('the answer reaches content and the think block does not', async () => {
    server = sseServer(['<think>The user', ' asked 5+3.', ' That is 8.</think>', 'The answer is 8.']);
    const reasoningDeltas: string[] = [];
    const contentDeltas: string[] = [];

    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'what is 5+3' }],
      model: 'test-model',
      onDelta: (delta) => {
        if (delta.content) contentDeltas.push(delta.content);
        if (delta.reasoning) reasoningDeltas.push(delta.reasoning);
      },
    });

    expect(response.content).toBe('The answer is 8.');
    expect(response.content).not.toContain('<think>');
    expect(contentDeltas.join('')).toBe('The answer is 8.');
    expect(reasoningDeltas.join('')).toBe('The user asked 5+3. That is 8.');
  });

  test('a tag split across chunk boundaries never leaks a fragment into content', async () => {
    // The open tag arrives one character at a time — the shape that a
    // naive per-chunk filter misses entirely.
    server = sseServer(['Answer: ', '<', 't', 'h', 'i', 'n', 'k', '>', 'hidden', '</think>', ' 8.']);
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });

    expect(response.content).toBe('Answer:  8.');
    expect(response.content).not.toContain('think');
    expect(response.content).not.toContain('hidden');
  });

  test('a reply with no reasoning tag is untouched', async () => {
    server = sseServer(['The build is green', ' and the tag is pushed.']);
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });
    expect(response.content).toBe('The build is green and the tag is pushed.');
  });

  test('a message that is ENTIRELY reasoning still yields an answer', async () => {
    // The regression this guards: a model that writes nothing outside the tag
    // would otherwise leave `content` empty, and the completion would carry
    // nothing but "Agent completed in Nms". Sending the reasoning is worse
    // than sending the answer and better than sending nothing.
    server = sseServer(['<think>I think the answer is 8 but I never said so outside.</think>']);
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });

    expect(response.content.trim().length).toBeGreaterThan(0);
    expect(response.content).toContain('the answer is 8');
    expect(response.content).not.toContain('<think>');
  });

  test('an unterminated tag does not swallow the stream silently', async () => {
    server = sseServer(['Partial. ', '<think>cut off here']);
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });
    // The streaming splitter emits incrementally and does not re-trim what it
    // already forwarded, so the answer keeps its own spacing.
    expect(response.content.trim()).toBe('Partial.');
    expect(response.content).not.toContain('cut off here');
  });

  test('a returned reasoning FIELD is reasoning even on a reasoningFormat:none endpoint', async () => {
    // The root cause of the ntfy leak. `reasoningFormat: 'none'` (how cerebras,
    // groq and mistral are registered) used to tell the stream extractor to
    // FOLD a returned `reasoning` field into `content` — so reasoning became
    // ordinary answer text before any surface policy could see it, and arrived
    // interleaved with the answer. What a response carries is not a function
    // of what the request asked for.
    server = sseServer([
      { reasoning: 'The user asks simple addition.' },
      { reasoning: ' Provide explanation.' },
      'First, identify the two numbers',
      ': 5 and 3. The sum is 8.',
    ]);
    const reasoningDeltas: string[] = [];
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'what is 5+3' }],
      model: 'test-model',
      onDelta: (delta) => { if (delta.reasoning) reasoningDeltas.push(delta.reasoning); },
    });

    expect(response.content).toBe('First, identify the two numbers: 5 and 3. The sum is 8.');
    expect(response.content).not.toContain('The user asks simple addition');
    expect(reasoningDeltas.join('')).toBe('The user asks simple addition. Provide explanation.');
  });

  test('a turn whose ONLY output is a reasoning field still yields an answer', async () => {
    // The floor the folding behaviour used to provide, kept without also
    // mislabelling reasoning as answer text on every other turn.
    server = sseServer([{ reasoning: 'I worked it out: the answer is 8.' }]);
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });
    expect(response.content).toContain('the answer is 8');
  });

  test('a tool-call turn with only reasoning keeps its empty content', async () => {
    // An empty content field is NORMAL on a tool turn — the work is in the
    // calls. Promoting reasoning into it there would inject chain-of-thought
    // into the conversation as an assistant answer.
    server = sseServer(['<think>I should list the directory.</think>'], { toolCall: true });
    const response = await providerFor(server).chat({
      messages: [{ role: 'user', content: 'x' }],
      model: 'test-model',
    });

    expect(response.toolCalls.length).toBe(1);
    expect(response.content.trim()).toBe('');
  });
});
