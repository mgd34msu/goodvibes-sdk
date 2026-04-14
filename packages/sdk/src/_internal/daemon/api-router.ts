// Synced from packages/daemon-sdk/src/api-router.ts
// Extracted from legacy source: src/control-plane/routes/api-router.ts
import { dispatchAutomationRoutes } from './automation.js';
import { dispatchOperatorRoutes } from './operator.js';
import { dispatchRemoteRoutes } from './remote.js';
import { dispatchSessionRoutes } from './sessions.js';
import { dispatchTaskRoutes } from './tasks.js';
import type { DaemonApiRouteHandlers } from './context.js';

export async function dispatchDaemonApiRoutes(req: Request, handlers: DaemonApiRouteHandlers): Promise<Response | null> {
  return (
    await dispatchRemoteRoutes(req, handlers)
    ?? await dispatchOperatorRoutes(req, handlers)
    ?? await dispatchAutomationRoutes(req, handlers)
    ?? await dispatchSessionRoutes(req, handlers)
    ?? await dispatchTaskRoutes(req, handlers)
  );
}
