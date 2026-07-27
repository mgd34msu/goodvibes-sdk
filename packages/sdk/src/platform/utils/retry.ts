import { randomInt } from 'node:crypto';
import { AppError, RETRYABLE_STATUS_CODES } from '../types/errors.js';
import { summarizeError } from './error-display.js';
import { sleep } from './concurrency.js';

/** Configuration for retry behaviour with exponential backoff. */
export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /**
   * Cancellation for the backoff between attempts.
   *
   * Without it the backoff is unreachable once armed: a caller that has been
   * cancelled — an agent killed, a turn abandoned — still sits out the full
   * wait, up to `maxDelayMs` per attempt, before it can even discover it was
   * cancelled. The wait is where nearly all of a failing retry's wall time
   * goes, so leaving it uncancellable made cancellation approximate.
   *
   * When it fires the sleep ends immediately and the last error is thrown,
   * which is what the surrounding code already does with a spent retry budget.
   */
  signal?: AbortSignal | undefined;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

/** Type guard: checks if an unknown value has a numeric `statusCode` property. */
export function hasStatusCode(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as Record<string, unknown>).statusCode === 'number'
  );
}

/** Type guard: checks if an unknown value has a numeric `status` property. */
export function hasStatus(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as Record<string, unknown>).status === 'number'
  );
}

/**
 * Determines whether an error should trigger a retry.
 * Checks AppError.recoverable first, then falls back to HTTP status code inspection.
 * Handles both Error subclasses and plain objects with statusCode/status properties.
 */
export function isRetryableError(error: unknown): boolean {
  // AppError with explicit recoverability flag takes priority
  if (error instanceof AppError) {
    return error.recoverable;
  }
  // Inspect statusCode / status on any object (including non-Error throwables)
  if (hasStatusCode(error)) {
    return RETRYABLE_STATUS_CODES.includes(error.statusCode);
  }
  if (hasStatus(error)) {
    return RETRYABLE_STATUS_CODES.includes(error.status);
  }
  return false;
}

function computeDelay(attempt: number, initialDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: initialDelay * 2^attempt, with jitter
  const exponential = initialDelayMs * Math.pow(2, attempt);
  const jitter = randomInt(0, Math.max(1, Math.floor(initialDelayMs) + 1));
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Wraps an async function with retry logic using exponential backoff.
 * Retries when `isRetryableError` returns true for the thrown error.
 *
 * @param fn - Async function to execute.
 * @param config - Optional overrides for retry behaviour.
 * @param onRetry - Optional callback invoked before each retry. Argument order
 *   (attempt, maxAttempts, delayMs, error) matches `ChatRequest.onRetry` so
 *   providers can pass it straight through without an adapter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: Error) => void
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(summarizeError(err));

      if (attempt === cfg.maxRetries) {
        break;
      }

      if (!isRetryableError(err)) {
        throw lastError;
      }

      // A cancelled caller does not get a retry, and does not get a backoff to
      // sit through before learning that.
      if (cfg.signal?.aborted) {
        throw lastError;
      }

      const delayMs = computeDelay(attempt, cfg.initialDelayMs, cfg.maxDelayMs);
      onRetry?.(attempt + 1, cfg.maxRetries, delayMs, lastError);
      await sleep(delayMs, cfg.signal ? { signal: cfg.signal } : {});
      // sleep() resolves early on abort, so the wait ending is not by itself
      // permission to try again.
      if (cfg.signal?.aborted) {
        throw lastError;
      }
    }
  }

  throw lastError;
}
