/**
 * The status label a surface renders while a turn is running must hold still.
 *
 * `conversation.stream.partialToolPreview` is the field behind the agent's
 * activity-sidebar "Now" row and the thinking fragment's preview. It is
 * recomputed on EVERY `STREAM_DELTA`, so anything it derives from must be
 * stable across the deltas of one tool call.
 *
 * It used to include the tool call's `arguments` string, which a provider
 * streams a few characters at a time. The status region therefore redrew a
 * slightly longer fragment on every delta, the label flashed through the
 * model's output character by character until the turn finished. These tests
 * pin the rule that replaced it: streamed characters belong to the transcript,
 * and the status label depends only on the tool name.
 */
import { describe, expect, test } from 'bun:test';
import { createInitialConversationState } from '../packages/sdk/src/platform/runtime/store/domains/conversation.ts';
import { updateConversationState } from '../packages/sdk/src/platform/runtime/store/helpers/reducers/conversation.ts';
import { formatPartialToolPreview } from '../packages/sdk/src/platform/runtime/store/helpers/reducers/shared.ts';
import type { ConversationDomainState } from '../packages/sdk/src/platform/runtime/store/domains/conversation.ts';

const TURN_ID = 'turn-1';

/** Drive a domain up to the point where STREAM_DELTA is accepted. */
function streamingDomain(): ConversationDomainState {
  let domain = createInitialConversationState();
  domain = updateConversationState(domain, { type: 'TURN_SUBMITTED', turnId: TURN_ID, prompt: 'hi' });
  domain = updateConversationState(domain, { type: 'PREFLIGHT_OK', turnId: TURN_ID });
  domain = updateConversationState(domain, { type: 'STREAM_START', turnId: TURN_ID });
  expect(domain.turnState).toBe('streaming');
  return domain;
}

/**
 * The way a provider actually delivers a tool call: the name arrives whole in
 * the first chunk, then the JSON arguments grow a couple of characters at a
 * time.
 */
function deltasForStreamedToolCall(name: string, args: string) {
  const chunks: string[] = [];
  for (let i = 0; i < args.length; i += 2) chunks.push(args.slice(0, i + 2));
  return chunks.map((partialArgs, index) => ({
    type: 'STREAM_DELTA' as const,
    turnId: TURN_ID,
    content: '',
    accumulated: '',
    toolCalls: [{ index: 0, id: 'call-1', name, arguments: partialArgs }],
    // retained so the test reads like the stream it models
    _deltaOrdinal: index,
  }));
}

describe('streaming status label is delta-count-independent', () => {
  test('the label is identical after every delta of a streamed tool call', () => {
    let domain = streamingDomain();
    const deltas = deltasForStreamedToolCall(
      'read_file',
      JSON.stringify({ path: '/home/someone/projects/thing/src/very/long/path/file.ts', offset: 0, limit: 2000 }),
    );
    // A real stream, not a token or two: this is where the flashing was visible.
    expect(deltas.length).toBeGreaterThan(20);

    const labels: (string | undefined)[] = [];
    for (const delta of deltas) {
      const { _deltaOrdinal, ...event } = delta;
      domain = updateConversationState(domain, event);
      labels.push(domain.stream.partialToolPreview);
    }

    expect(domain.stream.deltaCount).toBe(deltas.length);
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe('read_file');
  });

  test('the label does not grow as more of the arguments arrive', () => {
    let domain = streamingDomain();
    const deltas = deltasForStreamedToolCall('write_file', JSON.stringify({ contents: 'x'.repeat(400) }));

    const lengths = new Set<number>();
    for (const delta of deltas) {
      const { _deltaOrdinal, ...event } = delta;
      domain = updateConversationState(domain, event);
      lengths.add((domain.stream.partialToolPreview ?? '').length);
    }

    // One length, for every delta: the label is not a growing character stream.
    expect(lengths.size).toBe(1);
    expect(domain.stream.partialToolPreview).toBe('write_file');
  });

  test('no fragment of the streamed arguments ever reaches the label', () => {
    let domain = streamingDomain();
    const secretish = 'ARGUMENT-TEXT-THAT-BELONGS-IN-THE-TRANSCRIPT';
    const deltas = deltasForStreamedToolCall('run_command', JSON.stringify({ command: secretish }));

    for (const delta of deltas) {
      const { _deltaOrdinal, ...event } = delta;
      domain = updateConversationState(domain, event);
      const label = domain.stream.partialToolPreview ?? '';
      expect(label).toBe('run_command');
      // Not even the first two characters of the arguments leak in.
      expect(label).not.toContain(secretish.slice(0, 2));
      expect(label).not.toContain('(');
    }
  });

  test('two deltas that differ only in argument length produce the same label', () => {
    const early = formatPartialToolPreview([{ index: 0, name: 'search', arguments: '{"q":"a' }]);
    const late = formatPartialToolPreview([{ index: 0, name: 'search', arguments: '{"q":"abcdefghijklmnop"}' }]);
    expect(early).toBe(late);
    expect(early).toBe('search');
  });

  test('a genuinely new tool call does change the label', () => {
    let domain = streamingDomain();
    domain = updateConversationState(domain, {
      type: 'STREAM_DELTA', turnId: TURN_ID, content: '', accumulated: '',
      toolCalls: [{ index: 0, id: 'a', name: 'read_file', arguments: '{' }],
    });
    expect(domain.stream.partialToolPreview).toBe('read_file');

    domain = updateConversationState(domain, {
      type: 'STREAM_DELTA', turnId: TURN_ID, content: '', accumulated: '',
      toolCalls: [
        { index: 0, id: 'a', name: 'read_file', arguments: '{}' },
        { index: 1, id: 'b', name: 'write_file', arguments: '{' },
      ],
    });
    // Moving on to a different tool is real news, and the label says so.
    expect(domain.stream.partialToolPreview).toBe('write_file');
  });

  test('an unnamed tool call leaves the label unset rather than showing bare punctuation', () => {
    expect(formatPartialToolPreview([{ index: 0, arguments: '{"path":"/tmp' }])).toBeUndefined();
    expect(formatPartialToolPreview([{ index: 0, name: '   ', arguments: '{}' }])).toBeUndefined();
    expect(formatPartialToolPreview([])).toBeUndefined();
    expect(formatPartialToolPreview(undefined)).toBeUndefined();
  });

  test('text-only deltas never set a status label', () => {
    let domain = streamingDomain();
    for (const word of ['Here ', 'is ', 'a ', 'long ', 'answer.']) {
      domain = updateConversationState(domain, {
        type: 'STREAM_DELTA', turnId: TURN_ID, content: word, accumulated: word,
      });
      expect(domain.stream.partialToolPreview).toBeUndefined();
    }
  });
});
