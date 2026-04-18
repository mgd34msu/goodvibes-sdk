// Synced from packages/transport-http/src/reconnect.ts
import { computeBackoffDelay, normalizeBackoffPolicy, type BackoffPolicy, type ResolvedBackoffPolicy } from './backoff.js';

export interface StreamReconnectPolicy extends BackoffPolicy {
  readonly enabled?: boolean;
}

export interface ResolvedStreamReconnectPolicy extends ResolvedBackoffPolicy {
  readonly enabled: boolean;
}

/** Maximum reconnect attempts when reconnect is enabled and the caller does not set a limit. */
export const DEFAULT_STREAM_MAX_ATTEMPTS = 10;

export const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  enabled: false,
  maxAttempts: DEFAULT_STREAM_MAX_ATTEMPTS,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  backoffFactor: 2,
};

export function normalizeStreamReconnectPolicy(
  policy?: StreamReconnectPolicy,
): ResolvedStreamReconnectPolicy {
  const normalized = normalizeBackoffPolicy(policy, DEFAULT_STREAM_RECONNECT_POLICY);
  return {
    ...normalized,
    enabled: policy?.enabled ?? DEFAULT_STREAM_RECONNECT_POLICY.enabled,
  };
}

export function getStreamReconnectDelay(
  attempt: number,
  policy: ResolvedStreamReconnectPolicy,
): number {
  return computeBackoffDelay(attempt, policy);
}
