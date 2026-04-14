// Synced from packages/daemon-sdk/src/runtime-routes.ts
// Extracted from legacy source: src/daemon/http/runtime-routes.ts
import type { DaemonApiRouteHandlers } from './context.js';
import { createDaemonRuntimeAutomationRouteHandlers } from './runtime-automation-routes.js';
import { createDaemonRuntimeSessionRouteHandlers } from './runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): Pick<
  DaemonApiRouteHandlers,
  | 'createSharedSession'
  | 'getAutomationJobs'
  | 'postAutomationJob'
  | 'getAutomationRuns'
  | 'getAutomationRun'
  | 'getAutomationHeartbeat'
  | 'postAutomationHeartbeat'
  | 'automationRunAction'
  | 'patchAutomationJob'
  | 'deleteAutomationJob'
  | 'setAutomationJobEnabled'
  | 'runAutomationJobNow'
  | 'postTask'
  | 'getSharedSession'
  | 'closeSharedSession'
  | 'reopenSharedSession'
  | 'getSharedSessionMessages'
  | 'getSharedSessionInputs'
  | 'postSharedSessionMessage'
  | 'postSharedSessionSteer'
  | 'postSharedSessionFollowUp'
  | 'cancelSharedSessionInput'
  | 'getRuntimeTask'
  | 'runtimeTaskAction'
  | 'getTaskStatus'
  | 'getSchedules'
  | 'postSchedule'
  | 'deleteSchedule'
  | 'setScheduleEnabled'
  | 'runScheduleNow'
> {
  return {
    ...createDaemonRuntimeSessionRouteHandlers(context),
    ...createDaemonRuntimeAutomationRouteHandlers(context),
  };
}
