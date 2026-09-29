/**
 * A follow-up acknowledgement is billed, but it is not the session's context.
 *
 * The follow-up runtime asks the model for a short acknowledgement with the
 * conversation and no tool definitions. In the live run that request reported
 * 1,796 input tokens while the session's real turn requests were 13.3k and
 * 31.1k, and the context meter showed 1.8k. These tests pin that the
 * acknowledgement is marked on the message, that the orchestrator's usage hook
 * receives it for the totals only, and that sumConversationUsage (the resume
 * path) skips it for the context size.
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../packages/sdk/src/platform/core/conversation.ts';
import { OrchestratorFollowUpRuntime } from '../packages/sdk/src/platform/core/orchestrator-follow-up-runtime.ts';
import { sumConversationUsage } from '../packages/sdk/src/platform/core/orchestrator-usage.ts';
import type { ConversationMessageSnapshot } from '../packages/sdk/src/platform/core/conversation.ts';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('follow-up acknowledgement usage', () => {
  test('the acknowledgement message is marked followUp and its usage goes to the totals hook', async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage('spawn a reviewer and do not wait');
    conversation.addAssistantMessage('Started.', { usage: { inputTokens: 13292, outputTokens: 139 } });
    const applied: Array<{ inputTokens: number }> = [];
    const model = { id: 'route-llm', registryKey: 'abacusai:route-llm', provider: 'abacusai', displayName: 'route-llm', capabilities: { reasoning: false } };
    const runtime = new OrchestratorFollowUpRuntime({
      conversation,
      getViewportHeight: () => 20,
      scrollToEnd: () => {},
      getSystemPrompt: () => 'system',
      requestRender: () => {},
      getThinkingState: () => ({ isThinking: false, isCompacting: false }),
      getQueuedUserMessageCount: () => 0,
      getProviderRegistry: () => ({
        getForModel: () => ({
          chat: async () => ({ content: 'The reviewer finished.', usage: { inputTokens: 1796, outputTokens: 24 } }),
        }),
        getTokenLimitsForModel: () => ({ maxOutputTokens: 4096 }),
      }) as never,
      getCurrentModel: () => model as never,
      routeLowPriorityMessage: () => {},
      applyUsage: (usage) => { applied.push(usage); },
    });
    runtime.enqueue({ key: 'agent:1:done', summary: 'reviewer finished' });
    await flush();
    await flush();

    const last = conversation.getMessageSnapshot().at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.role === 'assistant' && last.followUp).toBe(true);
    expect(applied.map((u) => u.inputTokens)).toEqual([1796]);
    // The marker never reaches the provider payload.
    expect(JSON.stringify(conversation.getMessagesForLLM())).not.toContain('followUp');
  });

  test('sumConversationUsage takes the context size from the latest real turn, not an acknowledgement', () => {
    const messages: ConversationMessageSnapshot[] = [
      { role: 'user', content: 'spawn' },
      { role: 'assistant', content: '', usage: { inputTokens: 13292, outputTokens: 139 } },
      { role: 'assistant', content: 'Started.', usage: { inputTokens: 1710, outputTokens: 29 }, followUp: true },
      { role: 'assistant', content: 'Done.', usage: { inputTokens: 1796, outputTokens: 24 }, followUp: true },
    ];
    const { usage, lastInputTokens } = sumConversationUsage(messages);
    expect(lastInputTokens).toBe(13292);
    expect(usage.input).toBe(13292 + 1710 + 1796);
    expect(usage.output).toBe(139 + 29 + 24);
  });

  test('a real turn after acknowledgements sets the context size, cache reads included', () => {
    const messages: ConversationMessageSnapshot[] = [
      { role: 'assistant', content: 'Done.', usage: { inputTokens: 1796, outputTokens: 24 }, followUp: true },
      { role: 'assistant', content: 'Started the loop.', usage: { inputTokens: 0, outputTokens: 39, cacheReadTokens: 31107 } },
    ];
    expect(sumConversationUsage(messages).lastInputTokens).toBe(31107);
  });
});
