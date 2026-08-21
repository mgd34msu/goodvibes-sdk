/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Per-model reasoning-effort resolution.
 *
 * One place decides what a given model actually accepts for "reasoning
 * effort", and which request field the adapter must put it on. Four sources,
 * highest precedence first:
 *
 *   1. the live models.dev catalog entry for the exact model id, its
 *      `reasoning_options` array, parsed by {@link parseReasoningOptions};
 *   2. a declaration attached to this exact model by whoever configured it,
 *      a plugin manifest, a custom-model file, or the traits of the local
 *      server actually holding the weights;
 *   3. a curated per-family-generation table for models the live catalog does
 *      not carry (see `reasoning-effort-families.ts`);
 *   4. a best-guess ladder that says in its own note that it is a guess
 *      rather than verified provider data.
 *
 * {@link resolveEffortForModel} maps a requested level onto whatever the
 * resolved model actually offers. It only ever snaps DOWN the severity
 * ordering: silently spending more reasoning tokens than the caller asked for
 * is a cost and latency change they did not consent to. When nothing at or
 * below the request exists, the level is dropped entirely and the provider's
 * own default applies, still never a promotion.
 */

/** Where a resolved spec's information came from. */
export type ReasoningEffortSource = 'catalog' | 'declared' | 'family' | 'fallback';

/**
 * Precedence of each source, higher wins.
 *
 * `declared` sits above `family` because a declaration names one exact model on
 * one exact endpoint, while the family table matches bare id prefixes: a local
 * `deepseek-r1` served by ollama shares its name with DeepSeek's hosted API but
 * not its accepted levels, and the endpoint that is actually serving the
 * weights is the better authority.
 */
const REASONING_EFFORT_SOURCE_RANK: Readonly<Record<ReasoningEffortSource, number>> = {
  catalog: 3,
  declared: 2,
  family: 1,
  fallback: 0,
};

/** Precedence of a spec source; higher outranks lower. */
export function reasoningEffortSourceRank(source: ReasoningEffortSource): number {
  return REASONING_EFFORT_SOURCE_RANK[source];
}

/** Reasoning levels ordered from least to most reasoning spend. */
export const REASONING_EFFORT_SEVERITY: readonly string[] = [
  'none',
  'instant',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * Thinking-token budget for each level, for providers whose only control is a
 * token budget (Claude 4.5 and earlier, Gemini 2.5.x). `interface.ts` derives
 * the legacy four-level `REASONING_BUDGET_MAP` from this table so the two
 * cannot drift apart.
 */
export const REASONING_EFFORT_BUDGET_TOKENS: Readonly<Record<string, number>> = {
  none: 0,
  instant: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 32768,
  xhigh: 49152,
  max: 63999,
};

interface ReasoningEffortSpecBase {
  /** Selectable levels for this model, ordered least to most reasoning spend. */
  readonly values: readonly string[];
  /** The level the provider applies when the field is omitted, when documented. */
  readonly defaultValue?: string | undefined;
  readonly source: ReasoningEffortSource;
  /** Plain-language caveat shown to the user; always set when source is 'fallback'. */
  readonly note?: string | undefined;
}

/** The model takes a named effort level (`output_config.effort`, `reasoning_effort`, `thinking_level`). */
export interface ReasoningEffortLevelsSpec extends ReasoningEffortSpecBase {
  readonly kind: 'effort';
}

/** The model takes a thinking-token budget (`thinking.budget_tokens`, `thinking_budget`). */
export interface ReasoningEffortBudgetSpec extends ReasoningEffortSpecBase {
  readonly kind: 'budget_tokens';
  readonly minBudgetTokens: number;
  readonly maxBudgetTokens?: number | undefined;
  /**
   * Whether this model can be told not to reason at all.
   *
   * Not the same question as `minBudgetTokens === 0`, because the two vendors
   * express "off" differently: Anthropic omits the `thinking` block entirely
   * while still documenting a 1024-token floor for an enabled budget, whereas
   * Gemini sends the budget as a literal number and 2.5 Pro rejects a zero one.
   * Only when this is true do the zero-budget levels (`none`, `instant`) appear
   * among the model's offered levels.
   */
  readonly canDisableReasoning: boolean;
}

/** The model only exposes reasoning on/off, with no depth control. */
export interface ReasoningEffortToggleSpec extends ReasoningEffortSpecBase {
  readonly kind: 'toggle';
}

/** The model reasons at a fixed depth, or does not reason at all, nothing to send. */
export interface ReasoningEffortUnavailableSpec extends ReasoningEffortSpecBase {
  readonly kind: 'unavailable';
  readonly values: readonly [];
}

/** What a specific model accepts for reasoning effort, and how to send it. */
export type ReasoningEffortSpec =
  | ReasoningEffortLevelsSpec
  | ReasoningEffortBudgetSpec
  | ReasoningEffortToggleSpec
  | ReasoningEffortUnavailableSpec;

/** One entry of a models.dev `reasoning_options` array. */
export interface ModelsDevReasoningOption {
  readonly type?: string | undefined;
  readonly values?: readonly string[] | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
}

/** The value a toggle-only model uses for its "reasoning on" state. */
const TOGGLE_ON_LEVEL = 'high';

const TOGGLE_NOTE =
  'This model only exposes reasoning on or off, any level above \'none\' turns reasoning on at the model\'s own depth.';

const FALLBACK_NOTE =
  'Best-guess levels: this model is not in the live model catalog and matches no known family, so the provider may reject some of them.';

/** Used when nothing else resolves. Labelled as a guess, never presented as verified. */
export const FALLBACK_REASONING_EFFORT_SPEC: ReasoningEffortLevelsSpec = {
  kind: 'effort',
  values: ['low', 'medium', 'high'],
  source: 'fallback',
  note: FALLBACK_NOTE,
};

/** The selectable levels of a spec, for surfaces that carry a plain list. */
export function reasoningEffortLevels(spec: ReasoningEffortSpec | undefined): readonly string[] {
  return spec?.values ?? [];
}

/**
 * Build a spec from a hand-declared level list.
 *
 * The boundary for author-supplied declarations, plugin manifests, custom
 * model files, which name levels rather than a wire shape. Marked `declared`
 * because the author is naming the levels of the exact endpoint they
 * configured: better than both the best-guess ladder and the prefix-matched
 * family table, and still outranked by the live catalog.
 */
export function reasoningEffortSpecFromLevels(
  levels: readonly string[] | undefined,
  source: ReasoningEffortSource = 'declared',
): ReasoningEffortSpec | undefined {
  if (levels === undefined) return undefined;
  const values = orderLevels(levels);
  if (values.length === 0) {
    return { kind: 'unavailable', values: [], source };
  }
  return { kind: 'effort', values, source };
}

/** Position in the severity ordering, or -1 when the level is not a known one. */
export function reasoningEffortRank(level: string): number {
  return REASONING_EFFORT_SEVERITY.indexOf(level);
}

/**
 * Read an untrusted `reasoningEffort` field into a level, or undefined when it
 * is not one.
 *
 * The single gate for job and request payloads arriving over HTTP. Hand-written
 * value lists at those boundaries drift behind the ladder as new levels ship,
 * a job whose contract-valid policy asked for `xhigh` silently ran at the
 * model's default, so every such boundary reads through here instead. Which of
 * these levels a given MODEL accepts is a separate question, settled per model
 * by {@link resolveEffortForModel} once the job reaches a provider.
 */
export function readReasoningEffortLevel(value: unknown): string | undefined {
  return typeof value === 'string' && reasoningEffortRank(value) !== -1 ? value : undefined;
}

/** Sort to severity order and drop duplicates and unrecognized levels. */
function orderLevels(levels: readonly string[]): string[] {
  const known = new Set(levels.filter((level) => reasoningEffortRank(level) !== -1));
  return REASONING_EFFORT_SEVERITY.filter((level) => known.has(level));
}

/**
 * Levels a token-budget model can express within its documented min/max.
 *
 * The zero-budget levels are offered only when the model can genuinely be told
 * not to reason: Gemini 2.5 Pro documents a 128-token minimum and answers a
 * zero budget with a 400, so listing `none` for it would offer a level the
 * model rejects.
 */
export function budgetLevels(
  min: number,
  max: number | undefined,
  canDisableReasoning: boolean,
): string[] {
  return REASONING_EFFORT_SEVERITY.filter((level) => {
    const budget = REASONING_EFFORT_BUDGET_TOKENS[level]!;
    if (budget === 0) return canDisableReasoning;
    if (budget < min) return false;
    return max === undefined || budget <= max;
  });
}

/** Thinking-token budget for a level under a budget-typed spec, clamped to its range. */
export function budgetTokensForLevel(level: string, spec: ReasoningEffortBudgetSpec): number {
  const budget = REASONING_EFFORT_BUDGET_TOKENS[level];
  if (typeof budget !== 'number' || budget <= 0) return 0;
  const floored = Math.max(budget, spec.minBudgetTokens);
  return spec.maxBudgetTokens === undefined ? floored : Math.min(floored, spec.maxBudgetTokens);
}

/**
 * Parse a models.dev `reasoning_options` array into a spec.
 *
 * Returns undefined when the field is absent, that is "the catalog says
 * nothing", which must fall through to the curated family table, and is a
 * different statement from an empty array, which says "this model reasons but
 * exposes no configurable levels" (models.dev publishes exactly that for
 * `deepseek-reasoner`).
 */
export function parseReasoningOptions(
  options: readonly ModelsDevReasoningOption[] | undefined,
): ReasoningEffortSpec | undefined {
  if (!Array.isArray(options)) return undefined;

  if (options.length === 0) {
    return {
      kind: 'unavailable',
      values: [],
      source: 'catalog',
      note: 'This model always reasons at a fixed depth; the catalog lists no configurable levels.',
    };
  }

  const effort = options.find((option) => option?.type === 'effort');
  const budget = options.find((option) => option?.type === 'budget_tokens');
  const toggle = options.find((option) => option?.type === 'toggle');

  if (effort) {
    // A toggle alongside named levels means reasoning can also be switched
    // off, so 'none' joins the ladder.
    const levels = orderLevels([...(effort.values ?? []), ...(toggle ? ['none'] : [])]);
    if (levels.length > 0) {
      // When a model publishes both, the named levels are the live control and
      // the token budget is the deprecated one (Anthropic's Claude 4.6
      // generation is exactly this shape), so prefer effort and never send both.
      return { kind: 'effort', values: levels, source: 'catalog' };
    }
  }

  if (budget && typeof budget.min === 'number') {
    // A catalog entry has no separate "can this be switched off" field, so the
    // documented floor is the only evidence: a model that accepts a zero budget
    // publishes min 0, and one that does not publishes its real minimum.
    const canDisableReasoning = budget.min <= 0;
    const max = typeof budget.max === 'number' ? budget.max : undefined;
    return {
      kind: 'budget_tokens',
      values: budgetLevels(budget.min, max, canDisableReasoning),
      source: 'catalog',
      minBudgetTokens: budget.min,
      canDisableReasoning,
      ...(max === undefined ? {} : { maxBudgetTokens: max }),
    };
  }

  if (toggle) {
    return {
      kind: 'toggle',
      values: ['none', TOGGLE_ON_LEVEL],
      source: 'catalog',
      note: TOGGLE_NOTE,
    };
  }

  return undefined;
}

/** Everything `resolveEffortForModel` needs from a model. */
export interface ReasoningEffortModel {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly reasoningEffort?: ReasoningEffortSpec | undefined;
}

/** Outcome of mapping a requested level onto one model's real options. */
export interface ResolvedReasoningEffort {
  /** The level to send, or undefined to omit the field and take the provider default. */
  readonly value: string | undefined;
  /** The spec the decision was made against. */
  readonly spec: ReasoningEffortSpec;
  /** Plain-language explanation, present whenever the answer is not exactly what was asked for. */
  readonly note?: string | undefined;
}

/** Highest available level at or below `requested`; undefined when none exists. */
export function snapEffortDown(requested: string, values: readonly string[]): string | undefined {
  const target = reasoningEffortRank(requested);
  if (target === -1) return undefined;
  let best: string | undefined;
  let bestRank = -1;
  for (const value of values) {
    const rank = reasoningEffortRank(value);
    if (rank === -1 || rank > target) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = value;
    }
  }
  return best;
}

function modelLabel(model: ReasoningEffortModel): string {
  return model.displayName ?? model.id ?? 'this model';
}

/**
 * Map a requested reasoning level onto what one model actually accepts.
 *
 * Never returns a level above the request: an unavailable request snaps down
 * to the closest lower level, and when there is none the level is dropped so
 * the provider applies its own default.
 */
export function resolveEffortForModel(
  requested: string | undefined,
  model: ReasoningEffortModel,
): ResolvedReasoningEffort {
  const spec = model.reasoningEffort ?? FALLBACK_REASONING_EFFORT_SPEC;
  const name = modelLabel(model);

  if (spec.kind === 'unavailable') {
    return {
      value: undefined,
      spec,
      note: `Reasoning effort isn't configurable on ${name}${spec.note ? `, ${spec.note}` : '.'}`,
    };
  }

  // Nothing was asked for, so nothing goes on the wire: `defaultValue` records
  // what the provider already applies when the field is omitted, and sending it
  // back explicitly would put a reasoning field on every request that never
  // requested one.
  if (requested === undefined || requested === '') {
    return { value: undefined, spec, ...(spec.note ? { note: spec.note } : {}) };
  }

  if (spec.values.includes(requested)) {
    return { value: requested, spec, ...(spec.note ? { note: spec.note } : {}) };
  }

  // A toggle has no depth to snap through: anything other than 'none' means on.
  // Snapping 'low' down to 'none' here would silently disable reasoning, which
  // is the opposite of what a caller asking for light reasoning wants.
  if (spec.kind === 'toggle') {
    const value = requested === 'none' ? 'none' : TOGGLE_ON_LEVEL;
    return {
      value,
      spec,
      note: `${name} only supports reasoning on or off; using '${value}'.`,
    };
  }

  if (reasoningEffortRank(requested) === -1) {
    return {
      value: spec.defaultValue,
      spec,
      note: `'${requested}' isn't a known reasoning level; using ${
        spec.defaultValue ? `'${spec.defaultValue}'` : `${name}'s own default`
      } instead.`,
    };
  }

  const snapped = snapEffortDown(requested, spec.values);
  if (snapped === undefined) {
    return {
      value: undefined,
      spec,
      note: `Reasoning effort '${requested}' isn't available on ${name}, and it offers nothing lower (${
        spec.values.join(', ')
      }); using the model's own default instead.`,
    };
  }

  return {
    value: snapped,
    spec,
    note: `Reasoning effort '${requested}' isn't available on ${name}; using '${snapped}' instead.`,
  };
}

/**
 * A sentence naming the reasoning level as the likely cause of a rejection,
 * or undefined when the provider's own text does not point that way.
 *
 * A 400 already surfaces to the user, it is not in the retryable set, so the
 * only gap this closes is that the message never named the setting responsible.
 * Deliberately conservative: it fires only on a 400 whose body mentions a
 * reasoning field, so an unrelated validation error is not blamed on effort.
 */
export function describeReasoningRejection(
  status: number,
  providerText: string,
  effort: string | undefined,
): string | undefined {
  if (status !== 400 || effort === undefined) return undefined;
  if (!/effort|reasoning|thinking|budget_tokens/i.test(providerText)) return undefined;
  return ` Reasoning effort '${effort}' is the likely cause, this model may not accept that level.`
    + ' Choose another with /effort, or clear provider.reasoningEffort to use the model default.';
}

/**
 * Levels the model currently in use resolved to, published by the runtime so
 * `provider.reasoningEffort` can be validated at set-time against the real
 * options rather than a fixed list. Null means no model has published yet.
 *
 * This unkeyed slot serves embedders that run one session per process. A daemon
 * hosting several sessions at once publishes under each session's own id
 * instead, so the model on one session cannot decide what is valid on another.
 */
let activeReasoningEffortOptions: readonly string[] | null = null;

const activeReasoningEffortOptionsBySession = new Map<string, readonly string[]>();

/**
 * How many sessions keep published levels. Entries are only dropped when a
 * session goes quiet for this many other sessions' turns, so the bound exists
 * to stop a long-lived daemon accumulating one entry per session ever seen.
 */
const ACTIVE_REASONING_EFFORT_SESSION_LIMIT = 64;

/**
 * Publish a model's resolved levels; pass null to clear.
 *
 * @param sessionId Scopes the publication to one session. Omit it to write the
 *                  process-wide slot used when there is only ever one session.
 */
export function setActiveReasoningEffortOptions(
  values: readonly string[] | null,
  sessionId?: string,
): void {
  if (sessionId === undefined) {
    activeReasoningEffortOptions = values === null ? null : [...values];
    return;
  }
  if (values === null) {
    activeReasoningEffortOptionsBySession.delete(sessionId);
    return;
  }
  // Re-inserting moves the session to the newest end of the iteration order, so
  // the entry evicted below is always the least recently published one.
  activeReasoningEffortOptionsBySession.delete(sessionId);
  activeReasoningEffortOptionsBySession.set(sessionId, [...values]);
  while (activeReasoningEffortOptionsBySession.size > ACTIVE_REASONING_EFFORT_SESSION_LIMIT) {
    const oldest = activeReasoningEffortOptionsBySession.keys().next();
    if (oldest.done === true) break;
    activeReasoningEffortOptionsBySession.delete(oldest.value);
  }
}

/**
 * A model's resolved levels, or null when none have been published.
 *
 * With a session id, that session's own levels, falling back to the unkeyed
 * slot so an embedder that never passes a session id still reads its own
 * publication. Without one, only the unkeyed slot.
 */
export function getActiveReasoningEffortOptions(sessionId?: string): readonly string[] | null {
  if (sessionId !== undefined) {
    return activeReasoningEffortOptionsBySession.get(sessionId) ?? activeReasoningEffortOptions;
  }
  return activeReasoningEffortOptions;
}

/**
 * Whether a `provider.reasoningEffort` value is acceptable right now.
 *
 * Given a session id, the answer is that session's own resolved levels. Without
 * one, the config schema's validator has no session in hand, because the
 * setting itself is not per session, a level is acceptable when ANY session
 * that has published offers it. Rejecting a level valid on the session the user
 * is actually looking at, because a different session ran a turn more recently,
 * would be the multi-session bleed this scoping exists to prevent. A level no
 * live model offers is still rejected, and before anything has published the
 * known severity ladder is the floor, so a typo never gets through.
 */
export function isAcceptableReasoningEffortSetting(value: unknown, sessionId?: string): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (sessionId !== undefined) {
    const scoped = getActiveReasoningEffortOptions(sessionId);
    return scoped === null ? reasoningEffortRank(value) !== -1 : scoped.includes(value);
  }
  let published = false;
  if (activeReasoningEffortOptions !== null) {
    if (activeReasoningEffortOptions.includes(value)) return true;
    published = true;
  }
  for (const levels of activeReasoningEffortOptionsBySession.values()) {
    if (levels.includes(value)) return true;
    published = true;
  }
  return published ? false : reasoningEffortRank(value) !== -1;
}

/**
 * One line describing what this model receives on the wire, for the `/effort`
 * explainer. Generated from the resolved spec so it cannot go stale the way a
 * hand-written per-provider string does.
 */
export function describeReasoningWire(spec: ReasoningEffortSpec, providerId?: string): string {
  const provider = (providerId ?? '').toLowerCase();
  switch (spec.kind) {
    case 'effort':
      if (provider.includes('anthropic') || provider.includes('bedrock') || provider.includes('vertex')) {
        return 'output_config.effort';
      }
      if (provider.includes('google') || provider.includes('gemini')) return 'thinking_config.thinking_level';
      return 'reasoning_effort';
    case 'budget_tokens':
      if (provider.includes('google') || provider.includes('gemini')) {
        return 'thinking_config.thinking_budget';
      }
      return 'thinking.budget_tokens';
    case 'toggle':
      return 'reasoning on/off';
    case 'unavailable':
      return 'not sent, this model has no configurable reasoning level';
  }
}
