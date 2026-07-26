/**
 * control-plane-base-url.ts — derive where the daemon listens, rather than
 * storing it.
 *
 * `controlPlane.baseUrl` has no writers. Four call sites set `hostMode` / `host`
 * / `port` without touching it, so the stored string drifts on three axes at
 * once: the port (daemon on 8443 while the stored URL says 3421), the scheme
 * (TLS enabled while the stored URL says http), and the host (a value typed in
 * once and passed through verbatim afterwards). A stored mirror of derivable
 * state is a second source of truth, and the second one is always the stale one.
 *
 * So this module derives the URL from the binding that actually decides it —
 * `hostMode` + `host` + `port` + `tls.mode` — and offers a comparison helper so
 * a host can say loudly at boot when a stored URL disagrees with the real bind.
 *
 * A genuinely external address (a tunnel, a reverse proxy) is NOT derivable and
 * is not this function's job: that is a declaration, and it belongs in an
 * explicit override, never in a field that also pretends to mirror the bind.
 */

/** Who the URL is for: this machine, or something off-box. */
export type BaseUrlAudience = 'loopback' | 'external';

export interface ControlPlaneBinding {
  /** 'local' | 'network' | 'custom'. */
  readonly hostMode: string;
  readonly host: string;
  readonly port: number;
  /** `controlPlane.tls.mode`; anything other than 'off' means https. */
  readonly tlsMode: string;
  /**
   * An explicitly declared external address (tunnel / proxy). Only used for the
   * 'external' audience, and never inferred from the bind.
   */
  readonly publicBaseUrl?: string | undefined;
}

/** The port the daemon falls back to when none is configured. */
export const DEFAULT_CONTROL_PLANE_PORT = 3421;

/** Read a binding from any `get(key)` config reader. */
export function readControlPlaneBinding(
  read: (key: string) => unknown,
  prefix = 'controlPlane',
): ControlPlaneBinding {
  const rawPort = read(`${prefix}.port`);
  const port = typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0
    ? Math.trunc(rawPort)
    : DEFAULT_CONTROL_PLANE_PORT;
  const publicBaseUrl = read(`${prefix}.publicBaseUrl`);
  return {
    hostMode: typeof read(`${prefix}.hostMode`) === 'string' ? read(`${prefix}.hostMode`) as string : 'local',
    host: typeof read(`${prefix}.host`) === 'string' ? read(`${prefix}.host`) as string : '127.0.0.1',
    port,
    tlsMode: typeof read(`${prefix}.tls.mode`) === 'string' ? read(`${prefix}.tls.mode`) as string : 'off',
    ...(typeof publicBaseUrl === 'string' && publicBaseUrl.trim() ? { publicBaseUrl: publicBaseUrl.trim() } : {}),
  };
}

/**
 * The host a client on THIS machine should dial.
 *
 * A wildcard bind (`0.0.0.0` / `::`) is not an address anything can connect to;
 * it means "every interface", and the loopback interface is one of them. This
 * is the substitution the old stored URL never made, which is why a
 * network-mode daemon's stored base URL was unusable as a dial target.
 */
function loopbackHostFor(binding: ControlPlaneBinding): string {
  if (binding.hostMode === 'local') return '127.0.0.1';
  if (binding.hostMode === 'custom' && binding.host.trim() && !isWildcardHost(binding.host)) {
    return binding.host.trim();
  }
  if (isWildcardHost(binding.host) || !binding.host.trim()) return '127.0.0.1';
  return binding.host.trim();
}

function isWildcardHost(host: string): boolean {
  const trimmed = host.trim();
  return trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '[::]' || trimmed === '*';
}

/** `https` whenever TLS is on; the scheme follows the bind, never a stored string. */
export function controlPlaneScheme(binding: ControlPlaneBinding): 'http' | 'https' {
  return binding.tlsMode && binding.tlsMode !== 'off' ? 'https' : 'http';
}

/**
 * Derive the control-plane base URL for an audience. For 'external', an
 * explicitly declared `publicBaseUrl` wins — it is the one case the bind cannot
 * describe. Everything else is computed, so it cannot go stale.
 */
export function deriveControlPlaneBaseUrl(
  binding: ControlPlaneBinding,
  audience: BaseUrlAudience = 'loopback',
): string {
  if (audience === 'external' && binding.publicBaseUrl) {
    return binding.publicBaseUrl.replace(/\/+$/, '');
  }
  const host = loopbackHostFor(binding);
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${controlPlaneScheme(binding)}://${bracketed}:${binding.port}`;
}

/**
 * Compare the URL clients are handed against the host/port the daemon ACTUALLY
 * bound. Returns a message when they disagree, so a host can log it loudly at
 * boot: the daemon logs its real bind today and never compares it to anything.
 *
 * Two separate resolvers decide these values — the bind path resolves
 * hostMode/host/port, and the client-facing URL is derived here — so a
 * disagreement means the daemon is handing out an address it does not answer
 * on, which is the "two different click hosts from one daemon" symptom.
 *
 * A declared `publicBaseUrl` is deliberately NOT compared: an external tunnel
 * or proxy address is SUPPOSED to differ from the bind, and flagging it would
 * train people to ignore this warning.
 */
export function describeDerivedBindMismatch(
  actual: { readonly host: string; readonly port: number },
  binding: ControlPlaneBinding,
): string | null {
  const expectedHost = loopbackHostFor(binding);
  if (actual.host === expectedHost && actual.port === binding.port) return null;
  // A wildcard bind is reported by the bind path as 0.0.0.0 while the derived
  // dial target is loopback — that substitution is deliberate, not drift.
  if (isWildcardHost(actual.host) && expectedHost === '127.0.0.1' && actual.port === binding.port) return null;
  const derived = deriveControlPlaneBaseUrl(binding, 'loopback');
  return `control-plane clients are handed ${derived}, but the daemon actually bound `
    + `${actual.host}:${actual.port}. One of these is wrong, and anything given the first `
    + 'will dial a place this daemon does not answer.';
}

/**
 * Compare a STORED base URL against the derived one. Returns a message when
 * they disagree, so a host can log it loudly at boot — the daemon logs its real
 * bind today and never compares it to the value clients are handed.
 */
export function describeBaseUrlDrift(
  stored: string | undefined,
  binding: ControlPlaneBinding,
): string | null {
  const trimmed = stored?.trim();
  if (!trimmed) return null;
  const derived = deriveControlPlaneBaseUrl(binding, 'loopback');
  if (trimmed.replace(/\/+$/, '') === derived) return null;
  return `controlPlane.baseUrl is stored as ${trimmed} but the daemon actually binds `
    + `${binding.hostMode}/${binding.host}:${binding.port} with tls ${binding.tlsMode}, which is ${derived}. `
    + 'The stored value is a stale mirror of derivable state — clients handed it will dial the wrong place. '
    + 'Declare a genuinely external address in controlPlane.publicBaseUrl instead.';
}
