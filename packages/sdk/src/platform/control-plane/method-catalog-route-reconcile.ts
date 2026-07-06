import { dispatchDaemonApiRoutes } from '@pellux/goodvibes-daemon-sdk';
import type { DaemonApiRouteHandlers } from '@pellux/goodvibes-daemon-sdk';
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';

/**
 * method-catalog-route-reconcile.ts
 *
 * Advertisement-vs-route reconciliation. Every method descriptor that
 * carries an `http` binding is a promise to a caller: "this daemon actually
 * serves this endpoint." Nothing previously checked that promise against
 * the real dispatch table. method-catalog-email.ts's four email.* methods
 * advertised /api/email/* paths that no route handler anywhere has ever
 * served, so a caller invoking one through the generic method-dispatch
 * endpoint (control-plane.ts's invokeGatewayMethodCall, which synthesizes a
 * request from `http.path` and feeds it back into the real router) got a
 * plain 404 instead of an honest "this capability isn't wired up." The ad
 * lied; only a caller's own skepticism about the 404 stood between it and
 * treating the capability as real.
 *
 * This module answers, for a batch of descriptors, whether each one's http
 * binding actually resolves against the real dispatch pipeline:
 * `dispatchDaemonApiRoutes` from @pellux/goodvibes-daemon-sdk, the function
 * DaemonHttpRouter.dispatchApiRoutes (packages/sdk/src/platform/daemon/http/
 * router.ts — read as this reconcile's route authority, never edited by it)
 * ultimately delegates to for every method-catalog family except a short
 * list of specialized sub-routers wired directly in router.ts ahead of that
 * delegation (see SPECIALIZED_SUB_ROUTER_PREFIXES). The probe dispatches a
 * synthetic Request against handler stubs that only ever return a fixed
 * marker Response — no real service, manager, or handler body ever runs, so
 * probing stays side-effect free even for `dangerous: true` write methods
 * (email.send, automation job mutation, etc.).
 *
 * Scope note (read before extending): dispatchDaemonApiRoutes covers the
 * operator / automation / remote / session / task route families, which is
 * most of the catalog (control-core, media, channels, remote, runtime,
 * knowledge). A handful of catalogs point at specialized sub-routers that
 * router.ts special-cases before it ever reaches dispatchDaemonApiRoutes
 * (MCP config, batch, Cloudflare, Home Assistant, model routes, companion
 * chat, project planning). This module has no evidence either way for
 * those paths, so it marks them 'unchecked' rather than guessing — a false
 * "unavailable" verdict would just be a different flavor of the same
 * dishonesty this module exists to catch.
 */

export type RouteReconcileStatus = 'live' | 'unavailable' | 'unchecked';

export interface RouteReconcileResult {
  readonly methodId: string;
  readonly status: RouteReconcileStatus;
  readonly http: { readonly method: string; readonly path: string } | null;
  readonly reason: string;
}

export type RouteProbe = (method: string, path: string) => boolean | Promise<boolean>;

/**
 * Path prefixes served by a specialized sub-router that router.ts dispatches
 * to BEFORE falling through to dispatchDaemonApiRoutes. Kept as an explicit,
 * short allowlist (not inferred) so growth here is a deliberate, reviewed
 * decision rather than silent scope creep.
 */
export const SPECIALIZED_SUB_ROUTER_PREFIXES: readonly string[] = [
  '/api/mcp',
  '/api/batch',
  '/api/cloudflare',
  '/api/homeassistant',
  '/api/models',
  '/api/companion/chat',
  '/api/projects/planning',
];

const RECONCILE_PROBE_MARKER = { reconcileProbeMarker: true };

function isSpecializedSubRouterPath(path: string): boolean {
  return SPECIALIZED_SUB_ROUTER_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Replaces every `{param}` template segment with an opaque single-segment
 * placeholder. Every path-matching regex in the dispatch chain matches "one
 * non-slash segment" for a param slot, so a placeholder resolves the same
 * way a real id would without needing one.
 */
function resolveTemplatePath(template: string): string {
  return template.replace(/\{[^/}]+\}/g, 'reconcile-probe-placeholder');
}

/**
 * Builds a dispatchDaemonApiRoutes-backed probe: does *any* route in the
 * operator/automation/remote/session/task dispatch chain match this
 * method+path? Every handler in the stub is inert — a Proxy that returns a
 * single marker function for any property access, so it never needs
 * updating when DaemonApiRouteHandlers gains a field (the exact kind of
 * drift this reconcile exists to avoid reintroducing elsewhere).
 */
export function createDaemonSdkRouteProbe(): RouteProbe {
  const marker = () => Response.json(RECONCILE_PROBE_MARKER);
  const inertHandlers = new Proxy(
    {},
    { get: () => marker },
  ) as unknown as DaemonApiRouteHandlers;

  return async (method, path) => {
    const request = new Request(`http://reconcile-probe.invalid${path}`, { method });
    const response = await dispatchDaemonApiRoutes(request, inertHandlers);
    return response !== null;
  };
}

/** Reconciles a single descriptor's http binding (if any) against a probe. */
export async function reconcileHttpDescriptor(
  descriptor: GatewayMethodDescriptor,
  probe: RouteProbe,
): Promise<RouteReconcileResult> {
  if (!descriptor.http) {
    return { methodId: descriptor.id, status: 'unchecked', http: null, reason: 'no http binding to reconcile' };
  }
  const http = { method: descriptor.http.method, path: descriptor.http.path };
  if (isSpecializedSubRouterPath(descriptor.http.path)) {
    return {
      methodId: descriptor.id,
      status: 'unchecked',
      http,
      reason: `path is served by a specialized sub-router outside this reconcile's checked scope: ${descriptor.http.path}`,
    };
  }
  const probePath = resolveTemplatePath(descriptor.http.path);
  const resolved = await probe(descriptor.http.method, probePath);
  return resolved
    ? { methodId: descriptor.id, status: 'live', http, reason: 'route resolved via dispatchDaemonApiRoutes' }
    : {
        methodId: descriptor.id,
        status: 'unavailable',
        http,
        reason: `no registered route serves ${descriptor.http.method} ${descriptor.http.path}`,
      };
}

/** Reconciles a full descriptor list against a probe, in catalog order. */
export async function reconcileCatalogRoutes(
  descriptors: readonly GatewayMethodDescriptor[],
  probe: RouteProbe,
): Promise<RouteReconcileResult[]> {
  const results: RouteReconcileResult[] = [];
  for (const descriptor of descriptors) {
    results.push(await reconcileHttpDescriptor(descriptor, probe));
  }
  return results;
}

/**
 * The regression gate. Every descriptor whose http binding was actually
 * checked (status !== 'unchecked') and resolved to no live route must
 * already be marked `invokable: false` at the source — i.e. the
 * advertisement itself must already say "don't call this" instead of
 * silently 404ing a caller who trusted it. Returns the ids that violate
 * that rule. A non-empty result means some descriptor is advertised as
 * live but isn't backed by a route, and isn't marked unavailable either —
 * an email.inbox.list-shaped regression. Wire this into a test (or a boot
 * self-check, once one exists) and fail loudly on a non-empty result.
 */
export function findUnreconciledAdvertisements(
  descriptors: readonly GatewayMethodDescriptor[],
  results: readonly RouteReconcileResult[],
): string[] {
  const descriptorsById = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor] as const));
  const violations: string[] = [];
  for (const result of results) {
    if (result.status !== 'unavailable') continue;
    const descriptor = descriptorsById.get(result.methodId);
    if (descriptor && descriptor.invokable !== false) {
      violations.push(result.methodId);
    }
  }
  return violations;
}
