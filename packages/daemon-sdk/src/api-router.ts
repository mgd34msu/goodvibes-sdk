import { dispatchAutomationRoutes } from './automation.js';
import { dispatchOperatorRoutes } from './operator.js';
import { dispatchRemoteRoutes } from './remote.js';
import { dispatchSessionRoutes } from './sessions.js';
import { dispatchTaskRoutes } from './tasks.js';
import type { DaemonApiRouteHandlers } from './context.js';

/**
 * Optional extension dispatchers injected alongside the standard route set.
 * Each dispatcher is tried in order after the built-in routes; the first
 * non-null result wins. Exceptions thrown by an extension propagate to the
 * caller, matching built-in route behavior. Use this to wire companion-chat,
 * provider, or other feature routes into the standalone daemon without
 * modifying core route files.
 */
export type DaemonApiRouteExtension = (req: Request) => Promise<Response | null> | Response | null;

export async function dispatchDaemonApiRoutes(
  req: Request,
  handlers: DaemonApiRouteHandlers,
  extensions?: readonly DaemonApiRouteExtension[],
): Promise<Response | null> {
  let result = await dispatchRemoteRoutes(req, handlers);
  if (result !== null) return result;
  result = await dispatchOperatorRoutes(req, handlers);
  if (result !== null) return result;
  result = await dispatchAutomationRoutes(req, handlers);
  if (result !== null) return result;
  result = await dispatchSessionRoutes(req, handlers);
  if (result !== null) return result;
  result = await dispatchTaskRoutes(req, handlers);
  if (result !== null) return result;
  if (extensions) {
    for (const extension of extensions) {
      const result = await extension(req);
      if (result !== null) return result;
    }
  }
  return null;
}
