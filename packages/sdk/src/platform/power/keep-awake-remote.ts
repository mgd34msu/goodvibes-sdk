/**
 * keep-awake-remote.ts — forward the owner keep-awake toggle to an adopted
 * EXTERNAL daemon over the `power.keepAwake.set` gateway verb.
 *
 * In the external/adopted-daemon topology a surface's in-process `PowerManager`
 * is NOT the daemon's: it holds a LOCAL OS-level inhibitor that releases the
 * moment that process exits. The owner ruling is that keep-awake is
 * daemon-held — it must survive a surface closing. The config file does not
 * carry it across surfaces (`power.keepAwake` is a plain surface-local config
 * key, not one of the shared-config-tier keys), so the toggle is forwarded to
 * the daemon over the wire instead — best-effort, gated on reachability.
 *
 * Written in raw-REST style deliberately, matching every other version-tolerant
 * wire mirror in this platform (session/memory spine REST transports,
 * `session-registration`-style helpers): request/response only, a Bearer
 * token, an AbortController timeout, and the same
 * ok/auth_required/route_unavailable/host_unavailable/error classification —
 * NOT the typed operator SDK client, since `power.keepAwake.set` is a ws-only
 * gateway verb (`attachWsOnlyGatewayVerbHandlers`), not part of the operator
 * contract.
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ──────────────────────────
 *
 * Both the TUI (`runtime/power-keepawake-remote.ts`) and the agent
 * (`agent/power-keep-awake-remote.ts`) carried independent forward helpers.
 * The agent's is the superset adopted here: it classifies wire failures into a
 * discriminated result instead of swallowing every error silently, and it
 * takes its reachability probe and connection resolver as injected
 * dependencies rather than reaching into a surface-local RPC resolver — which
 * is what makes it portable into the SDK at all. The TUI's version additionally
 * wires a `ConfigManager` subscription (so all three toggle origins — the
 * `/power` command, Alt+A, and the settings modal — forward through one seam)
 * and a `power.status.get` poll for the status chip; both of those are
 * surface-specific composition and stay local to each consumer, not part of
 * this hoist.
 */

export type PowerKeepAwakeRemoteFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_route_unavailable'
  | 'connected_host_error';

export interface PowerKeepAwakeRemoteConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
}

export const POWER_KEEP_AWAKE_SET_PATH = '/api/power/keep-awake';
/** Best-effort background forward; short so it never blocks a settings-modal apply. */
export const POWER_KEEP_AWAKE_SET_TIMEOUT_MS = 1500;

export interface PowerKeepAwakeRemoteSuccess {
  readonly ok: true;
}

export interface PowerKeepAwakeRemoteFailure {
  readonly ok: false;
  readonly kind: PowerKeepAwakeRemoteFailureKind;
  readonly status?: number;
  readonly error: string;
}

export type PowerKeepAwakeRemoteResult = PowerKeepAwakeRemoteSuccess | PowerKeepAwakeRemoteFailure;

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Identical failure classification to the platform's other raw-REST wire mirrors. */
function classifyHttpFailure(status: number, body: unknown): PowerKeepAwakeRemoteFailure {
  const detail = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  return {
    ok: false,
    status,
    kind: status === 401 || status === 403
      ? 'auth_required'
      : status === 404
        ? 'connected_host_route_unavailable'
        : 'connected_host_error',
    error: `HTTP ${status}${detail ? `: ${detail}` : ''}`,
  };
}

/**
 * Forward the owner keep-awake toggle to the adopted daemon's gateway. Never
 * throws — every failure mode (no token on disk, network down, an
 * incompatible/pre-power-verb daemon, a real server error) returns a
 * discriminated failure the caller logs and degrades from; the caller decides
 * whether to also apply locally.
 */
export async function postPowerKeepAwakeSet(
  connection: PowerKeepAwakeRemoteConnection,
  enabled: boolean,
  options: { readonly timeoutMs?: number } = {},
): Promise<PowerKeepAwakeRemoteResult> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: connection.tokenPath
        ? `no connected-host operator token found at ${connection.tokenPath}`
        : 'no connected-host operator token found',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? POWER_KEEP_AWAKE_SET_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.baseUrl}${POWER_KEEP_AWAKE_SET_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled }),
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(response.status, body);
    return { ok: true };
  } catch (error) {
    return { ok: false, kind: 'connected_host_unavailable', error: summarizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ForwardKeepAwakeDeps {
  /** The existing daemon-adoption signal — reuse a session-spine client's probeReachability() in production. */
  readonly probeReachability: () => Promise<'unknown' | 'online' | 'offline'>;
  readonly resolveConnection: () => PowerKeepAwakeRemoteConnection;
  readonly post?: typeof postPowerKeepAwakeSet;
}

export type ForwardKeepAwakeOutcome =
  | { readonly attempted: false }
  | { readonly attempted: true; readonly result: PowerKeepAwakeRemoteResult };

/**
 * Forward power.keepAwake to the adopted daemon ONLY when a daemon is
 * actually reachable right now — an unreachable/unknown daemon means there is
 * nothing durable to hold the toggle for this process anyway, so this is a
 * clean no-op (`attempted: false`) rather than a wasted network call. Never
 * throws: a reachability probe rejection is treated the same as "not
 * reachable" (best-effort — a live keep-awake apply must never take down the
 * settings-modal apply path it is called from).
 */
export async function forwardKeepAwakeToAdoptedDaemon(
  enabled: boolean,
  deps: ForwardKeepAwakeDeps,
): Promise<ForwardKeepAwakeOutcome> {
  const post = deps.post ?? postPowerKeepAwakeSet;
  let reachable: 'unknown' | 'online' | 'offline';
  try {
    reachable = await deps.probeReachability();
  } catch {
    reachable = 'offline';
  }
  if (reachable !== 'online') return { attempted: false };
  const result = await post(deps.resolveConnection(), enabled);
  return { attempted: true, result };
}
