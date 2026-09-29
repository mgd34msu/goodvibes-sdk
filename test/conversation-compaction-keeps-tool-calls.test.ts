import { describe, expect, test } from 'bun:test';
import { ConversationManager, type ConversationMessageSnapshot } from '../packages/sdk/src/platform/core/conversation.ts';
import { messagesToInternal, restoreKeptMessages } from '../packages/sdk/src/platform/core/conversation-utils.ts';
import { compactSmallWindow } from '../packages/sdk/src/platform/core/context-compaction.ts';
import type { ProviderMessage } from '../packages/sdk/src/platform/providers/interface.ts';

// The defect this pins: replaceMessagesForLLM rebuilt the kept messages from
// provider messages with role and text only, so a compaction stripped every
// kept assistant message of its tool calls, model and reasoning. The next
// request then carried tool results with no call before them, and a transcript
// lost the call names. Every consumer compacts through this method (the main
// session, spawned agents, companion chat), so it is fixed here.

const USAGE = { inputTokens: 900, outputTokens: 120 };

function conversationWithTurns(): ConversationManager {
  const cm = new ConversationManager();
  for (let k = 0; k < 3; k++) {
    cm.addUserMessage(`question ${k}`);
    cm.addAssistantMessage('', {
      toolCalls: [{ id: `r${k}`, name: 'read', arguments: { path: `src/f${k}.ts` } }],
      model: 'route-llm',
      provider: 'abacus',
      reasoningContent: `thinking ${k}`,
      reasoningSummary: `summary ${k}`,
      usage: USAGE,
    });
    cm.addToolResults([{ callId: `r${k}`, success: true, output: `line ${k}` }]);
    cm.addAssistantMessage(`answer ${k}`, { model: 'route-llm', provider: 'abacus', usage: USAGE });
  }
  return cm;
}

function assistants(messages: ConversationMessageSnapshot[]) {
  return messages.flatMap((m) => (m.role === 'assistant' ? [m] : []));
}

function callsPairWithResults(messages: readonly ProviderMessage[]): boolean {
  const calls = new Set(messages.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  return messages.every((m) => m.role !== 'tool' || calls.has(m.callId));
}

describe('compaction keeps kept messages whole', () => {
  test('small-window keep-last-N keeps tool calls, model, provider, reasoning and usage', () => {
    const cm = conversationWithTurns();
    const before = cm.getMessageSnapshot();
    cm.replaceMessagesForLLM(compactSmallWindow(cm.getMessagesForLLM(), 4));
    const after = cm.getMessageSnapshot();
    // summary pair + the last 4 stored messages, byte for byte.
    expect(after).toHaveLength(6);
    expect(after.slice(2)).toEqual(before.slice(-4));
    const withCall = assistants(after).find((m) => (m.toolCalls?.length ?? 0) > 0);
    expect(withCall?.toolCalls?.[0]).toEqual({ id: 'r2', name: 'read', arguments: { path: 'src/f2.ts' } });
    expect(withCall?.model).toBe('route-llm');
    expect(withCall?.provider).toBe('abacus');
    expect(withCall?.reasoningContent).toBe('thinking 2');
    expect(withCall?.reasoningSummary).toBe('summary 2');
    expect(withCall?.usage).toEqual(USAGE);
  });

  test('the next request pairs every kept tool result with its call', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    const next = cm.getMessagesForLLM();
    expect(next.some((m) => m.role === 'tool')).toBe(true);
    expect(callsPairWithResults(next)).toBe(true);
  });

  test('a kept message is a copy: later edits to the old array do not reach the store', () => {
    const cm = conversationWithTurns();
    const kept = cm.getMessagesForLLM().slice(-4);
    cm.replaceMessagesForLLM(kept);
    const stored = assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls);
    (kept.find((m) => m.role === 'assistant' && m.toolCalls) as { toolCalls: { name: string }[] }).toolCalls[0]!.name = 'mutated';
    expect(assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls)?.toolCalls?.[0]?.name).toBe(stored?.toolCalls?.[0]?.name);
  });

  test('provider messages a compaction wrote itself keep their tool calls', () => {
    const cm = conversationWithTurns();
    cm.replaceMessagesForLLM([
      { role: 'user', content: 'summary' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'read', arguments: { path: 'z.ts' } }] },
      { role: 'tool', callId: 'x1', content: 'a\nb\n', name: 'read' },
    ]);
    const after = cm.getMessageSnapshot();
    expect(assistants(after)[0]?.toolCalls).toEqual([{ id: 'x1', name: 'read', arguments: { path: 'z.ts' } }]);
    expect(after[2]).toEqual({ role: 'tool', callId: 'x1', content: 'a\nb\n', toolName: 'read' });
    expect(callsPairWithResults(cm.getMessagesForLLM())).toBe(true);
  });

  test('a copied (not identical) kept assistant message is matched to its source by text and call ids', () => {
    const cm = conversationWithTurns();
    const copies = structuredClone(cm.getMessagesForLLM().slice(-4));
    cm.replaceMessagesForLLM(copies);
    const withCall = assistants(cm.getMessageSnapshot()).find((m) => m.toolCalls);
    expect(withCall?.model).toBe('route-llm');
    expect(withCall?.reasoningContent).toBe('thinking 2');
    expect(assistants(cm.getMessageSnapshot()).at(-1)?.content).toBe('answer 2');
  });

  test('system messages stay at the front and the title survives', () => {
    const cm = conversationWithTurns();
    cm.title = 'Fix retry backoff';
    cm.addSystemMessage('note');
    cm.replaceMessagesForLLM(cm.getMessagesForLLM().slice(-4));
    expect(cm.title).toBe('Fix retry backoff');
    const after = cm.getMessageSnapshot();
    expect(after[0]).toEqual({ role: 'system', content: 'note' });
    expect(after.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  test('messagesToInternal keeps an assistant message\'s tool calls', () => {
    const [assistant] = messagesToInternal([
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'exec', arguments: { cmd: 'ls' } }] },
    ]);
    expect(assistant).toEqual({ role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', name: 'exec', arguments: { cmd: 'ls' } }] });
    expect(messagesToInternal([{ role: 'assistant', content: 'y' }])[0]).toEqual({ role: 'assistant', content: 'y' });
  });

  test('restoreKeptMessages converts when the provider list does not line up with the store', () => {
    const stored: ConversationMessageSnapshot[] = [{ role: 'user', content: 'a' }];
    const kept: ProviderMessage[] = [{ role: 'tool', callId: 'c', content: 'out' }];
    expect(restoreKeptMessages(kept, [], stored)).toEqual([{ role: 'tool', callId: 'c', content: 'out' }]);
  });
});
