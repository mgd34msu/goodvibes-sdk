/**
 * host-resolver.ts — the ONE truth for daemon bind-address + port resolution.
 *
 * Both resolvers carry an explicit `recognized` flag: an unrecognized or
 * malformed stored value never falls through to undefined behavior. The safe
 * fallback is always the LOCAL posture ('127.0.0.1' / the server-type default
 * port) — a config typo must never accidentally bind 0.0.0.0 or port NaN.
 * Consumers that display the binding anchor to this resolver instead of
 * re-deriving their own defensive copies of the raw stored values.
 */

export interface ResolvedHostBinding {
  readonly host: string;
  readonly port: number;
  /**
   * False when the stored hostMode was not one of 'local' | 'network' |
   * 'custom' (after trimming/lowercasing) and the safe local fallback was
   * applied. Surfaces show the honest "unrecognized value" state from this.
   */
  readonly recognized: boolean;
  /** The mode actually applied ('local' when unrecognized). */
  readonly effectiveMode: 'local' | 'network' | 'custom';
}

const DEFAULT_PORTS = {
  controlPlane: 3421,
  httpListener: 3422,
  web: 3423,
} as const;

/** Validated TCP port, or null when out of range / non-numeric / zero. */
function validPort(value: number): number | null {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

export function resolveHostBinding(
  hostMode: string,
  customHost: string,
  customPort: number,
  serverType: 'controlPlane' | 'httpListener' | 'web',
): ResolvedHostBinding {
  // hostMode decides the bind address. Port is always caller-controlled — a
  // configured (valid) customPort takes precedence, and only falls back to the
  // server-type default when unset/zero/invalid. Reverting this rule would
  // force every localhost-bound test/dev setup into 'custom' mode.
  const port = validPort(customPort) ?? DEFAULT_PORTS[serverType];
  // Normalize before matching so ' local ', 'Network', 'LAN' etc. resolve to a
  // deliberate posture instead of undefined fall-through.
  const normalized = hostMode.trim().toLowerCase();
  switch (normalized) {
    case 'local':
      return { host: '127.0.0.1', port, recognized: true, effectiveMode: 'local' };
    case 'network':
      return { host: '0.0.0.0', port, recognized: true, effectiveMode: 'network' };
    case 'custom':
      return { host: customHost || '127.0.0.1', port, recognized: true, effectiveMode: 'custom' };
    default:
      // Unrecognized value ('LAN', '', a typo): the SAFE posture is local-only.
      // recognized:false lets consumers surface the honest state instead of
      // silently rendering a mode the daemon never applied.
      return { host: '127.0.0.1', port, recognized: false, effectiveMode: 'local' };
  }
}

export interface ResolvedWebBinding {
  readonly host: string;
  readonly port: number;
  /** False when a stored value was invalid/unrecognized and a fallback applied. */
  readonly recognized: boolean;
  readonly effectiveMode: 'local' | 'network' | 'custom';
}

/**
 * The web endpoint's binding resolver — the same shape and fallback semantics
 * as {@link resolveHostBinding}, so surface-registry announcements, channel
 * account links, and the tailscale-serve verb all anchor to one truth instead
 * of each reading the raw stored values (`Number(raw ?? 3423)` let 0 stay 0
 * and non-numeric stay NaN).
 */
export function resolveWebBinding(input: {
  readonly hostMode?: unknown;
  readonly host?: unknown;
  readonly port?: unknown;
}): ResolvedWebBinding {
  const portNumber = typeof input.port === 'number' ? input.port : Number(input.port ?? DEFAULT_PORTS.web);
  const portValid = validPort(portNumber) !== null;
  const binding = resolveHostBinding(
    typeof input.hostMode === 'string' ? input.hostMode : 'local',
    typeof input.host === 'string' ? input.host : '',
    portValid ? portNumber : 0,
    'web',
  );
  return {
    host: binding.host,
    port: binding.port,
    recognized: binding.recognized && portValid,
    effectiveMode: binding.effectiveMode,
  };
}

/** The validated web port (fallback 3423) — a convenience over {@link resolveWebBinding}. */
export function resolveWebPort(rawPort: unknown): number {
  return resolveWebBinding({ port: rawPort }).port;
}
