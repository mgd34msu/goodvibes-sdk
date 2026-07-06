/**
 * gateway-verb-error.ts
 *
 * (fleet.*, checkpoints.*, sessions.search — see CHANGELOG 1.0.0): a structured error for
 * gateway methods registered with a direct handler via
 * `GatewayMethodCatalog.register(descriptor, handler)`.
 *
 * WHY THIS EXISTS: `invokeGatewayMethodCall` (../../daemon/control-plane.ts)
 * dispatches a handler-bearing method via `catalog.invoke()` and, on ANY
 * thrown error, collapses it to a blanket `{ status: 500 }` — there was no
 * prior handler-registered verb that needed an honest non-500 status (the
 * only prior consumer of `register(descriptor, handler)` is the plugin API,
 * whose tool-call errors are swallowed into a `{success:false}` payload, not
 * an HTTP status). checkpoints.diff/restore need an honest 404 for an
 * unknown/gc'd checkpoint id (see routes/checkpoints.ts), and invalid
 * pagination cursors need an honest 400 (fleet.list, sessions.search) — a
 * blanket 500 would misreport caller error as server error.
 *
 * This mirrors the existing `SDKErrorCodes.SESSION_CLOSED` convention used by
 * the plain-REST session routes (`callOrSessionClosed`,
 * ../../../daemon-sdk/src/runtime-session-routes.ts), generalized to any
 * status/code pair instead of one hardcoded to 409/SESSION_CLOSED.
 */
export class GatewayVerbError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'GatewayVerbError';
    this.code = code;
    this.status = status;
  }
}

export function isGatewayVerbError(error: unknown): error is GatewayVerbError {
  return error instanceof GatewayVerbError;
}
