import type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

/**
 * Guard helper: returns the admin-denied response if the caller lacks admin
 * privileges, otherwise calls `next()` and returns its result.
 *
 * Shared across all daemon runtime route files to avoid duplication.
 */
export function withAdmin(
  context: DaemonRuntimeRouteContext,
  req: Request,
  next: () => Response | Promise<Response>,
): Response | Promise<Response> {
  const denied = context.requireAdmin(req);
  return denied ?? next();
}
