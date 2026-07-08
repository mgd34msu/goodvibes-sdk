/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { ChatResponse } from '../providers/interface.js';
import { isContextOverflowSignal } from '../providers/stop-reason-maps.js';
import { compactSmallWindow } from '../core/context-compaction.js';
import type { ProviderMessage } from '../providers/interface.js';
import { logger } from '../utils/logger.js';

/**
 * Compact an agent conversation when the model/provider itself reported
 * context exhaustion on a successful response (see isContextOverflowSignal).
 * The provider's report is authoritative over local estimates, so this runs
 * immediately — the same structural compaction as the runner's
 * prompt-too-long emergency path — before any further chat call.
 * Returns true when compaction ran.
 */
export function maybeCompactAfterModelContextWarning(opts: {
  response: Pick<ChatResponse, 'stopReason' | 'providerStopReason'>;
  conversation: {
    getMessagesForLLM(): ProviderMessage[];
    replaceMessagesForLLM(messages: ProviderMessage[]): void;
  };
  record: { id: string; progress?: string | undefined };
  turn: number;
  contextWindowAwarenessEnabled: boolean;
  emitProgress: (progress: string) => void;
}): boolean {
  const { response, conversation, record, turn } = opts;
  if (!opts.contextWindowAwarenessEnabled) return false;
  if (!isContextOverflowSignal(response.stopReason, response.providerStopReason)) return false;
  logger.warn(
    `[AgentOrchestrator] model reported context window exhaustion on turn ${turn} - compacting immediately`,
    { agentId: record.id, providerStopReason: response.providerStopReason },
  );
  record.progress = `Turn ${turn} · Model reported full context, compacting…`;
  opts.emitProgress(record.progress);
  const messages = conversation.getMessagesForLLM();
  conversation.replaceMessagesForLLM(
    compactSmallWindow(messages, Math.max(5, Math.floor(messages.length / 3))),
  );
  return true;
}

/**
 * Summarize tool call arguments into a brief display string for progress labels.
 * Extracts the most informative single string arg (path, cmd, etc.) and
 * truncates to 30 characters.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  // Extract the most informative single arg
  for (const key of ['path', 'file', 'cmd', 'pattern', 'url', 'query']) {
    const val = args[key]!;
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  // Otherwise use the first string value found.
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) {
      const trimmed = val.length > 30 ? val.slice(0, 27) + '\u2026' : val;
      return ` \u2014 ${trimmed}`;
    }
  }
  return '';
}
