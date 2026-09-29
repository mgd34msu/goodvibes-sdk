/**
 * orchestrator-usage.ts, the running token totals, as a name.
 *
 * `Orchestrator.usage` was an inferred object literal on the class, so a caller
 * that folds these across conversations, and has to declare the accumulator's
 * type to do it, could reach the shape and not the name. A surface doing
 * exactly that wrote the four fields out again locally.
 *
 * It lives beside the class rather than in it because the class is at its
 * line ceiling, and because a type callers name is not orchestration logic.
 */

import type { ConversationMessageSnapshot } from './conversation.js';

/** The running token totals an Orchestrator accumulates over a conversation. */
export interface OrchestratorUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Fold a transcript's assistant usage into running totals, plus the context
 * size the latest real turn request reported (input + cache read + cache
 * write). A resumed session hydrates its counters from this. Follow-up
 * acknowledgements (`followUp`) count toward the totals but never toward the
 * context size: that request leaves out the tool definitions, so its input is
 * smaller than what the session's next turn will send.
 */
export function sumConversationUsage(
  messages: readonly ConversationMessageSnapshot[],
): { usage: OrchestratorUsageTotals; lastInputTokens: number } {
  const usage: OrchestratorUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastInputTokens = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    usage.input += message.usage.inputTokens;
    usage.output += message.usage.outputTokens;
    usage.cacheRead += message.usage.cacheReadTokens ?? 0;
    usage.cacheWrite += message.usage.cacheWriteTokens ?? 0;
    if (message.followUp) continue;
    lastInputTokens = message.usage.inputTokens
      + (message.usage.cacheReadTokens ?? 0)
      + (message.usage.cacheWriteTokens ?? 0);
  }
  return { usage, lastInputTokens };
}
