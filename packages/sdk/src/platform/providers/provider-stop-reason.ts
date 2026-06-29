import type { ChatStopReason } from './interface.js';

/**
 * Resolve an 'unknown' stop reason to 'completed' when the model produced text.
 * Providers use this when the stream ended without an explicit finish reason
 * but content was generated.
 */
export function resolveCompletedStopReason(
  stopReason: ChatStopReason,
  content: string | undefined,
): ChatStopReason {
  return stopReason === 'unknown' && content ? 'completed' : stopReason;
}

/**
 * Build the providerStopReason spread for ChatResponse.
 * Returns { providerStopReason } when the raw value is known, otherwise {}.
 */
export function withProviderStopReason(
  rawStopReason: string | undefined,
): { providerStopReason?: string } {
  return rawStopReason !== undefined ? { providerStopReason: rawStopReason } : {};
}
