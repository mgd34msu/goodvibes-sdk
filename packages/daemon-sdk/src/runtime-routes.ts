import type { DaemonRuntimeRouteHandlers } from './context.js';
import { createDaemonRuntimeAutomationRouteHandlers } from './runtime-automation-routes.js';
import { createDaemonRuntimeSessionRouteHandlers } from './runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeRouteHandlers {
  return {
    ...createDaemonRuntimeSessionRouteHandlers(context),
    ...createDaemonRuntimeAutomationRouteHandlers(context),
    getRuntimeMetrics: () => Response.json(context.snapshotMetrics()),
  };
}
