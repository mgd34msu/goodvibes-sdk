/**
 * Reasoning that a provider bakes into the assistant message.
 *
 * A cerebras reply put reasoning text into an ntfy body even though that
 * surface's policy is `reasoningVisibility: 'suppress'`. The suppression was
 * never at fault: the reasoning did not arrive on the reasoning channel at
 * all. Cerebras (like other OpenAI-compatible endpoints serving qwen-3 /
 * gpt-oss) wraps chain-of-thought in a tag inside `content`, so downstream it
 * is indistinguishable from the answer — it reaches the transcript, the
 * session export and every channel body as `assistant_text`.
 *
 * The split belongs at the provider boundary, where the wire format is already
 * this layer's business (openai-stream-delta.ts already routes the STRUCTURED
 * reasoning fields). Done once there, every consumer receives the same correct
 * content/reasoning split and each one's visibility policy governs it. A
 * filter at a single render site would fix that site and leave the raw tag
 * everywhere else.
 *
 * `buildRenderedText` keeps a backstop for provider paths not yet taught the
 * wire format — one place for all channel surfaces, not per surface.
 */
import { describe, expect, test } from 'bun:test';
import {
  InlineReasoningStreamSplitter,
  splitInlineReasoning,
} from '../packages/sdk/src/platform/providers/inline-reasoning.ts';
import { buildRenderedText } from '../packages/sdk/src/platform/channels/reply-render.ts';
import type { ChannelRenderPolicy } from '../packages/sdk/src/platform/channels/types.ts';

function policy(overrides: Partial<ChannelRenderPolicy>): ChannelRenderPolicy {
  return {
    surface: 'ntfy',
    reasoningVisibility: 'suppress',
    format: 'plain',
    supportsThreads: false,
    maxChunkChars: 1_600,
    maxEventsPerUpdate: 6,
    metadata: {},
    ...overrides,
  } as ChannelRenderPolicy;
}

describe('splitInlineReasoning on a complete message', () => {
  test('separates a think block from the answer', () => {
    const split = splitInlineReasoning('<think>The user wants 5+3. That is 8.</think>The answer is 8.');
    expect(split.content).toBe('The answer is 8.');
    expect(split.reasoning).toBe('The user wants 5+3. That is 8.');
  });

  test('handles a block that appears after the answer', () => {
    const split = splitInlineReasoning('Here it is.\n<thinking>double-checked</thinking>');
    expect(split.content).toBe('Here it is.');
    expect(split.reasoning).toBe('double-checked');
  });

  test('handles several blocks', () => {
    const split = splitInlineReasoning('<think>one</think>A<reasoning>two</reasoning>B');
    expect(split.content).toBe('AB');
    expect(split.reasoning).toBe('one\ntwo');
  });

  test('an unterminated block takes the rest as reasoning, leaving no dangling tag', () => {
    const split = splitInlineReasoning('Partial answer.<think>cut off mid-thought');
    expect(split.content).toBe('Partial answer.');
    expect(split.reasoning).toBe('cut off mid-thought');
    expect(split.content).not.toContain('<think');
  });

  test('text with no reasoning tag is returned untouched', () => {
    const answer = 'The build is green and the tag is pushed.';
    expect(splitInlineReasoning(answer)).toEqual({ content: answer, reasoning: '' });
  });

  test('unrelated angle brackets are not mistaken for a tag', () => {
    const answer = 'Use `a < b` and `<div>` in the template.';
    expect(splitInlineReasoning(answer).content).toBe(answer);
    expect(splitInlineReasoning(answer).reasoning).toBe('');
  });
});

describe('InlineReasoningStreamSplitter across chunk boundaries', () => {
  /** Feed a message in fixed-size pieces, as a stream would. */
  function stream(text: string, chunkSize: number): { content: string; reasoning: string } {
    const splitter = new InlineReasoningStreamSplitter();
    let content = '';
    let reasoning = '';
    for (let i = 0; i < text.length; i += chunkSize) {
      const out = splitter.push(text.slice(i, i + chunkSize));
      content += out.content;
      reasoning += out.reasoning;
    }
    const tail = splitter.flush();
    return { content: content + tail.content, reasoning: reasoning + tail.reasoning };
  }

  const message = '<think>5 plus 3 is 8, and the user asked for arithmetic.</think>The answer is 8.';

  test.each([1, 2, 3, 5, 7, 13, 64])('a tag split across %s-char chunks is still recognized', (size) => {
    const out = stream(message, size);
    expect(out.content).toBe('The answer is 8.');
    expect(out.reasoning).toBe('5 plus 3 is 8, and the user asked for arithmetic.');
  });

  test('no partial tag is ever emitted as content', () => {
    const splitter = new InlineReasoningStreamSplitter();
    const first = splitter.push('Answer<thi');
    expect(first.content).toBe('Answer');
    expect(first.content).not.toContain('<thi');
    const second = splitter.push('nk>hidden</think>done');
    expect(second.content).toBe('done');
    expect(second.reasoning).toBe('hidden');
  });

  test('a held-back fragment that turns out to be ordinary text is released', () => {
    const splitter = new InlineReasoningStreamSplitter();
    // Everything from the last '<' is held back until the next chunk can rule
    // out a tag; flush releases it verbatim, so no character is ever lost.
    const pushed = splitter.push('a < b');
    const flushed = splitter.flush();
    expect(pushed.content + flushed.content).toBe('a < b');
    expect(flushed.reasoning).toBe('');
  });

  test('the whole message with no tags streams through unchanged', () => {
    const answer = 'The build is green. Nothing to report.';
    expect(stream(answer, 4)).toEqual({ content: answer, reasoning: '' });
  });

  test('an unterminated tag at end of stream flushes as reasoning', () => {
    const out = stream('Answer.<think>truncated', 3);
    expect(out.content).toBe('Answer.');
    expect(out.reasoning).toBe('truncated');
  });
});

describe('the channel backstop honours reasoningVisibility on assistant text', () => {
  const leaked = '<think>The user asked 5+3. I should just say 8.</think>The answer is 8.';

  test('a suppressed surface receives the answer without the reasoning', () => {
    const body = buildRenderedText(leaked, [], policy({ reasoningVisibility: 'suppress' }), 'final');
    expect(body).toBe('The answer is 8.');
    expect(body).not.toContain('I should just say 8');
  });

  test('a summary surface also drops the block when there is an answer beside it', () => {
    const body = buildRenderedText(leaked, [], policy({ surface: 'slack', reasoningVisibility: 'summary' }), 'final');
    expect(body).toBe('The answer is 8.');
  });

  test('a public surface keeps what the model sent', () => {
    const body = buildRenderedText(leaked, [], policy({ surface: 'tui', reasoningVisibility: 'public' }), 'final');
    expect(body).toContain('<think>');
  });

  test('a message that is ONLY reasoning still sends something on a summary surface', () => {
    const body = buildRenderedText(
      '<think>still working through it</think>',
      [],
      policy({ surface: 'slack', reasoningVisibility: 'summary' }),
      'final',
    );
    expect(body).toContain('still working through it');
  });

  test('a message that is ONLY reasoning does not reach a suppressed surface as the answer', () => {
    const body = buildRenderedText(
      '<think>still working through it</think>',
      [{ id: 'e1', kind: 'status', phase: 'final', ts: 1, text: 'Completed', metadata: {} }],
      policy({ reasoningVisibility: 'suppress' }),
      'final',
    );
    expect(body).not.toContain('still working through it');
    // It falls through to the terminal status rather than sending nothing.
    expect(body).toBe('Completed');
  });

  test('an ordinary answer is unaffected on every visibility', () => {
    const answer = 'The build is green and the tag is pushed.';
    for (const visibility of ['suppress', 'summary', 'public', 'private'] as const) {
      expect(buildRenderedText(answer, [], policy({ reasoningVisibility: visibility }), 'final')).toBe(answer);
    }
  });
});
