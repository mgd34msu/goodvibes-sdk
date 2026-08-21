/**
 * Provider Capability Registry
 *
 * Unified capability contracts per provider/model for routing decisions.
 * Routing choices are fully explainable from capability records.
 */

import { getCacheCapability, type CacheType } from './cache-capability.js';
import type { LLMProvider } from './interface.js';

// ---------------------------------------------------------------------------
// Core Types
// ---------------------------------------------------------------------------

/**
 * Unified capability contract describing what a provider/model can do.
 * All fields are required, use `getCapability()` which always returns a
 * fully-resolved record derived from provider defaults and model overrides.
 */
export interface ProviderCapability {
  /** Whether the provider streams responses incrementally. */
  streaming: boolean;
  /** Whether the model accepts tool/function definitions in requests. */
  toolCalling: boolean;
  /** Whether the model can execute multiple tool calls in one turn. */
  parallelTools: boolean;
  /** Whether the provider supports JSON mode / structured output. */
  jsonMode: boolean;
  /** Whether the model exposes reasoning effort / budget controls. */
  reasoningControls: boolean;
  /** Maximum tokens the model can receive (context window). */
  maxContextTokens: number;
  /** Maximum tokens the model can generate in one response. */
  maxOutputTokens: number;
  /** Provider-level request timeout in milliseconds. */
  timeoutMs: number;
  /** Prompt-caching strategy supported by this provider. */
  caching: CacheType;
}

/**
 * A request profile describing what capabilities are needed to handle a
 * particular task. All fields are optional, omitted means "no requirement".
 */
export interface RequestProfile {
  /** Whether the request requires streaming output. */
  requiresStreaming?: boolean | undefined;
  /** Whether the request submits tool definitions. */
  requiresToolCalling?: boolean | undefined;
  /** Whether the request expects parallel tool execution. */
  requiresParallelTools?: boolean | undefined;
  /** Whether the request expects a JSON-mode / structured output response. */
  requiresJsonMode?: boolean | undefined;
  /** Whether the request tunes reasoning effort (budget, effort label). */
  requiresReasoningControls?: boolean | undefined;
  /** Minimum context window size the request needs (in tokens). */
  minContextTokens?: number | undefined;
  /** Minimum output capacity the request needs (in tokens). */
  minOutputTokens?: number | undefined;
}

// ---------------------------------------------------------------------------
// Route Explanation
// ---------------------------------------------------------------------------

/**
 * Typed reason codes for routing rejections.
 * Use these instead of free-form strings so callers can branch on them.
 */
export const RouteRejectionCode = {
  NO_STREAMING: 'NO_STREAMING',
  NO_TOOL_CALLING: 'NO_TOOL_CALLING',
  NO_PARALLEL_TOOLS: 'NO_PARALLEL_TOOLS',
  NO_JSON_MODE: 'NO_JSON_MODE',
  NO_REASONING_CONTROLS: 'NO_REASONING_CONTROLS',
  CONTEXT_TOO_SMALL: 'CONTEXT_TOO_SMALL',
  OUTPUT_TOO_SMALL: 'OUTPUT_TOO_SMALL',
} as const;

export type RouteRejectionCode = (typeof RouteRejectionCode)[keyof typeof RouteRejectionCode];

/** A single capability requirement that was not met. */
export interface RouteRejectionDetail {
  /** Machine-readable rejection code. */
  code: RouteRejectionCode;
  /** Human-readable description of why this requirement failed. */
  reason: string;
  /** Actual capability value on the provider. */
  actual: boolean | number | string;
  /** Required value from the request profile. */
  required: boolean | number | string;
}

/** Structured result of a routing decision for a provider/model/request triple. */
export type RouteExplanation =
  | {
      accepted: true;
      providerId: string;
      modelId: string;
      /** Human-readable summary of why this route was chosen. */
      summary: string;
      /** The resolved capability record used for this decision. */
      capability: ProviderCapability;
    }
  | {
      accepted: false;
      providerId: string;
      modelId: string;
      /** Human-readable summary of why this route was rejected. */
      summary: string;
      /** Ordered list of unmet requirements (non-empty when accepted=false). */
      rejections: RouteRejectionDetail[];
      /** The resolved capability record used for this decision. */
      capability: ProviderCapability;
    };

// ---------------------------------------------------------------------------
// Provider Defaults
// ---------------------------------------------------------------------------

/**
 * Baseline capability defaults per built-in provider.
 * Fields not listed fall back to `GLOBAL_DEFAULTS`.
 *
 * Note: All known providers intentionally specify every field, this makes each
 * provider's contract explicit and self-contained, at the cost of requiring all
 * entries to be updated when a new `ProviderCapability` field is added.
 * Unknown/custom providers fall back to `GLOBAL_DEFAULTS` for unspecified fields.
 */
const PROVIDER_DEFAULTS: Record<string, Partial<ProviderCapability>> = {
  anthropic: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,   // Anthropic uses structured output via tool schemas, not a json_mode flag
    reasoningControls: false,  // Extended thinking enabled per-model via reasoningEffort
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  openai: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,  // o-series models override this
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    timeoutMs: 120_000,
  },
  gemini: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  inceptionlabs: {
    streaming: true,
    toolCalling: false,   // mercury-2 does not support tool calling
    parallelTools: false,
    jsonMode: false,
    reasoningControls: true,  // mercury reasoning budget
    maxContextTokens: 128_000,
    maxOutputTokens: 32_000,
    timeoutMs: 60_000,
  },
  openrouter: {
    streaming: true,
    toolCalling: true,    // varies per routed model; default optimistic
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    timeoutMs: 120_000,
  },
  groq: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,  // Groq does not support parallel tool calls
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 30_000,  // Groq is very fast; short timeout appropriate
  },
  cerebras: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 30_000,
  },
  mistral: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    timeoutMs: 60_000,
  },
  huggingface: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: false,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  ollama: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 32_768,
    maxOutputTokens: 4_096,
    timeoutMs: 300_000,  // Local models may be slow
  },
  'ollama-cloud': {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  aihubmix: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  deepseek: {
    streaming: true,
    toolCalling: true,
    parallelTools: false,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  together: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  fireworks: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'github-copilot': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'amazon-bedrock': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'amazon-bedrock-mantle': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  'anthropic-vertex': {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  minimax: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: false,
    reasoningControls: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
  xai: {
    streaming: true,
    toolCalling: true,
    parallelTools: true,
    jsonMode: true,
    reasoningControls: false,
    maxContextTokens: 256_000,
    maxOutputTokens: 8_192,
    timeoutMs: 120_000,
  },
};

/**
 * Global defaults applied when a provider is not in `PROVIDER_DEFAULTS`.
 * Intentionally conservative: no reasoning controls, modest token limits.
 */
const GLOBAL_DEFAULTS: ProviderCapability = {
  streaming: true,
  toolCalling: true,
  parallelTools: false,
  jsonMode: false,
  reasoningControls: false,
  maxContextTokens: 32_768,
  maxOutputTokens: 4_096,
  timeoutMs: 120_000,
  caching: 'none',
};

// ---------------------------------------------------------------------------
// Per-model overrides
// ---------------------------------------------------------------------------

/**
 * Per-model facts a live source can answer, supplied by `setModelFactsSource`.
 *
 * This is the layer that should carry the fleet. The model catalog already
 * publishes each model's context window, output cap and reasoning support
 * per model; restating those in a hand-maintained table means the table is
 * wrong for every model released after the last edit, which is what happened
 * (see MODEL_LIMIT_FALLBACKS below).
 *
 * A field left undefined means "this source has nothing to say", and the
 * static fallbacks answer instead. It never means zero.
 */
export interface ModelCapabilityFacts {
  readonly maxContextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly reasoningControls?: boolean | undefined;
}

/** Resolve per-model facts from a live source. Undefined when the source does not know the model. */
export type ModelCapabilityFactsSource = (
  providerId: string,
  modelId: string,
) => ModelCapabilityFacts | undefined;

/**
 * Behavioural exceptions that no catalog field expresses, a model that cannot
 * call tools at all, or cannot do JSON mode.
 *
 * These are GENUINE exceptions, which is what an override map should hold, so
 * they keep the highest precedence: a live source reporting generous limits
 * must not turn tool calling back on for a model that has none.
 */
const MODEL_QUIRKS: Record<string, Partial<ProviderCapability>> = {
  // The o1 family rejects response_format json_object.
  'o1': { jsonMode: false },
  'o1-mini': { jsonMode: false },
  'o1-preview': { jsonMode: false },
  // Mercury (InceptionLabs) diffusion models expose no tool-calling surface.
  'mercury-2': { toolCalling: false, parallelTools: false },
  'mercury-edit': { toolCalling: false, parallelTools: false },
};

/**
 * Static per-model limits, used ONLY where a live source has nothing to say.
 *
 * Deliberately demoted below `ModelCapabilityFacts`. As the top-precedence
 * override map this was stale in both directions: it capped Claude Opus 4.5 at
 * 32_000 output tokens against a real 64_000, and it carried no row at all for
 * any model released after it was written, so the whole current fleet fell
 * through to GLOBAL_DEFAULTS' 4_096 output / 32_768 context, and a stale row
 * beat live truth wherever a row did exist.
 *
 * Values below were checked against each vendor's published limits on
 * 2026-07-27. Rows are for models the catalog may not cover (retired or
 * legacy ids); the fleet is expected to come from the live source.
 */
const MODEL_LIMIT_FALLBACKS: Record<string, Partial<ProviderCapability>> = {
  // Anthropic reasoning models
  'claude-opus-4-5': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  'claude-sonnet-4-5': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  'claude-3-5-sonnet-20241022': { maxContextTokens: 200_000, maxOutputTokens: 8_192 },
  'claude-3-7-sonnet-20250219': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
  // OpenAI reasoning models
  'o1': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 32_768 },
  'o1-mini': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 65_536 },
  'o1-preview': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 32_768 },
  'o3': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 100_000 },
  'o3-mini': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 65_536 },
  'o4-mini': { reasoningControls: true, maxContextTokens: 200_000, maxOutputTokens: 65_536 },
  // OpenAI large-context models
  'gpt-5': { maxContextTokens: 400_000 },
  'gpt-4.1': { maxContextTokens: 400_000 },
  'gpt-4.1-mini': { maxContextTokens: 400_000 },
  // Mercury models (InceptionLabs)
  'mercury-2': { reasoningControls: true, maxOutputTokens: 32_000 },
  'mercury-edit': { reasoningControls: false, maxOutputTokens: 32_000 },
  // Gemini large context
  'gemini-2.5-pro': { maxContextTokens: 2_097_152, maxOutputTokens: 65_536, reasoningControls: true },
  'gemini-2.5-flash': { maxContextTokens: 1_048_576, maxOutputTokens: 65_536, reasoningControls: true },
  'gemini-2.0-flash': { maxContextTokens: 1_048_576, maxOutputTokens: 8_192 },
  // Gemini 3 series
  'gemini-3-flash-preview': { maxContextTokens: 1_048_576, maxOutputTokens: 65_536, reasoningControls: true },
};

// ---------------------------------------------------------------------------
// ProviderCapabilityRegistry
// ---------------------------------------------------------------------------

/**
 * Registry that resolves and caches capability records per provider/model,
 * and provides explainable routing decisions.
 *
 * Merge order (lowest to highest priority):
 * 1. `GLOBAL_DEFAULTS`, conservative baseline
 * 2. `PROVIDER_DEFAULTS[providerId]`, provider-level defaults
 * 3. `LLMProvider.capabilities`, self-declared by the provider instance
 * 4. `MODEL_OVERRIDES`, static per-model overrides
 *
 * Exception: the `caching` field is always sourced from `getCacheCapability(providerId)`
 * (falling back to `MODEL_OVERRIDES.caching` if present), so self-declared caching
 * from `LLMProvider.capabilities` is intentionally ignored.
 *
 * The cache key is `${providerId}::${modelId}`. Call `invalidate()` after dynamic
 * provider registration to avoid stale entries.
 */
export class ProviderCapabilityRegistry {
  private readonly cache = new Map<string, ProviderCapability>();
  private _factsSource: ModelCapabilityFactsSource | undefined;

  /**
   * Wire a live per-model capability source (see `ModelCapabilityFacts`).
   *
   * Invalidates the cache, because every resolved record was computed without
   * it. Passing `undefined` unwires the source and falls back to the static
   * tables, which is the state a build with no catalog data is in.
   */
  setModelFactsSource(source: ModelCapabilityFactsSource | undefined): void {
    this._factsSource = source;
    this.invalidate();
  }

  /**
   * Resolve the full capability record for a provider/model pair.
   *
   * @param providerId - The registered provider name (e.g. `'anthropic'`).
   * @param modelId    - The model ID (e.g. `'claude-opus-4-5'`).
   * @param provider   - Optional provider instance for self-declared capabilities.
   * @returns A fully-resolved, immutable `ProviderCapability`.
   */
  getCapability(
    providerId: string,
    modelId: string,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): ProviderCapability {
    // Self-declared capabilities (custom/discovered providers) change the
    // resolved record, so they must participate in the cache key. Otherwise a
    // call WITHOUT a provider instance could poison the entry a later call WITH
    // one, or with different declarations, reads back.
    const key = `${providerId}::${modelId}::${this._selfCapabilitiesKey(provider?.capabilities)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const resolved = this._resolve(providerId, modelId, provider);
    this.cache.set(key, resolved);
    return resolved;
  }

  /**
   * Build a stable, order-independent key fragment from a provider's
   * self-declared capabilities so cache entries with vs without an instance
   * (or with differing declarations) never collide.
   */
  private _selfCapabilitiesKey(caps: Partial<ProviderCapability> | undefined): string {
    if (!caps) return '';
    const keys = Object.keys(caps).sort();
    if (keys.length === 0) return '';
    return keys
      .map((k) => `${k}=${JSON.stringify((caps as Record<string, unknown>)[k])}`)
      .join('&');
  }

  /**
   * Invalidate all cached capability records.
   * Call after dynamic provider registration or model discovery.
   */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Check whether a resolved capability record satisfies a request profile.
   *
   * @param capability - Resolved capability from `getCapability()`.
   * @param request    - The request profile describing requirements.
   * @returns `true` if every requirement in the profile is satisfied.
   */
  canHandle(capability: ProviderCapability, request: RequestProfile): boolean {
    return this._collectRejections(capability, request).length === 0;
  }

  /**
   * Produce a structured routing explanation for a provider/model/request triple.
   * Always returns a complete `RouteExplanation`, never throws.
   *
   * @param providerId - The registered provider name.
   * @param modelId    - The model ID.
   * @param request    - The request profile.
   * @param provider   - Optional provider instance for self-declared capabilities.
   * @returns A `RouteExplanation` with `accepted` flag, rejections, and capability.
   */
  getRouteExplanation(
    providerId: string,
    modelId: string,
    request: RequestProfile,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): RouteExplanation {
    const capability = this.getCapability(providerId, modelId, provider);
    const rejections = this._collectRejections(capability, request);

    if (rejections.length === 0) {
      return {
        accepted: true,
        providerId,
        modelId,
        summary: `Route accepted: ${providerId}/${modelId} satisfies all request requirements.`,
        capability,
      };
    }

    const reasons = rejections.map((r) => r.reason).join('; ');
    return {
      accepted: false,
      providerId,
      modelId,
      summary: `Route rejected: ${providerId}/${modelId}, ${reasons}`,
      rejections,
      capability,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolve(
    providerId: string,
    modelId: string,
    provider?: Pick<LLMProvider, 'capabilities'>,
  ): ProviderCapability {
    const providerDefaults = PROVIDER_DEFAULTS[providerId] ?? {};
    const selfDeclared: Partial<ProviderCapability> = provider?.capabilities ?? {};
    const limitFallbacks: Partial<ProviderCapability> = MODEL_LIMIT_FALLBACKS[modelId] ?? {};
    const quirks: Partial<ProviderCapability> = MODEL_QUIRKS[modelId] ?? {};

    // Live per-model facts, when a source is wired. Undefined fields are
    // dropped rather than merged, so "the source did not say" falls through to
    // the static fallback instead of overwriting it with undefined.
    const facts = this._factsSource?.(providerId, modelId);
    const liveFacts: Partial<ProviderCapability> = {};
    if (facts?.maxContextTokens !== undefined) liveFacts.maxContextTokens = facts.maxContextTokens;
    if (facts?.maxOutputTokens !== undefined) liveFacts.maxOutputTokens = facts.maxOutputTokens;
    if (facts?.reasoningControls !== undefined) liveFacts.reasoningControls = facts.reasoningControls;

    // Resolve caching separately via cache-capability module
    const cacheType = getCacheCapability(providerId).type;

    // Merge: GLOBAL_DEFAULTS < provider defaults < self-declared
    //        < static per-model limits < live per-model facts < quirks.
    //
    // Live facts outrank the static limits because they are the more current
    // answer to the same question. Quirks outrank live facts because they say
    // something live data does not carry at all, a model with no tool-calling
    // surface must not have it re-enabled by a generous limits record.
    return Object.freeze({
      ...GLOBAL_DEFAULTS,
      ...providerDefaults,
      ...selfDeclared,
      ...limitFallbacks,
      ...liveFacts,
      ...quirks,
      // caching always derived from getCacheCapability; not overridable via selfDeclared
      // but can be overridden by a per-model entry if a model has different caching
      caching: quirks.caching ?? limitFallbacks.caching ?? cacheType,
    });
  }

  private _collectRejections(
    capability: ProviderCapability,
    request: RequestProfile,
  ): RouteRejectionDetail[] {
    const rejections: RouteRejectionDetail[] = [];

    if (request.requiresStreaming === true && !capability.streaming) {
      rejections.push({
        code: RouteRejectionCode.NO_STREAMING,
        reason: 'Provider does not support streaming responses',
        actual: capability.streaming,
        required: true,
      });
    }

    if (request.requiresToolCalling === true && !capability.toolCalling) {
      rejections.push({
        code: RouteRejectionCode.NO_TOOL_CALLING,
        reason: 'Model does not support tool/function calling',
        actual: capability.toolCalling,
        required: true,
      });
    }

    if (request.requiresParallelTools === true && !capability.parallelTools) {
      rejections.push({
        code: RouteRejectionCode.NO_PARALLEL_TOOLS,
        reason: 'Model does not support parallel tool execution',
        actual: capability.parallelTools,
        required: true,
      });
    }

    if (request.requiresJsonMode === true && !capability.jsonMode) {
      rejections.push({
        code: RouteRejectionCode.NO_JSON_MODE,
        reason: 'Provider does not support JSON mode / structured output',
        actual: capability.jsonMode,
        required: true,
      });
    }

    if (request.requiresReasoningControls === true && !capability.reasoningControls) {
      rejections.push({
        code: RouteRejectionCode.NO_REASONING_CONTROLS,
        reason: 'Model does not expose reasoning effort or budget controls',
        actual: capability.reasoningControls,
        required: true,
      });
    }

    if (
      request.minContextTokens !== undefined &&
      capability.maxContextTokens < request.minContextTokens
    ) {
      rejections.push({
        code: RouteRejectionCode.CONTEXT_TOO_SMALL,
        reason: `Context window (${capability.maxContextTokens.toLocaleString()} tokens) is smaller than the required minimum (${request.minContextTokens.toLocaleString()} tokens)`,
        actual: capability.maxContextTokens,
        required: request.minContextTokens,
      });
    }

    if (
      request.minOutputTokens !== undefined &&
      capability.maxOutputTokens < request.minOutputTokens
    ) {
      rejections.push({
        code: RouteRejectionCode.OUTPUT_TOO_SMALL,
        reason: `Output capacity (${capability.maxOutputTokens.toLocaleString()} tokens) is smaller than the required minimum (${request.minOutputTokens.toLocaleString()} tokens)`,
        actual: capability.maxOutputTokens,
        required: request.minOutputTokens,
      });
    }

    return rejections;
  }
}
