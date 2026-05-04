/**
 * Source registry types for automation inputs and origin tracking.
 */

import type { AutomationSourceKind, AutomationSurfaceKind } from './types.js';

export interface AutomationSourceRecord {
  readonly id: string;
  readonly kind: AutomationSourceKind;
  readonly label: string;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly routeId?: string | undefined;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastSeenAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface AutomationSourceSnapshot {
  readonly sourceId: string;
  readonly routeBindingId?: string | undefined;
  readonly watcherId?: string | undefined;
  readonly lastEventAt?: number | undefined;
  readonly description?: string | undefined;
}
