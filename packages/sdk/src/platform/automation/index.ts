export type {
  AutomationJobStatus,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationSurfaceKind,
  AutomationRouteKind,
  AutomationSourceKind,
  AutomationExecutionKind,
  AutomationDeliveryKind,
  AutomationEntityBase,
} from './types.js';

export type {
  AutomationAtSchedule,
  AutomationEverySchedule,
  AutomationCronSchedule,
  AutomationScheduleDefinition,
  AutomationScheduleKind,
} from './schedules.js';
export {
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  parseEveryInterval,
  formatEveryInterval,
  validateSchedule,
  isRecurringTopOfHourCronExpression,
  normalizeCronStaggerMs,
  resolveDefaultCronStaggerMs,
  resolveAutomationCronStaggerMs,
  resolveStableAutomationCronOffsetMs,
  normalizeAtSchedule,
  normalizeEverySchedule,
  normalizeCronSchedule,
  getNextAutomationOccurrence,
  isAutomationDue,
} from './schedules.js';

export type {
  AutomationExecutionPolicy,
  AutomationSessionTarget,
  AutomationSessionTargetKind,
  AutomationSandboxMode,
  AutomationWakeMode,
  AutomationExternalContentSource,
  AutomationExternalContentSourceKind,
} from './session-targets.js';
export type { AutomationDeliveryMode, AutomationDeliveryTarget, AutomationDeliveryPolicy, AutomationDeliveryAttempt } from './delivery.js';
export type { AutomationFailureAction, AutomationRetryStrategy, AutomationRetryPolicy, AutomationFailurePolicy, AutomationFailureRecord } from './failures.js';
export type { AutomationSourceRecord, AutomationSourceSnapshot } from './sources.js';
export type { AutomationRouteBinding, AutomationRouteResolution } from './routes.js';
export type { AutomationJob } from './jobs.js';
export type {
  AutomationRun,
  AutomationRunSummary,
  AutomationRunTelemetry,
  AutomationRunUsageSummary,
} from './runs.js';

export { AutomationDeliveryManager } from './delivery-manager.js';
export { AutomationService } from './service.js';
export { AutomationJobStore } from './store/jobs.js';
export { AutomationRunStore } from './store/runs.js';
export { AutomationRouteStore } from './store/routes.js';
export { AutomationSourceStore } from './store/sources.js';
export type {
  AutomationHeartbeatResult,
  AutomationHeartbeatWake,
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
} from './manager.js';
export { AutomationManager } from './manager.js';
