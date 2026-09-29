/**
 * Tier-based system prompt supplements.
 *
 * Model capability tiers drive how much extra guidance is injected into
 * the system prompt.  All features remain available regardless of tier;
 * only the verbosity of the guidance changes.
 */

import type { ModelTier } from './registry.js';
export type { ModelTier };

/**
 * Derive the model tier from a model's context window size.
 *
 * - small  (<32K)     → 'free'     (needs most guidance)
 * - medium (32K–128K) → 'standard' (brief reminders)
 * - large  (>128K)    → 'premium'  (no extra guidance needed)
 *
 * This is used instead of the static ModelDefinition.tier field so that
 * tier-prompt selection is driven by actual model capabilities.
 *
 * An unknown window (`null`, what ProviderRegistry.getKnownContextWindowForModel
 * returns for a guessed or disproven window) gives 'standard': nothing says
 * the model is small, so it is not handed the small-model guidance.
 */
export function getTierForContextWindow(contextWindow: number | null): ModelTier {
  if (contextWindow === null) return 'standard';
  if (contextWindow > 128_000) return 'premium';
  if (contextWindow >= 32_000) return 'standard';
  return 'free';
}

/**
 * Who reads the supplement.
 *
 * - `'agent'`       , a spawned agent run with an orchestrator waiting on a
 *                      structured completion report and nobody watching live.
 * - `'conversation'`, a person's conversation (a TUI main session, a companion
 *                      chat). It keeps the tool-call guidance and never asks for
 *                      a JSON completion block or unattended behavior: a small
 *                      model told its final message MUST end with that block
 *                      obeys and ends a reply to a person with
 *                      `{"status":"completed"}`.
 */
export type TierPromptAudience = 'agent' | 'conversation';

export interface TierPromptSupplementOptions {
  /** Defaults to `'agent'`, the supplement every caller received before the option existed. */
  readonly audience?: TierPromptAudience | undefined;
}

/**
 * Returns supplemental system prompt content based on the model's capability
 * tier.  The returned string is appended to the base system prompt before
 * each LLM call.
 *
 * - free   , explicit tool-call examples, multi-agent reminders, structured
 *             output enforcement (~300 tokens); for the `'conversation'`
 *             audience, tool-call guidance only
 * - standard, brief reminders about tool usage and plan adherence (~80 tokens)
 * - premium , empty; capable models need no extra hand-holding
 */
export function getTierPromptSupplement(tier: ModelTier, options?: TierPromptSupplementOptions): string {
  const audience = options?.audience ?? 'agent';
  switch (tier) {
    case 'free':
      return audience === 'conversation' ? CONVERSATION_FREE_SUPPLEMENT : FREE_SUPPLEMENT;
    case 'standard':
      return STANDARD_SUPPLEMENT;
    case 'premium':
      return '';
    case 'subscription':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Supplement text
// ---------------------------------------------------------------------------

const FREE_SUPPLEMENT = `## Agent Guidance

You are operating in a multi-agent system. Follow these rules carefully:

**Tool calls, required format:**
Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

Example, correct agent spawn:
\`\`\`json
{ "name": "agent", "input": { "task": "<task>", "mode": "engineer" } }
\`\`\`

**Multi-agent workflows:**
When a plan requires multiple parallel agents, spawn ALL of them before
waiting for results, do not spawn one, wait, then spawn the next. Parallel
spawns run concurrently and complete faster.

**Structured output:**
Your final message MUST end with the required JSON completion block. Omitting
it causes the orchestrator to treat your run as failed.

**Plan adherence:**
Complete the full plan. Do not stop after the first step and ask for
confirmation, there is no human watching. Make the best choice and continue.`;

/** Small-context guidance for a conversation with a person: tool-call discipline only. */
const CONVERSATION_FREE_SUPPLEMENT = `## Tool guidance

Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

When work needs several independent agents, spawn all of them before waiting
for any result: parallel spawns run concurrently and finish sooner.`;

const STANDARD_SUPPLEMENT = `## Reminders
- Include all required parameters in every tool call.
- When spawning agents, use the correct \`mode\` parameter.
- Complete your full plan before reporting results.`;
