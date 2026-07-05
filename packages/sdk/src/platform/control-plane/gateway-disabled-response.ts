/**
 * gateway-disabled-response.ts
 *
 * The actionable body returned by the control-plane gateway's streaming/live entry points
 * (createEventStream, renderWebUi) when the `control-plane-gateway` feature flag is explicitly
 * turned off. The flag defaults ON (see runtime/feature-flags/flags.ts), so this only reaches
 * an operator who deliberately disabled it — hence the response NAMES the flag and tells them
 * how to restore streaming instead of being a bare 503 dead end.
 *
 * Kept in its own module so the (grandfathered, shrink-only) gateway.ts does not grow.
 */

/** The feature-flag id that gates the control-plane gateway's live/streaming surface. */
export const CONTROL_PLANE_GATEWAY_FLAG_ID = 'control-plane-gateway';

export interface GatewayDisabledResponseBody {
  readonly error: string;
  readonly featureFlag: string;
  readonly hint: string;
}

export function buildGatewayDisabledResponseBody(): GatewayDisabledResponseBody {
  return {
    error: `${CONTROL_PLANE_GATEWAY_FLAG_ID} feature flag is disabled`,
    featureFlag: CONTROL_PLANE_GATEWAY_FLAG_ID,
    hint:
      'Live streaming, event broadcast, and the web UI are turned off for this daemon because '
      + `the "${CONTROL_PLANE_GATEWAY_FLAG_ID}" feature flag was disabled in config. `
      + `Remove the \`flags: { "${CONTROL_PLANE_GATEWAY_FLAG_ID}": "disabled" }\` override `
      + '(the flag defaults to enabled) to restore SSE/WebSocket streaming. Request/response '
      + 'method calls remain available regardless of this flag.',
  };
}
