import { dispatchAutomationRoutes } from './automation.js';
import { dispatchGatewayRestRoutes } from './gateway-rest-routes.js';
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

/**
 * Dispatch an incoming HTTP request against the full daemon API route set.
 *
 * Routes are tried in order: gateway-rest → remote → operator → automation → session → task → extensions.
 * Returns the first non-null `Response`, or `null` if no route matched.
 *
 * @param req - The incoming HTTP request.
 * @param handlers - Object implementing `DaemonApiRouteHandlers`.
 * @param extensions - Optional additional dispatchers tried after built-in routes.
 * @returns The matched route's `Response`, or `null` if unmatched.
 *
 * @example
 * ```ts
 * import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-daemon-sdk';
 *
 * const response = await dispatchDaemonApiRoutes(req, myHandlers);
 * if (response) return response;
 * return new Response('Not found', { status: 404 });
 * ```
 */
export async function dispatchDaemonApiRoutes(
  req: Request,
  handlers: DaemonApiRouteHandlers,
  extensions?: readonly DaemonApiRouteExtension[],
): Promise<Response | null> {
  // Gateway-hoisted verb families (skills.*, principals.*, checkin.*, ci.*,
  // channels.profiles.*, sessions.permissionMode/contextUsage) that advertise a
  // REST http binding are served here, ahead of the built-ins. Every one of
  // their paths is otherwise unrouted, so trying this first shadows no existing
  // route; unmatched paths return null and fall through unchanged.
  let result = await dispatchGatewayRestRoutes(req, handlers);
  if (result !== null) return result;
  result = await dispatchRemoteRoutes(req, handlers);
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
      const extResult = await extension(req);
      if (extResult !== null) return extResult;
    }
  }
  return null;
}
