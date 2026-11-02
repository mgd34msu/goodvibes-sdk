import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.ts';
import type { ProviderMessage } from '../packages/sdk/src/platform/providers/interface.ts';

describe('provider conversation during streaming', () => {
  test('excludes the active rendering block before and during generation', () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('Hello');
    const expected: ProviderMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(conversation.getMessagesForLLM()).toEqual(expected);

    conversation.startStreamingBlock();
    expect(conversation.getMessageSnapshot().at(-1)).toEqual({ role: 'assistant', content: '' });
    expect(conversation.getMessagesForLLM()).toEqual(expected);

    conversation.updateStreamingBlock('Partial answer');
    expect(conversation.getMessageSnapshot().at(-1)).toEqual({ role: 'assistant', content: 'Partial answer' });
    expect(conversation.getMessagesForLLM()).toEqual(expected);

    conversation.finalizeStreamingBlock();
    conversation.addAssistantMessage('Final answer');
    expect(conversation.getMessagesForLLM()).toEqual([
      ...expected,
      { role: 'assistant', content: 'Final answer' },
    ]);
  });

  test('keeps completed tool calls and their results while excluding only the active block', () => {
    const conversation = new ConversationManager();
    const toolCalls = [{ id: 'call-1', name: 'get_weather', arguments: { city: 'Paris' } }];
    conversation.addUserMessage('Weather in Paris?');
    conversation.addAssistantMessage('', { toolCalls });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: 'Sunny' }]);
    conversation.startStreamingBlock();
    // Hooks can append messages after the rendering block has been created.
    conversation.addSystemMessage('Runtime notice');

    expect(conversation.getMessagesForLLM()).toEqual([
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', content: '', toolCalls },
      { role: 'tool', callId: 'call-1', name: 'get_weather', content: 'Sunny' },
    ]);
  });
});
