/**
 * Shared Anthropic reasoning helpers.
 *
 * Extracted to avoid duplicating the effort-versus-budget decision across the
 * Anthropic-family providers (anthropic.ts, anthropic-compat.ts,
 * anthropic-sdk-provider.ts, and, by inheritance, amazon-bedrock.ts,
 * amazon-bedrock-mantle.ts and anthropic-vertex.ts).
 *
 * Which field a model takes is not a stylistic choice. Anthropic's own
 * extended-thinking documentation states that extended thinking
 * (`thinking.type: 'enabled'` with `budget_tokens`) "is deprecated on the
 * Claude 4.6 models (requests using it still succeed). Claude 4.7 and later
 * models do not support it and reject requests that use it, returning a 400
 * error." Current models take `output_config.effort` instead. Sending the
 * wrong one is a failed turn, so the resolved spec decides.
 */

import type { ChatRequest } from './interface.js';
import { budgetTokensForLevel, type ResolvedReasoningEffort } from './reasoning-effort.js';
import { resolveEffortForRequest } from './reasoning-effort-families.js';

/**
 * Extra output tokens added above the thinking budget to satisfy the
 * Anthropic API invariant: max_tokens > budget_tokens.
 */
export const ANTHROPIC_THINKING_HEADROOM = 4096;

/**
 * Whether a built `thinking` field actually turned extended thinking on.
 * `{ type: 'disabled' }` is also a `thinking` field, and it must not pull in
 * the interleaved-thinking beta header.
 */
export function isAnthropicThinkingEnabled(thinking: unknown): boolean {
  return typeof thinking === 'object'
    && thinking !== null
    && (thinking as { type?: unknown }).type === 'enabled';
}

/** Levels Anthropic's `output_config.effort` field accepts. */
const ANTHROPIC_EFFORT_VALUES = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The reasoning fields of a chat request, the only part these helpers read. */
export type AnthropicReasoningParams = Pick<
  ChatRequest,
  'model' | 'reasoningEffort' | 'reasoningEffortSpec'
>;

/**
 * Apply Anthropic extended-thinking parameters to a mutable request body.
 *
 * Sets `body.thinking` and adjusts `body.max_tokens` so that:
 *   - `max_tokens > budget_tokens` (Anthropic API requirement), and
 *   - `max_tokens <= modelOutputCap` (avoids over-cap requests).
 *
 * If the budget meets or exceeds the model's output cap, thinking is skipped
 * entirely, it is impossible to satisfy `max_tokens > budget_tokens` within
 * the cap. Pass `Infinity` for compat/SDK providers that have no per-model cap.
 *
 * Only reached for models whose resolved spec is budget-typed; see
 * {@link applyAnthropicReasoning}.
 */
export function applyAnthropicThinkingBudget(
  body: Record<string, unknown>,
  budget: number,
  modelOutputCap: number,
): void {
  if (budget <= 0) return;
  // Cannot satisfy API invariant max_tokens > budget_tokens within the model cap.
  if (budget >= modelOutputCap) return;
  body['thinking'] = { type: 'enabled', budget_tokens: budget };
  const currentMax = (body['max_tokens'] as number) ?? modelOutputCap;
  if (currentMax <= budget) {
    body['max_tokens'] = Math.min(budget + ANTHROPIC_THINKING_HEADROOM, modelOutputCap);
  }
}

/**
 * Put the request's reasoning depth on an Anthropic request body, in whichever
 * form the resolved model actually accepts.
 *
 * @param body           Mutable request body (mutated in place).
 * @param params         The request's model id and reasoning fields.
 * @param modelOutputCap Maximum output tokens the model accepts, or Infinity.
 * @returns The resolution, so callers can name the level in an error message.
 */
export function applyAnthropicReasoning(
  body: Record<string, unknown>,
  params: AnthropicReasoningParams,
  modelOutputCap: number,
): ResolvedReasoningEffort {
  const resolved = resolveEffortForRequest(params.reasoningEffort, {
    modelId: params.model,
    ...(params.reasoningEffortSpec ? { spec: params.reasoningEffortSpec } : {}),
  });
  const { value, spec } = resolved;
  if (value === undefined) return resolved;

  if (spec.kind === 'budget_tokens') {
    applyAnthropicThinkingBudget(body, budgetTokensForLevel(value, spec), modelOutputCap);
    return resolved;
  }

  // 'none' only reaches an effort- or toggle-typed spec when the catalog said
  // this model publishes a reasoning toggle, so disabling is genuinely offered.
  if (value === 'none') {
    body['thinking'] = { type: 'disabled' };
    return resolved;
  }

  if (spec.kind === 'effort' && ANTHROPIC_EFFORT_VALUES.has(value)) {
    const existing = body['output_config'];
    body['output_config'] = {
      ...(existing && typeof existing === 'object' ? existing as Record<string, unknown> : {}),
      effort: value,
    };
  }

  // Anything else (a toggle's on-state, or a level Anthropic's effort field
  // does not name) sends nothing and runs at the model's own default rather
  // than guessing a field shape.
  return resolved;
}
