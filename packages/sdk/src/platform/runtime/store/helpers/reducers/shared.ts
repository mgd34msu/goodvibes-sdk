import type { PartialToolCall } from '../../../../providers/interface.js';
import type { ConversationDomainState } from '../../domains/conversation.js';

export const TERMINAL_LIFECYCLE_STATES = ['completed', 'failed', 'cancelled'] as const;

export function isTerminalLifecycleState(s: string): boolean {
  return (TERMINAL_LIFECYCLE_STATES as readonly string[]).includes(s);
}

export function computeActiveIds<T extends { id: string; status: string }>(map: Map<string, T>): string[] {
  return [...map.values()].filter((v) => !isTerminalLifecycleState(v.status)).map((v) => v.id);
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function now(): number {
  return Date.now();
}

export function updateDomainMetadata<T extends { revision: number; lastUpdatedAt: number; source: string }>(
  domain: T,
  source: string,
): T {
  return {
    ...domain,
    revision: domain.revision + 1,
    lastUpdatedAt: now(),
    source,
  };
}

export function isTerminalTurnState(state: ConversationDomainState['turnState']): boolean {
  return isTerminalLifecycleState(state);
}

export function canStartNewTurn(domain: ConversationDomainState): boolean {
  return domain.turnState === 'idle' || isTerminalTurnState(domain.turnState);
}

export function isCurrentTurnEvent(domain: ConversationDomainState, turnId: string): boolean {
  return domain.currentTurnId !== undefined && domain.currentTurnId === turnId;
}

/**
 * formatPartialToolPreview - The name of the tool call now in flight, or
 * undefined when no tool call has been named yet.
 *
 * This value is a STATUS label: surfaces render it in an ambient "what is
 * happening right now" region (the agent's activity sidebar, the thinking
 * fragment). It is recomputed on every STREAM_DELTA, so it must depend only on
 * facts that are stable across the deltas of a single tool call.
 *
 * A tool call's `arguments` string is NOT such a fact, it arrives a few
 * characters at a time as the provider streams the call's JSON. Including it
 * here made the status region redraw a longer fragment on every delta, which
 * reads as the label flashing through the model's output character by
 * character until the turn ends. Streamed characters belong to the transcript;
 * the status region gets the stable phrase. The tool NAME is delivered whole
 * before its arguments begin, so it holds still for the life of the call, and
 * it is the useful part: it says which tool is running.
 */
export function formatPartialToolPreview(toolCalls?: PartialToolCall[]): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const last = toolCalls[toolCalls.length - 1] as { name?: unknown };
  const name = typeof last.name === 'string' ? last.name.trim() : '';
  if (!name) return undefined;
  return name;
}

export function resetStreamState(): ConversationDomainState['stream'] {
  return {
    accumulated: '',
    reasoningAccumulated: '',
    partialToolPreview: undefined,
    deltaCount: 0,
    firstDeltaAt: undefined,
    lastDeltaAt: undefined,
  };
}
