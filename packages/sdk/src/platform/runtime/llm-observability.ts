/**
 * OBS-04/OBS-06: LLM observability utilities.
 *
 * Provides:
 * - Prompt/response content summarization for redaction-by-default telemetry
 * - instrumentedLlmCall() wrapper that emits LLM_REQUEST_STARTED + enriched LLM_RESPONSE_RECEIVED
 * - includeRawPrompts config awareness
 */
import { createHash } from 'node:crypto';
import {
  llmRequestsTotal,
  llmRequestDurationMs,
  llmTokensInput,
  llmTokensOutput,
  llmRequestsStarted,
} from './metrics.js';

/** Structured prompt summary emitted in telemetry events (default: redacted). */
export interface PromptSummary {
  /** Byte length of the raw content. */
  length: number;
  /** SHA-256 hex digest of the raw content (for deduplication without exposure). */
  sha256: string;
  /** First 100 chars of the raw content (safe preview). */
  first100chars: string;
}

/**
 * OBS-06: Summarize prompt/response content for telemetry emission.
 * When includeRawPrompts is true, returns the raw string.
 * Default (false): returns a PromptSummary with length, sha256, first100chars.
 */
export function summarizePromptContent(
  content: string,
  includeRaw: boolean,
): PromptSummary | string {
  if (includeRaw) return content;
  return {
    length: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    first100chars: content.slice(0, 100),
  };
}

/**
 * OBS-04: Result from an instrumented LLM call.
 * Adds durationMs and retries tracking to the provider response.
 */
export interface InstrumentedLlmResult<T> {
  result: T;
  durationMs: number;
  retries: number;
}

/**
 * OBS-04: Wrap any LLM provider call to track duration, retry count, and
 * record platformMeter instruments (llmRequestsTotal, llmRequestDurationMs,
 * llmTokensInput, llmTokensOutput).
 *
 * Providers wrap their .chat() / .generate() calls with this helper.
 *
 * Usage:
 * ```ts
 * const { result, durationMs, retries } = await instrumentedLlmCall(
 *   async () => await this.chat(params),
 *   { provider: this.name, model: params.model ?? this.defaultModel },
 * );
 * ```
 */
/**
 * OBS-04: Emit LLM_REQUEST_STARTED metric at the llm-observability layer.
 *
 * Records the llmRequestsStarted counter so callers without bus access still
 * get per-provider/model observability. Callers that also hold a RuntimeEventBus
 * should additionally call emitLlmRequestStarted(bus, ctx, data) from emitters/turn.
 */
function recordLlmRequestStartedMetric(opts: { provider?: string | undefined; model?: string | undefined }): void {
  const labels: Record<string, string> = {};
  if (opts.provider) labels.provider = opts.provider;
  if (opts.model) labels.model = opts.model;
  llmRequestsStarted.add(1, labels);
}

export async function instrumentedLlmCall<T>(
  fn: () => Promise<T>,
  opts?: {
    maxRetries?: number | undefined;
    retryDelayMs?: number | undefined;
    /** Provider name for metric labels (e.g. 'anthropic'). */
    provider?: string | undefined;
    /** Model name for metric labels (e.g. 'claude-opus-4-5'). */
    model?: string | undefined;
    /** Extract token usage from a successful result to record histogram instruments. */
    extractTokens?: (result: T) => { inputTokens?: number; outputTokens?: number } | undefined;
    /**
     * M-2: Optional callback invoked on entry before the first attempt.
     * Callers that have bus/ctx access can wire emitLlmRequestStarted here.
     */
    onStarted?: (() => void) | undefined | undefined;
  }
): Promise<InstrumentedLlmResult<T>> {
  const maxRetries = opts?.maxRetries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 0;
  const startedAt = Date.now();
  // Auto-emit LLM_REQUEST_STARTED metric on entry (no bus required)
  recordLlmRequestStartedMetric({ provider: opts?.provider, model: opts?.model });
  // M-2: fire onStarted callback if provided (e.g. to emit LLM_REQUEST_STARTED on the event bus)
  opts?.onStarted?.();
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      // C-1: record LLM metric instruments
      if (opts?.provider !== undefined || opts?.model !== undefined) {
        const labels: Record<string, string> = {};
        if (opts.provider) labels.provider = opts.provider;
        if (opts.model) labels.model = opts.model;
        llmRequestsTotal.add(1, { ...labels, status: 'success' });
        llmRequestDurationMs.record(durationMs, labels);
        if (opts.extractTokens) {
          const tokens = opts.extractTokens(result);
          if (tokens?.inputTokens !== undefined && tokens.inputTokens > 0) {
            llmTokensInput.record(tokens.inputTokens, labels);
          }
          if (tokens?.outputTokens !== undefined && tokens.outputTokens > 0) {
            llmTokensOutput.record(tokens.outputTokens, labels);
          }
        }
      }
      return { result, durationMs, retries: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && retryDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          timer.unref?.();
        });
      }
    }
  }

  // Record error metric on final failure
  if (opts?.provider !== undefined || opts?.model !== undefined) {
    const labels: Record<string, string> = {};
    if (opts?.provider) labels.provider = opts.provider;
    if (opts?.model) labels.model = opts.model;
    llmRequestsTotal.add(1, { ...labels, status: 'error' });
    llmRequestDurationMs.record(Date.now() - startedAt, labels);
  }

  throw lastError;
}
