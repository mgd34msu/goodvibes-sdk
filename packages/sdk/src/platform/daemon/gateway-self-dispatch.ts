/**
 * gateway-self-dispatch.ts
 *
 * Guards the one way a gateway method can be dispatched into itself forever.
 *
 * `invokeGatewayMethodCall` has two arms. When the verb has a handler attached
 * it runs in process. When it does not, but the descriptor advertises an `http`
 * binding, the call falls through to `invokeWebSocketControlPlaneCall`, which
 * SYNTHESIZES a request to that advertised path and feeds it back into the real
 * router. That fallthrough exists for verbs whose implementation is a genuine
 * HTTP route living somewhere else in the router chain.
 *
 * It stopped being safe when the gateway REST table gained rows for the
 * handler-backed families. Those rows map the advertised path straight back to
 * the SAME methodId through `invokeGatewayRestVerb`, so for a verb with no
 * handler the synthesized request re-enters `invokeGatewayMethodCall`, takes
 * the same arm, and synthesizes again. Before the rows existed the synthesized
 * request 404'd and the loop ended in one hop, which is the "plain 404" the
 * route-reconcile module documents. Adding the rows closed the cycle.
 *
 * Observed on a 1.18.0 daemon composed without mail deps: one
 * `GET /api/email/inbox` produced 256 nested dispatches and then answered
 * `503 ws-call-overloaded, Daemon is at its concurrent WS-call cap (256)`.
 * Two things were wrong with that. The capability was not wired, which is a
 * 501 and a fixed answer, not a capacity problem that might clear on retry; and
 * a single request consumed the daemon's entire concurrent WS-call budget, so a
 * handful of them would starve every other caller. Anyone reading that message
 * would have gone looking at load, and load was never the problem.
 *
 * Two guards, deliberately independent:
 *
 *   - `isGatewayRestSelfDispatch` answers whether an advertised binding routes
 *     back to its own methodId. When it does, there is no other implementation
 *     to reach, so "no handler" is terminal and the caller is told so.
 *     This removes the cycle by construction.
 *
 *   - `SYNTHESIZED_DISPATCH_HEADER` marks a synthesized request with its depth.
 *     A synthesized request that reaches the REST arm again is a loop whatever
 *     produced it, and it is refused as one. This is depth-carried rather than
 *     path-keyed on purpose: two clients legitimately requesting the same path
 *     at the same moment are not a cycle, and a set keyed by path would call
 *     them one.
 */

import { GATEWAY_REST_ROUTES, SYNTHESIZED_DISPATCH_HEADER } from '@pellux/goodvibes-daemon-sdk';

export { SYNTHESIZED_DISPATCH_HEADER, readSynthesizedDispatchDepth } from '@pellux/goodvibes-daemon-sdk';

/**
 * The depth at which a synthesized dispatch is treated as a loop.
 *
 * One synthesis is the legitimate case: a handler-less verb reaching a real
 * HTTP route elsewhere in the chain. A second means the first landed back on
 * something that dispatches by methodId again, which no correct route does.
 */
export const MAX_SYNTHESIZED_DISPATCH_DEPTH = 1;

/**
 * True when `methodId`'s advertised binding is served by a gateway REST route
 * bound to that same methodId, i.e. dispatching it would re-enter the caller.
 */
export function isGatewayRestSelfDispatch(
  methodId: string,
  method: string,
  path: string,
): boolean {
  const wanted = method.toUpperCase();
  for (const entry of GATEWAY_REST_ROUTES) {
    if (entry.method !== wanted) continue;
    if (!entry.regex.test(path)) continue;
    return entry.methodId === methodId;
  }
  return false;
}

/**
 * The answer for a verb whose advertised path routes back to itself and whose
 * handler is not attached.
 *
 * Says which composition step is missing rather than only that the call
 * failed: every one of these verbs is registered by a composition that must be
 * handed its dependencies, and a daemon built without them is a normal,
 * supported configuration, not a fault to report as one.
 */
export function notWiredResponse(methodId: string): {
  status: number;
  ok: false;
  body: { error: string; code: string };
} {
  return {
    status: 501,
    ok: false,
    body: {
      error:
        `Gateway method is not invokable: ${methodId}. The descriptor is advertised and its route is real, `
        + 'but no handler is attached on this daemon, so the capability is not wired up in this composition. '
        + 'This is a fixed answer, not a transient one, retrying will not change it.',
      code: 'NOT_INVOKABLE',
    },
  };
}

/**
 * The answer for a synthesized request that re-entered the dispatcher, or
 * `null` when the depth is legitimate.
 *
 * Distinct from {@link notWiredResponse} on purpose: that one is a supported
 * configuration, this one is a routing defect in the daemon, and collapsing
 * them would hide the second behind the first.
 */
export function guardSynthesizedDepth(
  depth: number | undefined,
  methodId: string | undefined,
  path: string,
): { status: number; ok: false; body: { error: string; code: string } } | null {
  if ((depth ?? 0) <= MAX_SYNTHESIZED_DISPATCH_DEPTH) return null;
  return {
    status: 500,
    ok: false,
    body: {
      error:
        `Gateway dispatch loop for ${methodId ?? path} at ${path}: a synthesized request re-entered `
        + 'the dispatcher. Refused as a loop rather than allowed to consume the concurrent-call budget.',
      code: 'INTERNAL_ERROR',
    },
  };
}

/**
 * The answer when `methodId` has no handler and its advertised path routes
 * back to itself, or `null` when dispatching it is legitimate.
 */
export function guardSelfDispatch(
  methodId: string,
  method: string,
  path: string,
): { status: number; ok: false; body: { error: string; code: string } } | null {
  return isGatewayRestSelfDispatch(methodId, method, path) ? notWiredResponse(methodId) : null;
}
