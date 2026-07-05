/**
 * routes/invocation-params.ts
 *
 * W3-S2 (post-S1 alignment) — one params view for the handler-registered
 * verbs (fleet.*, checkpoints.*, sessions.search).
 *
 * S1's invoke-layer input gate (invoke-input-validation.ts, wired in
 * daemon/control-plane.ts invokeGatewayMethodCall) validates the invoke BODY
 * against a handler verb's typed inputSchema — a method with no http binding
 * is body-carrying by that gate's definition. So the BODY is the canonical,
 * schema-validated params channel for these verbs, and callers should put
 * params there.
 *
 * The generic invoke envelope ({ query?, body }) still carries a `query`
 * record, so this helper folds it in as a FALLBACK (body keys win). Query-
 * supplied values bypass S1's schema gate, but every one of these handlers
 * performs its own full validation with honest 400s (GatewayVerbError), so
 * nothing unchecked reaches a manager either way.
 */
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Merged params for a handler-registered verb: query as fallback, body wins. */
export function readInvocationParams(invocation: GatewayMethodInvocation): Record<string, unknown> {
  return { ...asRecord(invocation.query), ...asRecord(invocation.body) };
}
