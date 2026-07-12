/**
 * gateway-disabled-response.ts
 *
 * The actionable body returned by the control-plane gateway's streaming/live entry points
 * (createEventStream, renderWebUi) when the gateway is explicitly turned off via the
 * controlPlane.gateway setting. The setting defaults ON (a stock daemon streams), so this only
 * reaches an operator who deliberately disabled it — hence the response NAMES the setting and
 * tells them how to restore streaming instead of being a bare 503 dead end.
 *
 * Kept in its own module so the (grandfathered, shrink-only) gateway.ts does not grow.
 */

/** The internal capability id that gates the control-plane gateway's live/streaming surface. */
export const CONTROL_PLANE_GATEWAY_FLAG_ID = 'control-plane-gateway';

/** The settings key that controls the gateway. */
export const CONTROL_PLANE_GATEWAY_SETTING = 'controlPlane.gateway';

export interface GatewayDisabledResponseBody {
  readonly error: string;
  /** The settings key an operator flips to restore streaming. */
  readonly setting: string;
  readonly hint: string;
}

export function buildGatewayDisabledResponseBody(): GatewayDisabledResponseBody {
  return {
    error: `the control-plane gateway is turned off (${CONTROL_PLANE_GATEWAY_SETTING})`,
    setting: CONTROL_PLANE_GATEWAY_SETTING,
    hint:
      'Live streaming, event broadcast, and the web UI are turned off for this daemon because '
      + `the ${CONTROL_PLANE_GATEWAY_SETTING} setting was disabled in config. `
      + `Set ${CONTROL_PLANE_GATEWAY_SETTING} back to true (its default) to restore `
      + 'SSE/WebSocket streaming. Request/response method calls remain available regardless '
      + 'of this setting.',
  };
}
