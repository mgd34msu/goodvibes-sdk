/**
 * Delivery policy and delivery-attempt types.
 */

import type { AutomationSurfaceKind } from './types.js';

export type AutomationDeliveryMode = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface AutomationDeliveryTarget {
  readonly kind: AutomationDeliveryMode;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface AutomationDeliveryPolicy {
  readonly mode: AutomationDeliveryMode;
  readonly targets: readonly AutomationDeliveryTarget[];
  readonly fallbackTargets: readonly AutomationDeliveryTarget[];
  readonly includeSummary: boolean;
  readonly includeTranscript: boolean;
  readonly includeLinks: boolean;
  readonly replyToRouteId?: string | undefined;
}

export interface AutomationDeliveryAttempt {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly target: AutomationDeliveryTarget;
  readonly status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead_lettered';
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly error?: string | undefined;
  readonly responseId?: string | undefined;
}
