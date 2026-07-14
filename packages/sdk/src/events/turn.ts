/**
 * TurnEvent — discriminated union covering all conversation turn lifecycle events.
 *
 * Maps to the typed runtime event contract for the turn domain.
 */

export interface PartialToolCall {
  readonly index: number;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly arguments?: string | undefined;
}

export interface TurnInputOrigin {
  readonly source?: string | undefined;
  readonly surface?: string | undefined;
  readonly messageId?: string | undefined;
  readonly topic?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export type TurnStopReason =
  | 'completed'
  | 'empty_response'
  | 'preflight_failed'
  | 'context_overflow'
  | 'provider_exhausted'
  | 'provider_error'
  | 'hook_denied'
  | 'tool_loop_circuit_breaker'
  | 'cancelled'
  | 'unexpected_error';

export type TurnEvent =
  /** User prompt has been submitted for processing. */
  | { type: 'TURN_SUBMITTED'; turnId: string; prompt: string; origin?: TurnInputOrigin }
  /** Preflight checks (context, rate limits, etc.) passed. */
  | { type: 'PREFLIGHT_OK'; turnId: string }
  /** Preflight checks failed; turn will not proceed. */
  | { type: 'PREFLIGHT_FAIL'; turnId: string; reason: string; stopReason: Extract<TurnStopReason, 'preflight_failed' | 'context_overflow'> }
  /** A provider stream iteration has begun inside the logical turn. */
  | { type: 'STREAM_START'; turnId: string; scope?: 'provider'; terminal?: false }
  /** An incremental content chunk arrived from the provider. */
  | { type: 'STREAM_DELTA'; turnId: string; content: string; accumulated: string; reasoning?: string; toolCalls?: PartialToolCall[] }
  /**
   * A provider stream iteration has ended.
   *
   * This is not the logical end of the turn when tools or multi-step provider
   * calls are involved. Clients that need turn completion should wait for
   * TURN_COMPLETED, TURN_ERROR, TURN_CANCEL, or PREFLIGHT_FAIL.
   */
  | { type: 'STREAM_END'; turnId: string; scope?: 'provider'; terminal?: false }
  /**
   * A provider chat call hit a retryable transport error mid-stream and is
   * about to retry the same request against the same provider after a delay.
   *
   * This is distinct from provider failover (a new provider chosen after a
   * terminal TURN_ERROR): STREAM_RETRY fires from inside a single in-flight
   * `provider.chat()` call, before any TURN_ERROR is ever raised.
   */
  | { type: 'STREAM_RETRY'; turnId: string; provider: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** An LLM request is about to be dispatched to the provider. */
  | {
    type: 'LLM_REQUEST_STARTED';
    turnId: string;
    provider: string;
    model: string;
    /** Redacted prompt summary: {length, sha256, first100chars} unless telemetry.includeRawPrompts is true. */
    promptSummary: { length: number; sha256: string; first100chars: string } | string;
  }
  /** A provider chat call completed within the current turn iteration. */
  | {
    type: 'LLM_RESPONSE_RECEIVED';
    turnId: string;
    provider: string;
    model: string;
    /** Redacted response summary: {length, sha256, first100chars} unless telemetry.includeRawPrompts is true. */
    contentSummary: { length: number; sha256: string; first100chars: string } | string;
    toolCallCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    /** LLM request enrichments */
    durationMs?: number | undefined;
    retries?: number | undefined;
    /**
     * usage x resolved price, in USD cents — actuals only. Absent when the
     * model's price is unknown or the surface is subscription-priced; the
     * absence is deliberate (an explicit unpriced marker via costSource),
     * never a silent $0.
     */
    costUsdCents?: number | undefined;
    /**
     * Where the price behind costUsdCents came from: a user-set manual
     * price ('user'), the provider's own machine-readable pricing
     * ('provider'), a dated catalog entry ('catalog'), a subscription
     * surface (no per-token price), or 'unknown' (unpriced usage —
     * downstream sums must report it, never $0 it).
     */
    costSource?: 'user' | 'provider' | 'catalog' | 'subscription' | 'unknown' | undefined;
    finishReason?: string | undefined;
    providerRequestId?: string | undefined;
    /**
     * Cost-attribution origin: the tool call / hook / MCP server on whose behalf
     * this LLM call was made, when the engine emitted it inside a cost-origin
     * scope (runtime/cost/cost-origin.ts). Absent for a top-level agent-reasoning
     * call, which is attributed to the session/agent rather than a tool it called.
     */
    originTool?: string | undefined;
    originCallId?: string | undefined;
    originHook?: string | undefined;
    originMcpServer?: string | undefined;
    /**
     * Rate-limit / quota snapshot parsed from this response's headers (present on
     * successes too, not only 429s), when the provider carried recognized
     * headers. Consumed by the quota-window tracker so consumers can render
     * remaining quota before a limit is hit.
     */
    rateLimit?: {
      limit?: number | undefined;
      remaining?: number | undefined;
      resetAt?: number | undefined;
      retryAfterMs?: number | undefined;
    } | undefined;
  }
  /** A batch of tool calls is ready for execution. */
  | { type: 'TOOL_BATCH_READY'; turnId: string; toolCalls: string[] }
  /** All tool calls in the current batch have completed. */
  | { type: 'TOOLS_DONE'; turnId: string }
  /** Post-processing hooks (WRFC, formatters, etc.) have completed. */
  | { type: 'POST_HOOKS_DONE'; turnId: string }
  /**
   * Turn completed successfully with a final response.
   *
   * `metadata.memory.recordIds` carries the MEMORY-sourced knowledge-record ids
   * that were injected into this turn (TurnInjectionRecord.injectedIds filtered
   * to source 'memory' — code-index hits are deliberately excluded). The path
   * shape matches the documented surface convention exactly
   * (`metadata.memory.recordIds: string[]`), so a provenance chip reads it
   * unchanged. A turn with no memory injections carries NO metadata field —
   * honest absence, never an empty array.
   */
  | { type: 'TURN_COMPLETED'; turnId: string; response: string; stopReason: Extract<TurnStopReason, 'completed' | 'empty_response'>; metadata?: TurnCompletedMetadata | undefined }
  /** Turn failed with an error. */
  | { type: 'TURN_ERROR'; turnId: string; error: string; stopReason: Exclude<TurnStopReason, 'completed' | 'empty_response' | 'cancelled'> }
  /** Turn was cancelled by the user or system. */
  | { type: 'TURN_CANCEL'; turnId: string; reason?: string; stopReason: Extract<TurnStopReason, 'cancelled'> };

/**
 * Optional provenance metadata on TURN_COMPLETED. The `memory.recordIds` path
 * is a published convention surfaces already read — keep the shape stable.
 */
export interface TurnCompletedMetadata {
  readonly memory?: { readonly recordIds: readonly string[] } | undefined;
}

/** All turn event type literals as a union. */
export type TurnEventType = TurnEvent['type'];
