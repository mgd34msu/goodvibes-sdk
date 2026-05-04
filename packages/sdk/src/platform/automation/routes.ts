/**
 * Route binding types for external conversation and thread context.
 */

import type {
  AutomationDeliveryGuarantee,
  AutomationRouteKind,
  AutomationSessionPolicy,
  AutomationSurfaceKind,
  AutomationThreadPolicy,
} from './types.js';

export interface AutomationRouteBinding {
  readonly id: string;
  readonly kind: AutomationRouteKind;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationSessionPolicy | undefined;
  readonly threadPolicy?: AutomationThreadPolicy | undefined;
  readonly deliveryGuarantee?: AutomationDeliveryGuarantee | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly runId?: string | undefined;
  readonly title?: string | undefined;
  readonly lastSeenAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metadata: Record<string, unknown>;
}

export interface AutomationRouteResolution {
  readonly bindingId?: string | undefined;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly externalId: string;
  readonly threadId?: string | undefined;
  readonly confidence?: number | undefined;
  readonly reason?: string | undefined;
}
