/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Failure policy and failure record types.
 */

export type AutomationFailureAction = 'retry' | 'cooldown' | 'disable' | 'dead_letter';
export type AutomationRetryStrategy = 'fixed' | 'linear' | 'exponential';

export interface AutomationRetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly strategy: AutomationRetryStrategy;
  readonly maxDelayMs?: number | undefined;
  readonly jitterMs?: number | undefined;
}

export interface AutomationFailurePolicy {
  readonly action: AutomationFailureAction;
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs: number;
  readonly retryPolicy: AutomationRetryPolicy;
  readonly deadLetterRouteId?: string | undefined;
  readonly disableAfterFailures?: boolean | undefined;
  readonly notifyRouteId?: string | undefined;
}

export interface AutomationFailureRecord {
  readonly id: string;
  readonly jobId: string;
  readonly runId?: string | undefined;
  readonly occurredAt: number;
  readonly reason: string;
  readonly action: AutomationFailureAction;
  readonly consecutiveFailures: number;
  readonly autoDisabled: boolean;
  readonly deadLetterRouteId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}
