import type { DaemonGatewayRestRouteHandlers } from './context.js';

/**
 * gateway-rest-routes.ts
 *
 * Explicit REST route table for the handler-backed gateway verb families that
 * ALSO advertise an `http` binding in the operator method catalog (skills.*,
 * principals.*, checkin.*, ci.*, channels.profiles.*, the session-scoped
 * sessions.permissionMode.get/set + sessions.contextUsage.get, and stepup.*
 * (the relay step-up ceremony)). Those verbs are
 * served in-process through `invokeGatewayMethodCall`'s registered-handler
 * branch, reachable over the wire via the generic
 * `POST /api/control/gateway-methods/:methodId/invoke` endpoint. But each one
 * also promises a plain-REST path (`GET /api/skills`, …) in its descriptor's
 * http binding, and no route ever served those paths — a caller trusting the
 * advertisement and hitting `GET /api/skills` got a bare 404. That is the exact
 * advertise-without-route defect the capability-route reconcile
 * (method-catalog-route-reconcile.ts) exists to catch.
 *
 * This module closes that gap with genuine route parity rather than by muting
 * the gate: it maps each advertised REST path to its gateway methodId and
 * dispatches through `handlers.invokeGatewayRestVerb`, which the daemon wires
 * back to the SAME `invokeGatewayMethodCall` the methodId-invoke endpoint uses.
 * No verb logic is duplicated — the REST path and the methodId-invoke endpoint
 * now resolve to the identical in-process handler, with the identical
 * access/scope gate. Path parameters ({name}, {sessionId}, …) are folded into
 * the invocation query so the handler's `readInvocationParams` view sees them.
 *
 * Drift guard: the reconcile gate reddens whenever a handler-backed family
 * gains an http binding without a matching entry here (its advertised path
 * would resolve to no route), so a new family's REST paths must be added to
 * GATEWAY_REST_ROUTES in the same change.
 */

interface GatewayRestRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly methodId: string;
}

/** Build a route entry from an `/api/{param}/...`-style template. */
function route(method: string, template: string, methodId: string): GatewayRestRoute {
  const paramNames: string[] = [];
  const pattern = template.replace(/\{([^/}]+)\}/g, (_match, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, regex: new RegExp(`^${pattern}$`), paramNames, methodId };
}

/**
 * The explicit REST route table. Every entry is a path a gateway verb
 * descriptor advertises in its http binding; keep this in lockstep with those
 * bindings (the reconcile gate enforces it).
 */
export const GATEWAY_REST_ROUTES: readonly GatewayRestRoute[] = [
  // skills.*
  route('GET', '/api/skills', 'skills.list'),
  route('POST', '/api/skills', 'skills.create'),
  route('GET', '/api/skills/{name}', 'skills.get'),
  route('DELETE', '/api/skills/{name}', 'skills.delete'),
  route('POST', '/api/skills/{name}/update', 'skills.update'),
  // principals.*
  route('GET', '/api/principals', 'principals.list'),
  route('POST', '/api/principals', 'principals.create'),
  route('POST', '/api/principals/resolve', 'principals.resolve'),
  route('GET', '/api/principals/{principalId}', 'principals.get'),
  route('DELETE', '/api/principals/{principalId}', 'principals.delete'),
  route('POST', '/api/principals/{principalId}/update', 'principals.update'),
  // checkin.*
  route('GET', '/api/checkin/config', 'checkin.config.get'),
  route('POST', '/api/checkin/config', 'checkin.config.set'),
  route('GET', '/api/checkin/receipts', 'checkin.receipts.list'),
  route('POST', '/api/checkin/run', 'checkin.run'),
  // ci.*
  route('POST', '/api/ci/status', 'ci.status'),
  route('GET', '/api/ci/watches', 'ci.watches.list'),
  route('POST', '/api/ci/watches', 'ci.watches.create'),
  route('DELETE', '/api/ci/watches/{watchId}', 'ci.watches.delete'),
  route('POST', '/api/ci/watches/{watchId}/run', 'ci.watches.run'),
  // channels.profiles.*
  route('GET', '/api/channels/profiles', 'channels.profiles.list'),
  route('POST', '/api/channels/profiles', 'channels.profiles.set'),
  route('GET', '/api/channels/profiles/{surfaceKind}', 'channels.profiles.get'),
  route('DELETE', '/api/channels/profiles/{surfaceKind}', 'channels.profiles.delete'),
  // workspaces.* (registered-workspace registry)
  route('GET', '/api/workspaces/registrations', 'workspaces.registrations.list'),
  route('POST', '/api/workspaces/registrations', 'workspaces.registrations.add'),
  route('DELETE', '/api/workspaces/registrations', 'workspaces.registrations.remove'),
  route('POST', '/api/workspaces/resolve', 'workspaces.resolve'),
  // sessions.permissionMode.* + sessions.contextUsage.get
  route('GET', '/api/sessions/{sessionId}/permission-mode', 'sessions.permissionMode.get'),
  route('POST', '/api/sessions/{sessionId}/permission-mode', 'sessions.permissionMode.set'),
  route('GET', '/api/sessions/{sessionId}/context-usage', 'sessions.contextUsage.get'),
  // stepup.* — relay WebAuthn step-up ceremony (register a credential, mint a
  // challenge). Both handler-backed gateway verbs with an advertised REST path.
  route('POST', '/api/stepup/credentials', 'stepup.credentials.register'),
  route('POST', '/api/stepup/challenge', 'stepup.challenge.mint'),
];

/**
 * Dispatch a request against the gateway REST route table.
 *
 * Returns the handler's `Response` when a path+method entry matches, or `null`
 * when nothing matches (so the caller falls through to the rest of the route
 * chain / a 404). When the daemon has not wired `invokeGatewayRestVerb` (e.g. a
 * minimal embed), a matching path returns `null` rather than throwing — it
 * degrades to the same 404 the caller saw before these routes existed.
 */
export async function dispatchGatewayRestRoutes(
  req: Request,
  handlers: Partial<DaemonGatewayRestRouteHandlers>,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const method = req.method;
  for (const entry of GATEWAY_REST_ROUTES) {
    if (entry.method !== method) continue;
    const match = entry.regex.exec(pathname);
    if (!match) continue;
    if (typeof handlers.invokeGatewayRestVerb !== 'function') return null;
    const params: Record<string, string> = {};
    entry.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]!);
    });
    return handlers.invokeGatewayRestVerb({ methodId: entry.methodId, req, params });
  }
  return null;
}
