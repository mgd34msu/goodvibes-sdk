export interface BackoffPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoffFactor?: number;
}

export interface ResolvedBackoffPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffFactor: number;
}

export function normalizeBackoffPolicy(
  policy: BackoffPolicy | undefined,
  defaults: ResolvedBackoffPolicy,
): ResolvedBackoffPolicy {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? defaults.maxAttempts)),
    baseDelayMs: Math.max(0, Math.floor(policy?.baseDelayMs ?? defaults.baseDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(policy?.maxDelayMs ?? defaults.maxDelayMs)),
    backoffFactor: Math.max(1, policy?.backoffFactor ?? defaults.backoffFactor),
  };
}

/**
 * Return the retry delay for a one-based attempt number.
 *
 * Attempt `1` is the first retry and uses `baseDelayMs`; attempt `2` applies
 * one backoff factor; attempt `0` or negative values return `0` so defensive
 * callers do not schedule negative or NaN timers.
 */
export function computeBackoffDelay(
  attempt: number,
  policy: ResolvedBackoffPolicy,
): number {
  if (attempt <= 0) return 0;
  const exponent = Math.max(0, attempt - 1);
  const delay = policy.baseDelayMs * (policy.backoffFactor ** exponent);
  return Math.min(policy.maxDelayMs, Math.max(0, Math.floor(delay)));
}

export async function sleepWithSignal(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
