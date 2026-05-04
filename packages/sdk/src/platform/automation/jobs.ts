/**
 * First-class automation job records.
 */

import type { AutomationDeliveryPolicy } from './delivery.js';
import type { AutomationFailurePolicy } from './failures.js';
import type { AutomationScheduleDefinition } from './schedules.js';
import type { AutomationExecutionPolicy } from './session-targets.js';
import type { AutomationEntityBase, AutomationJobStatus } from './types.js';
import type { AutomationSourceRecord } from './sources.js';

export interface AutomationJob extends AutomationEntityBase {
  readonly name: string;
  readonly description?: string | undefined;
  readonly status: AutomationJobStatus;
  readonly enabled: boolean;
  readonly schedule: AutomationScheduleDefinition;
  readonly execution: AutomationExecutionPolicy;
  readonly delivery: AutomationDeliveryPolicy;
  readonly failure: AutomationFailurePolicy;
  readonly source: AutomationSourceRecord;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly lastRunId?: string | undefined;
  readonly runCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly pausedReason?: string | undefined;
  readonly deleteAfterRun: boolean;
  readonly archivedAt?: number | undefined;
}
