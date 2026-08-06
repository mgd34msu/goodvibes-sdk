import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.ts';

// The defect this pins: the recovery journal recorded the SAME final assistant
// message for one turn twice — same content, same usage. Cause: a hosted
// conversation opens a fresh event stream per turn and never sends
// Last-Event-ID, so the gateway's catch-up replay re-sends the previous turn's
// TURN_COMPLETED into the next turn's renderer, which appends it again.

const USAGE = { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 800, cacheWriteTokens: 0 };

function assistantMessages(manager: ConversationManager): Array<{ content: string }> {
  return manager.getMessageSnapshot().filter((message) => message.role === 'assistant') as Array<{ content: string }>;
}

describe('assistant message store boundary — re-delivery', () => {
  test('the same message replayed with the same usage lands exactly once', () => {
    const manager = new ConversationManager();
    manager.addUserMessage('what time should i leave for my trip?');
    manager.addAssistantMessage('Leave by 5:15 AM.', { usage: USAGE, model: 'm', provider: 'p' });
    // The replayed frame: byte-identical content, byte-identical usage.
    manager.addAssistantMessage('Leave by 5:15 AM.', { usage: USAGE, model: 'm', provider: 'p' });

    expect(assistantMessages(manager)).toHaveLength(1);
  });

  test('the dropped duplicate does not grow the store', () => {
    const manager = new ConversationManager();
    manager.addAssistantMessage('Done.', { usage: USAGE });
    const count = manager.getMessageCount();
    manager.addAssistantMessage('Done.', { usage: USAGE });
    // A message that never landed must not look like a change to anything
    // reading the store.
    expect(manager.getMessageCount()).toBe(count);
  });

  test('an honest repeat in a LATER turn still lands', () => {
    const manager = new ConversationManager();
    manager.addUserMessage('ping');
    manager.addAssistantMessage('Done.', { usage: USAGE });
    // The user prompted again — the same words are a real second answer, and
    // the user message between them is what makes that unambiguous.
    manager.addUserMessage('ping');
    manager.addAssistantMessage('Done.', { usage: USAGE });

    expect(assistantMessages(manager)).toHaveLength(2);
  });

  test('identical text billed DIFFERENT tokens is a real second call, not a replay', () => {
    const manager = new ConversationManager();
    manager.addAssistantMessage('Done.', { usage: USAGE });
    manager.addAssistantMessage('Done.', { usage: { ...USAGE, outputTokens: 351 } });

    expect(assistantMessages(manager)).toHaveLength(2);
  });

  test('a tool result between two identical messages keeps them both', () => {
    const manager = new ConversationManager();
    manager.addAssistantMessage('Checking.', { usage: USAGE });
    manager.addToolResults([{ callId: 'call-1', success: true, output: 'result' }]);
    manager.addAssistantMessage('Checking.', { usage: USAGE });

    expect(assistantMessages(manager)).toHaveLength(2);
  });

  test('differing tool calls are not a duplicate even with identical text and usage', () => {
    const manager = new ConversationManager();
    manager.addAssistantMessage('Running it.', {
      usage: USAGE,
      toolCalls: [{ id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
    });
    manager.addAssistantMessage('Running it.', {
      usage: USAGE,
      toolCalls: [{ id: 'call-2', name: 'bash', arguments: { command: 'pwd' } }],
    });

    expect(assistantMessages(manager)).toHaveLength(2);
  });

  test('a replayed message carrying identical tool calls is still suppressed', () => {
    const manager = new ConversationManager();
    const toolCalls = [{ id: 'call-1', name: 'bash', arguments: { command: 'ls' } }];
    manager.addAssistantMessage('Running it.', { usage: USAGE, toolCalls });
    manager.addAssistantMessage('Running it.', { usage: USAGE, toolCalls: [...toolCalls] });

    expect(assistantMessages(manager)).toHaveLength(1);
  });

  test('the guard covers what the durable writers serialize', () => {
    // Every durable writer (recovery snapshot, session store, transcript
    // journal) serializes this array, so one guard here covers all of them.
    const manager = new ConversationManager();
    manager.addUserMessage('go');
    manager.addAssistantMessage('Answer.', { usage: USAGE });
    manager.addAssistantMessage('Answer.', { usage: USAGE });

    const snapshot = manager.getMessageSnapshot();
    expect(snapshot.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });
});
