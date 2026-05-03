/**
 * TurnEvent — discriminated union covering all conversation turn lifecycle events.
 *
 * Maps to the typed runtime event contract for the  domain.
 */

export interface PartialToolCall {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

export interface TurnInputOrigin {
  readonly source?: string;
  readonly surface?: string;
  readonly messageId?: string;
  readonly topic?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
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
  /** OBS-04: An LLM request is about to be dispatched to the provider. */
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
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** OBS-04 enrichments */
    durationMs?: number;
    retries?: number;
    costUsdCents?: number;
    finishReason?: string;
    providerRequestId?: string;
  }
  /** A batch of tool calls is ready for execution. */
  | { type: 'TOOL_BATCH_READY'; turnId: string; toolCalls: string[] }
  /** All tool calls in the current batch have completed. */
  | { type: 'TOOLS_DONE'; turnId: string }
  /** Post-processing hooks (WRFC, formatters, etc.) have completed. */
  | { type: 'POST_HOOKS_DONE'; turnId: string }
  /** Turn completed successfully with a final response. */
  | { type: 'TURN_COMPLETED'; turnId: string; response: string; stopReason: Extract<TurnStopReason, 'completed' | 'empty_response'> }
  /** Turn failed with an error. */
  | { type: 'TURN_ERROR'; turnId: string; error: string; stopReason: Exclude<TurnStopReason, 'completed' | 'empty_response' | 'cancelled'> }
  /** Turn was cancelled by the user or system. */
  | { type: 'TURN_CANCEL'; turnId: string; reason?: string; stopReason: Extract<TurnStopReason, 'cancelled'> };

/** All turn event type literals as a union. */
export type TurnEventType = TurnEvent['type'];
