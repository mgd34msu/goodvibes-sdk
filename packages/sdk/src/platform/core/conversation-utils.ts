import type { ContentPart, ProviderMessage } from '../providers/interface.js';
import type { ConversationMessageSnapshot } from './conversation.js';

type Message = ConversationMessageSnapshot;

export function cloneMessages(messages: Message[]): Message[] {
  return structuredClone(messages);
}

function extractAssistantText(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toInternalMessage(message: ProviderMessage): Message {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: typeof message.content === 'string' ? message.content : (message.content as ContentPart[]),
    };
  }
  if (message.role === 'assistant') {
    // Tool calls ride on the provider message; dropping them leaves every
    // following tool result without the call it answers.
    const calls = message.toolCalls;
    return {
      role: 'assistant',
      content: extractAssistantText(message.content),
      ...(calls && calls.length > 0 ? { toolCalls: structuredClone(calls) } : {}),
    };
  }
  const toolMsg = message as { role: 'tool'; callId: string; content: string | unknown; name?: string };
  return {
    role: 'tool',
    callId: toolMsg.callId ?? '',
    content: typeof toolMsg.content === 'string' ? toolMsg.content : String(toolMsg.content),
    ...(typeof toolMsg.name === 'string' && toolMsg.name.length > 0 ? { toolName: toolMsg.name } : {}),
  };
}

export function messagesToInternal(messages: ProviderMessage[]): Message[] {
  return messages.map(toInternalMessage);
}

function sameCallIds(a: readonly { id: string }[] | undefined, b: readonly { id: string }[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((call, index) => call.id === right[index]!.id);
}

/**
 * Turn the provider messages a compaction keeps back into stored messages,
 * each one whole.
 *
 * A provider message carries only role, text and tool calls, so converting it
 * alone loses what the stored message held besides: the model and provider
 * that wrote it, its reasoning, its usage, a user message's cancelled mark.
 * `llm` is what getMessagesForLLM() returned for `stored` (one provider message
 * per non-system stored message, in order), and compaction keeps those very
 * objects, so a kept message is matched to its source by identity and comes
 * back as a copy of it. A kept assistant message that is a copy rather than the
 * object itself is matched to the next unused stored assistant message with the
 * same text and the same tool-call ids. Anything else (the summary pair a
 * compaction writes itself) is converted, tool calls included.
 */
export function restoreKeptMessages(
  kept: readonly ProviderMessage[],
  llm: readonly ProviderMessage[],
  stored: readonly Message[],
): Message[] {
  const nonSystem: readonly Message[] = stored.filter((message) => message.role !== 'system');
  const sources = new Map<ProviderMessage, Message>();
  if (nonSystem.length === llm.length && llm.every((message, index) => message.role === nonSystem[index]!.role)) {
    llm.forEach((message, index) => sources.set(message, nonSystem[index]!));
  }
  const used = new Set<Message>();
  let cursor = 0;
  return kept.map((message) => {
    let source = sources.get(message);
    if (!source && message.role === 'assistant') {
      const text = extractAssistantText(message.content);
      for (let index = cursor; index < nonSystem.length; index++) {
        const candidate = nonSystem[index]!;
        if (candidate.role === 'assistant' && !used.has(candidate) && candidate.content === text
          && sameCallIds(candidate.toolCalls, message.toolCalls)) {
          source = candidate;
          break;
        }
      }
    }
    if (!source || used.has(source)) return toInternalMessage(message);
    used.add(source);
    cursor = Math.max(cursor, nonSystem.indexOf(source) + 1);
    return structuredClone(source);
  });
}

export function cloneBranchMap(branches: Map<string, Message[]>): Record<string, Message[]> {
  const result: Record<string, Message[]> = {};
  for (const [name, msgs] of branches) {
    result[name] = cloneMessages(msgs);
  }
  return result;
}

export function restoreBranchMap(branches?: Record<string, Message[]>): Map<string, Message[]> {
  const restored = new Map<string, Message[]>();
  if (!branches) return restored;
  for (const [name, msgs] of Object.entries(branches)) {
    restored.set(name, cloneMessages(msgs));
  }
  return restored;
}

export function deriveConversationTitle(content: string): string {
  const text = content.trim();
  if (text.length <= 50) return text;
  let cut = text.lastIndexOf(' ', 50);
  if (cut <= 0) cut = 50;
  return text.slice(0, cut);
}

export function extractUserDisplayText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  const textParts = content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
  const imageCount = content.filter((part) => part.type === 'image').length;
  return textParts.map((part) => part.text).join('') + (imageCount > 0 ? ` [+${imageCount} image(s)]` : '');
}
