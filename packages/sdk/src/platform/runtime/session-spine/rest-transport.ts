/**
 * rest-transport.ts — the session-spine's raw-REST `SpineTransport`.
 *
 * A hand-rolled REST mirror of the daemon's `sessions.register` /
 * `sessions.close` HTTP routes (`POST /api/sessions/register`,
 * `POST /api/sessions/{sessionId}/close` — see
 * `method-catalog-control-core.ts`), written request/response only with a
 * Bearer token and an `AbortController` timeout, deliberately NOT the typed
 * operator SDK client. "Version-tolerant" here means tolerant of the ADOPTED
 * DAEMON's version, not this package's: a consumer can attach to a daemon
 * that predates one of these routes, and every response is classified from
 * its actual HTTP status rather than assumed present — a 404 becomes an
 * honest `connected_host_route_unavailable` rather than a thrown parse error.
 *
 * ── Hoist provenance (2026-07-30 daemon/TUI split) ──────────────────────────
 *
 * Both the TUI (`session-spine-transport.ts`, a thin fold over the SDK's own
 * typed operator client) and the agent (`session-spine-rest-transport.ts`,
 * this raw-REST mirror plus a probe and a receipt consumer) carried a
 * `SpineTransport` implementation. The agent's is the superset adopted here:
 * it folds failures into THREE outcomes (`ok`/`offline`/`rejected`) instead
 * of the TUI's two (`ok`/`offline`, which treats every failure — including a
 * durable auth/route rejection — as a transient connectivity fault the spine
 * client will retry forever), and it supplies a reachability probe and a
 * daemon-receipt consumer the TUI's thinner adapter did not need because it
 * already had a live, in-process typed client for those concerns. Kept out
 * of this hoist: the agent's `createSpineConnectionResolver` (reads a
 * connected-host token file from a specific home directory — a consumer
 * trust-boundary concern the SDK core deliberately never reaches into; a
 * consumer builds its own `resolveConnection` and passes it in here).
 */
import type { RegisterSharedSessionInput, SharedSessionRecord } from '../../control-plane/session-types.js';
import { readClientCompatibilityFloor } from '../../control-plane/client-compatibility.js';
import type { DaemonReceipt } from '../../daemon/receipts.js';
import type { SpineResult, SpineTransport } from './client.js';

const DEFAULT_REGISTER_TIMEOUT_MS = 1_500;
const DEFAULT_CLOSE_TIMEOUT_MS = 500;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

export interface SessionSpineRestConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly tokenPath?: string;
}

export type SessionSpineRestFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_route_unavailable'
  | 'connected_host_error';

export interface SessionSpineRestFailure {
  readonly ok: false;
  readonly kind: SessionSpineRestFailureKind;
  readonly status?: number;
  readonly error: string;
}

export interface SessionSpineRegisterSuccess {
  readonly ok: true;
  readonly reopened: boolean;
  readonly conflict?: { readonly status: 'closed' };
  readonly session?: SharedSessionRecord;
}

export type SessionSpineRegisterResult = SessionSpineRegisterSuccess | SessionSpineRestFailure;
export type SessionSpineCloseResult = { readonly ok: true; readonly session: SharedSessionRecord | null } | SessionSpineRestFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** 401/403 -> auth; 404 -> a route this daemon does not serve; anything else -> a generic host error. */
function classifyHttpFailure(status: number, body: unknown): SessionSpineRestFailure {
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

function missingTokenFailure(connection: SessionSpineRestConnection): SessionSpineRestFailure {
  return {
    ok: false,
    kind: 'auth_required',
    error: connection.tokenPath
      ? `no connected-host operator token found at ${connection.tokenPath}`
      : 'no connected-host operator token found',
  };
}

/** Idempotently register (or heartbeat) a shared session over `POST /api/sessions/register`. */
export async function postSessionSpineRegister(
  connection: SessionSpineRestConnection,
  input: RegisterSharedSessionInput,
  options: { readonly timeoutMs?: number } = {},
): Promise<SessionSpineRegisterResult> {
  if (!connection.token) return missingTokenFailure(connection);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.baseUrl}/api/sessions/register`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(response.status, body);
    const record = isRecord(body) ? body : {};
    return {
      ok: true,
      reopened: record.reopened === true,
      ...(isRecord(record.conflict) && record.conflict.status === 'closed' ? { conflict: { status: 'closed' as const } } : {}),
      ...(isRecord(record.session) ? { session: record.session as unknown as SharedSessionRecord } : {}),
    };
  } catch (error) {
    return { ok: false, kind: 'connected_host_unavailable', error: summarizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Close a shared session over `POST /api/sessions/{sessionId}/close`. */
export async function postSessionSpineClose(
  connection: SessionSpineRestConnection,
  sessionId: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<SessionSpineCloseResult> {
  if (!connection.token) return missingTokenFailure(connection);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.token}` },
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    if (!response.ok) return classifyHttpFailure(response.status, body);
    const record = isRecord(body) ? body : {};
    return { ok: true, session: isRecord(record.session) ? (record.session as unknown as SharedSessionRecord) : null };
  } catch (error) {
    return { ok: false, kind: 'connected_host_unavailable', error: summarizeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Folds the REST mirror's richer failure vocabulary onto `SessionSpineClient`'s
 * ok/offline/rejected outcome: `ok` stays `ok`; `connected_host_unavailable`
 * (a transient connectivity fault) becomes `offline` so the client enqueues
 * for reconnect replay; every DURABLE refusal (`auth_required`,
 * `connected_host_route_unavailable`, `connected_host_error`) becomes
 * `rejected` so the client logs it and never retries forever.
 */
function foldSpineResult(result: SessionSpineRegisterResult | SessionSpineCloseResult): SpineResult {
  if (result.ok) return { outcome: 'ok' };
  if (result.kind === 'connected_host_unavailable') return { outcome: 'offline', error: result.error };
  return { outcome: 'rejected', error: result.error };
}

export interface SessionSpineRestTransportOptions {
  readonly resolveConnection: () => SessionSpineRestConnection;
  readonly registerTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
}

/** Build the `SpineTransport` injected into `SessionSpineClient` at construction (live-immediately mode). */
export function createSessionSpineRestTransport(options: SessionSpineRestTransportOptions): SpineTransport {
  const registerTimeoutMs = options.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  return {
    async register(input: RegisterSharedSessionInput): Promise<SpineResult> {
      const connection = options.resolveConnection();
      const result = await postSessionSpineRegister(connection, input, { timeoutMs: registerTimeoutMs });
      return foldSpineResult(result);
    },
    async close(sessionId: string): Promise<SpineResult> {
      const connection = options.resolveConnection();
      const result = await postSessionSpineClose(connection, sessionId, { timeoutMs: closeTimeoutMs });
      return foldSpineResult(result);
    },
  };
}

async function defaultProbe(
  connection: SessionSpineRestConnection,
  timeoutMs: number,
  onDaemonFloor?: (floor: string | undefined) => void,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Any HTTP response (even 401) means the host answered -> reachable. Auth
    // is a separate concern surfaced by register/close results, not the probe.
    // This is a LIVENESS read only: a plain /status read never delivers (or
    // marks delivered) the daemon's undelivered honesty receipts.
    const response = await fetch(`${connection.baseUrl}/status`, {
      ...(connection.token ? { headers: { authorization: `Bearer ${connection.token}` } } : {}),
      signal: controller.signal,
    });
    onDaemonFloor?.(readClientCompatibilityFloor(response.headers));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface SessionSpineRestProbeOptions {
  readonly resolveConnection: () => SessionSpineRestConnection;
  readonly probeTimeoutMs?: number;
  /** Override for tests; default does a short plain GET {baseUrl}/status. */
  readonly probeImpl?: (
    connection: SessionSpineRestConnection,
    timeoutMs: number,
    onDaemonFloor?: (floor: string | undefined) => void,
  ) => Promise<boolean>;
  /**
   * Receives the minimum client build the daemon announced on this read
   * (`X-Goodvibes-Client-Floor`), or undefined when it announced none. Wire
   * this to a client-build compatibility guard that pauses shared-session
   * work when this process is below the floor.
   */
  readonly onDaemonFloor?: ((floor: string | undefined) => void) | undefined;
}

/**
 * Builds the zero-argument `probe` `SessionSpineClient.probeReachability()`
 * calls directly (its injected-probe shape takes no parameters — the client
 * has no connection to hand it). Liveness only — receipt consumption is
 * {@link createSessionSpineReceiptConsumer}, not this.
 */
export function createSessionSpineRestProbe(options: SessionSpineRestProbeOptions): () => Promise<boolean> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeImpl = options.probeImpl ?? defaultProbe;
  return () => probeImpl(options.resolveConnection(), probeTimeoutMs, options.onDaemonFloor);
}

/** Parse the `receipts` array off a `/status` response body; `[]` when absent/malformed. */
export function extractSessionSpineReceipts(body: unknown): DaemonReceipt[] {
  if (!isRecord(body) || !Array.isArray(body.receipts)) return [];
  const parsed: DaemonReceipt[] = [];
  for (const entry of body.receipts) {
    if (!isRecord(entry)) continue;
    const { id, text, at } = entry as { id?: unknown; text?: unknown; at?: unknown };
    if (typeof id !== 'string' || id.length === 0 || typeof text !== 'string' || text.length === 0) continue;
    parsed.push({ id, text, at: typeof at === 'number' ? at : Date.now() });
  }
  return parsed;
}

async function defaultConsumeReceipts(
  connection: SessionSpineRestConnection,
  timeoutMs: number,
): Promise<readonly DaemonReceipt[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${connection.baseUrl}/status`);
    url.searchParams.set('receipts', 'consume');
    const response = await fetch(url, {
      ...(connection.token ? { headers: { authorization: `Bearer ${connection.token}` } } : {}),
      signal: controller.signal,
    });
    if (!response.ok) return [];
    try {
      return extractSessionSpineReceipts(await response.json());
    } catch {
      return [];
    }
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface SessionSpineReceiptConsumerOptions {
  readonly resolveConnection: () => SessionSpineRestConnection;
  readonly consumeTimeoutMs?: number;
  /** Override for tests; default does a short GET {baseUrl}/status?receipts=consume. */
  readonly consumeImpl?: (
    connection: SessionSpineRestConnection,
    timeoutMs: number,
  ) => Promise<readonly DaemonReceipt[]>;
}

/**
 * Builds the zero-argument receipt consumer a consumer invokes once per
 * attach. Delivery is destructive at the daemon (served exactly once), so
 * this must be called on attach only — never on the frequent liveness probe
 * cadence above.
 */
export function createSessionSpineReceiptConsumer(
  options: SessionSpineReceiptConsumerOptions,
): () => Promise<readonly DaemonReceipt[]> {
  const consumeTimeoutMs = options.consumeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const consumeImpl = options.consumeImpl ?? defaultConsumeReceipts;
  return () => consumeImpl(options.resolveConnection(), consumeTimeoutMs);
}
