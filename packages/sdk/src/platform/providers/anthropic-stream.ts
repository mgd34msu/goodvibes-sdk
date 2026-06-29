/**
 * Shared Anthropic streaming helpers.
 *
 * Extracted to avoid duplicating thinking-budget logic across the three
 * Anthropic-family providers (anthropic.ts, anthropic-compat.ts,
 * anthropic-sdk-provider.ts).
 */

import { REASONING_BUDGET_MAP } from './interface.js';

/**
 * Extra output tokens added above the thinking budget to satisfy the
 * Anthropic API invariant: max_tokens > budget_tokens.
 */
export const ANTHROPIC_THINKING_HEADROOM = 4096;

/**
 * Apply Anthropic extended-thinking parameters to a mutable request body.
 *
 * Sets `body.thinking` and adjusts `body.max_tokens` so that:
 *   - `max_tokens > budget_tokens` (Anthropic API requirement), and
 *   - `max_tokens <= modelOutputCap` (avoids over-cap requests).
 *
 * If the budget meets or exceeds the model's output cap, thinking is skipped
 * entirely — it is impossible to satisfy `max_tokens > budget_tokens` within
 * the cap. Pass `Infinity` for compat/SDK providers that have no per-model cap;
 * this preserves the original `budget + HEADROOM` behaviour for those paths.
 *
 * @param body           Mutable request body (mutated in place).
 * @param reasoningEffort Effort label ('low'|'medium'|'high'|'instant') or falsy.
 * @param modelOutputCap  Maximum output tokens the model accepts.
 */
export function applyAnthropicThinking(
  body: Record<string, unknown>,
  reasoningEffort: string | null | undefined,
  modelOutputCap: number,
): void {
  if (!reasoningEffort || reasoningEffort === 'instant') return;
  const budget = REASONING_BUDGET_MAP[reasoningEffort];
  if (typeof budget !== 'number' || budget <= 0) return;
  // Cannot satisfy API invariant max_tokens > budget_tokens within the model cap.
  if (budget >= modelOutputCap) return;
  body['thinking'] = { type: 'enabled', budget_tokens: budget };
  const currentMax = (body['max_tokens'] as number) ?? modelOutputCap;
  if (currentMax <= budget) {
    body['max_tokens'] = Math.min(budget + ANTHROPIC_THINKING_HEADROOM, modelOutputCap);
  }
}
