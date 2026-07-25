/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Curated per-family-generation reasoning-effort table.
 *
 * Consulted when the live models.dev catalog carries nothing for a model —
 * a stale or missing catalog entry, a self-hosted endpoint, a gateway that
 * re-exposes a known model under its own id. Every row is sourced from the
 * provider's own current documentation, cited inline, and re-checked whenever
 * the date below is bumped. The live catalog outranks this table; this table
 * outranks the labelled best-guess ladder.
 *
 * Verified against provider documentation on 2026-07-25.
 */

import {
  type ReasoningEffortSpec,
  type ResolvedReasoningEffort,
  budgetLevels,
  FALLBACK_REASONING_EFFORT_SPEC,
  reasoningEffortSourceRank,
  resolveEffortForModel,
} from './reasoning-effort.js';

export const REASONING_EFFORT_FAMILIES_AS_OF = '2026-07-25';

/**
 * Strip provider routing decoration so `anthropic/claude-opus-5`,
 * `us.anthropic.claude-opus-5-v1:0` and `claude-opus-5@20260101` all reach the
 * same row.
 */
export function normalizeReasoningModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash !== -1) id = id.slice(slash + 1);
  // Bedrock-style `<region>.<vendor>.<model>` and `<model>-v1:0` decoration.
  id = id.replace(/^(?:us|eu|apac|global)\./, '');
  id = id.replace(/^(?:anthropic|meta|amazon|google|mistral|cohere|ai21)\./, '');
  id = id.replace(/-v\d+:\d+$/, '');
  // Vertex `@`-versioned snapshots and `:free`-style routing suffixes.
  const at = id.indexOf('@');
  if (at !== -1) id = id.slice(0, at);
  const colon = id.indexOf(':');
  if (colon !== -1) id = id.slice(0, colon);
  return id;
}

/** Anthropic documents `high` as the default when `output_config.effort` is omitted. */
const ANTHROPIC_EFFORT_DEFAULT = 'high';

function effort(
  values: readonly string[],
  defaultValue?: string,
  note?: string,
): ReasoningEffortSpec {
  return {
    kind: 'effort',
    values,
    source: 'family',
    ...(defaultValue ? { defaultValue } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * @param canDisableReasoning Whether the model can be told not to reason at
 *   all. True for Anthropic, which turns extended thinking off by omitting the
 *   `thinking` block regardless of its 1024-token floor for an enabled budget;
 *   false for Gemini 2.5, which puts the budget on the wire as a number and
 *   rejects a zero one on Pro.
 */
function budget(min: number, max: number | undefined, canDisableReasoning: boolean): ReasoningEffortSpec {
  return {
    kind: 'budget_tokens',
    values: budgetLevels(min, max, canDisableReasoning),
    source: 'family',
    minBudgetTokens: min,
    canDisableReasoning,
    ...(max === undefined ? {} : { maxBudgetTokens: max }),
  };
}

function unavailable(note: string): ReasoningEffortSpec {
  return { kind: 'unavailable', values: [], source: 'family', note };
}

interface ReasoningEffortFamilyRow {
  readonly match: RegExp;
  readonly spec: ReasoningEffortSpec;
}

/** First match wins, so more specific generations come before their family prefix. */
const FAMILY_ROWS: readonly ReasoningEffortFamilyRow[] = [
  // --- Anthropic --------------------------------------------------------
  // platform.claude.com/docs/en/build-with-claude/effort: `output_config.effort`
  // takes low | medium | high (default) | xhigh | max, no beta header, on
  // Claude Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5.
  // The same docs' extended-thinking page: "Claude 4.7 and later models do not
  // support [thinking.budget_tokens] and reject requests that use it,
  // returning a 400 error." These rows must therefore never be budget-typed.
  {
    match: /^claude-(?:fable|mythos)-/,
    spec: effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  },
  {
    match: /^claude-(?:opus|sonnet|haiku)-5/,
    spec: effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  },
  {
    match: /^claude-opus-4-(?:7|8)/,
    spec: effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  },
  // Claude 4.6 publishes both controls; `budget_tokens` is deprecated there
  // ("requests using it still succeed"), so the effort field is the live one.
  // `xhigh` arrived with Opus 4.7, so 4.6 stops at `max`.
  {
    match: /^claude-(?:opus|sonnet)-4-6/,
    spec: effort(['low', 'medium', 'high', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  },
  // Opus 4.5 accepts effort, but only low/medium/high — no xhigh, no max.
  {
    match: /^claude-opus-4-5/,
    spec: effort(['low', 'medium', 'high'], ANTHROPIC_EFFORT_DEFAULT),
  },
  // Claude 3.7 through 4.5 have no effort parameter — extended thinking with a
  // token budget, minimum 1024, is the only control. These generations are
  // enumerated rather than matched by a `claude-` catch-all on purpose: a
  // catch-all would route the next unreleased Claude to `budget_tokens`, which
  // is exactly the 400 this table exists to prevent. An unrecognized Claude id
  // falls through to the labelled ladder and gets the effort field instead,
  // which is what every current generation takes.
  // The 4.6/4.7/4.8/5 rows above already claimed their generations, so the
  // `-4` alternatives here only ever see 4.0/4.1/4.5-and-below ids.
  { match: /^claude-3[.-]7/, spec: budget(1024, undefined, true) },
  {
    match: /^claude-(?:opus|sonnet|haiku)-4(?:$|-\d)/,
    spec: budget(1024, undefined, true),
  },
  // Extended thinking arrived with Claude 3.7 Sonnet. Every earlier generation
  // rejects a `thinking` block outright, so they must resolve to "nothing to
  // send" rather than to a budget. The 3.7 row above already claimed its own
  // ids, so the `3` alternative here only sees 3.0 and 3.5.
  {
    match: /^claude-(?:instant|[123][.-])/,
    spec: unavailable('Claude generations before 3.7 Sonnet have no extended thinking and reject a thinking block.'),
  },

  // --- Google Gemini ----------------------------------------------------
  // ai.google.dev/gemini-api/docs/thinking: Gemini 3-series takes
  // `thinkingLevel` (a named level); Gemini 2.5-series takes `thinkingBudget`
  // (a token count). Sending both on one request is a 400, so the two
  // generations must never share a spec kind.
  // `thinkingLevel` names a depth; it has no documented value that turns
  // thinking off, so the 3-series rows offer no `none`. A 3-series model that
  // does publish a reasoning toggle picks it up from the live catalog, which
  // outranks this table.
  { match: /^gemini-3/, spec: effort(['low', 'medium', 'high']) },
  { match: /^gemini-(?:flash|pro)-latest/, spec: effort(['low', 'medium', 'high']) },
  // 2.5 Pro documents a 128-token minimum and rejects a zero budget, so the
  // whole 2.5 row withholds the off levels; 2.5 Flash, which can disable
  // thinking, gets that from its catalog entry.
  { match: /^gemini-2\.5/, spec: budget(128, 32768, false) },
  {
    match: /^gemini-(?:2\.0|1\.5|1\.0)/,
    spec: unavailable('Gemini 2.0 and earlier have no thinking configuration.'),
  },

  // --- xAI Grok ---------------------------------------------------------
  // docs.x.ai/docs/guides/reasoning: `reasoning_effort` values are per model.
  // The base grok-4 does not accept the parameter at all and errors when it is
  // sent, so it must resolve to "nothing to send" rather than a level.
  {
    match: /^grok-4$/,
    spec: unavailable('The base grok-4 model rejects reasoning_effort; only its successors accept it.'),
  },
  { match: /^grok-(?:4|5|code)/, spec: effort(['low', 'medium', 'high']) },

  // --- DeepSeek ---------------------------------------------------------
  // api-docs.deepseek.com/guides/thinking_mode: `reasoning_effort` accepts only
  // high (default) and max. deepseek-reasoner always reasons and exposes no
  // levels at all.
  {
    match: /^deepseek-reasoner/,
    spec: unavailable('deepseek-reasoner always reasons and exposes no configurable levels.'),
  },
  { match: /^deepseek/, spec: effort(['high', 'max'], 'high') },

  // --- OpenAI -----------------------------------------------------------
  // developers.openai.com/api/docs/guides/reasoning: "Supported values are
  // model-dependent and can include none, minimal, low, medium, high, xhigh,
  // and max. Some models support only a subset." low/medium/high is the subset
  // every current reasoning model accepts; the live catalog widens it per model.
  { match: /^(?:gpt-5|o1|o3|o4)/, spec: effort(['low', 'medium', 'high']) },

  // --- Inception Mercury -------------------------------------------------
  // Mercury-2 takes `reasoning_effort` and names an `instant` level below
  // `low` — the one place on the ladder where `instant` is a real provider
  // value rather than our own label for "barely think".
  {
    match: /^mercury-edit/,
    spec: unavailable('Mercury Edit exposes no reasoning controls.'),
  },
  { match: /^mercury/, spec: effort(['instant', 'low', 'medium', 'high']) },
];

/**
 * Curated spec for a model the live catalog does not cover, or undefined when
 * the model matches no known family generation.
 */
export function findFamilyReasoningEffortSpec(modelId: string): ReasoningEffortSpec | undefined {
  const id = normalizeReasoningModelId(modelId);
  if (!id) return undefined;
  for (const row of FAMILY_ROWS) {
    if (row.match.test(id)) return row.spec;
  }
  return undefined;
}

/** What is known about one model when deciding which spec governs it. */
export interface ReasoningEffortSpecRequest {
  readonly modelId: string;
  /** A spec already attached to the model definition, when the caller has one. */
  readonly spec?: ReasoningEffortSpec | undefined;
}

/**
 * Apply the source precedence: live catalog, then a declaration attached to
 * this exact model, then the curated family table, then the labelled best
 * guess.
 *
 * The caller's spec is consulted before the table rather than after it. The
 * table matches bare id prefixes, so a local `deepseek-r1:70b` served by ollama
 * would otherwise be handed DeepSeek's hosted-API row and lose the levels its
 * own adapter accepts. Whoever attached the spec knows which endpoint holds the
 * weights; a prefix does not.
 */
export function resolveReasoningEffortSpec(input: ReasoningEffortSpecRequest): ReasoningEffortSpec {
  const declared = input.spec;
  if (declared && reasoningEffortSourceRank(declared.source) >= reasoningEffortSourceRank('family')) {
    return declared;
  }
  const family = findFamilyReasoningEffortSpec(input.modelId);
  if (family) return family;
  return declared ?? FALLBACK_REASONING_EFFORT_SPEC;
}

/**
 * Resolve the governing spec and the level to send in one step — the entry
 * point for adapters, which hold a model id and a requested level but no
 * model definition.
 */
export function resolveEffortForRequest(
  requested: string | undefined,
  input: ReasoningEffortSpecRequest,
): ResolvedReasoningEffort {
  const spec = resolveReasoningEffortSpec(input);
  return resolveEffortForModel(requested, { id: input.modelId, reasoningEffort: spec });
}
