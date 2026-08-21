/**
 * daemon-config-route.ts, where a config write goes, and what happens when the
 * owning runtime cannot be reached.
 *
 * This is the single place that answers "who writes this key". Callers hand it
 * a key and a value; it decides by OWNERSHIP (config-ownership.ts), not by
 * which product is asking:
 *
 *   - client-owned / user-level  → the local config manager, as always.
 *   - daemon-owned, and this process IS the daemon → the local config manager,
 *     which persists into the daemon tier. The owning runtime is right here.
 *   - daemon-owned, and a daemon is RUNNING elsewhere → the daemon's own
 *     `POST /config` route. Never the local file: a file path cannot cross a
 *     host boundary, and a client that writes the daemon's file behind its back
 *     is the bug this replaces.
 *   - daemon-owned, and no daemon is running or configured → the local daemon
 *     tier, which is the store the daemon will read when it next starts. There
 *     is no unreachable runtime in this case; there is no runtime at all.
 *
 * FAILURE IS LOUD. When a daemon is expected, a base URL was configured, or a
 * daemon actually ANSWERED at the address discovery produced, and the write
 * cannot be delivered, this throws {@link DaemonConfigUnreachableError}. It does
 * NOT fall back to writing locally and reporting success. "Written locally, not
 * applied to the daemon" is a failure, and it is reported as one, because
 * reporting it as success is exactly what cost a Telegram bot token, a chat id
 * and a network-mode switch.
 *
 * "EXPECTED" IS PROVEN, NOT ASSUMED. A running-daemon record used to count as a
 * daemon being there. It does not: a record is written when a daemon is spawned
 * and nothing removes it when that daemon dies, so a stale one made every
 * daemon-owned READ answer "unavailable" against a dead port for days while a
 * live daemon sat elsewhere. The record is now a hint, pid checked here, port
 * checked by the probe, reaped with a receipt when it fails either, and only a
 * configured address or an address that answered makes failure loud. See
 * {@link discoverDaemonEndpoint}.
 */

import { configKeyScope, describeConfigOwnership, type ConfigScope } from './config-ownership.js';
import {
  detachedDaemonProcessAlive,
  readDetachedDaemonRuntime,
  reapDetachedDaemonRuntime,
  type DetachedDaemonRuntimeHint,
  type ProcessAliveCheck,
} from '../runtime/detached-daemon-runtime.js';
import { deriveControlPlaneBaseUrl, type ControlPlaneBinding } from './control-plane-base-url.js';

/** How to reach a daemon's control plane for config reads and writes. */
export interface DaemonConfigEndpoint {
  /** Base URL, e.g. `http://127.0.0.1:3421` (no trailing slash required). */
  readonly baseUrl: string;
  /** Operator bearer token; the config routes require admin. */
  readonly token?: string | undefined;
  /** Where this endpoint came from, for error text. */
  readonly source: string;
  /**
   * True when a daemon is KNOWN to be there (explicitly configured, or an
   * observed running-daemon record). False when the address was only derived
   * from configuration and must be probed before it is trusted.
   */
  readonly certain?: boolean | undefined;
}

/** The resolved destination for one config write. */
export type ConfigWriteRoute =
  | {
    readonly mode: 'local';
    readonly scope: ConfigScope;
    /** Why the local store is the owning runtime's store for this key. */
    readonly reason: string;
  }
  | {
    readonly mode: 'daemon';
    readonly scope: 'daemon';
    readonly endpoint: DaemonConfigEndpoint;
    readonly reason: string;
  };

/** Thrown when the owning runtime exists but could not be reached. */
export class DaemonConfigUnreachableError extends Error {
  readonly code = 'DAEMON_UNREACHABLE';
  readonly key: string;
  readonly endpoint: string;
  constructor(key: string, endpoint: string, cause: string) {
    super(
      `${key} is daemon-owned and the daemon at ${endpoint} could not be reached (${cause}). `
      + 'The setting was NOT applied. Nothing was written locally, because a local write would not '
      + 'reach the runtime that acts on this key.',
    );
    this.name = 'DaemonConfigUnreachableError';
    this.key = key;
    this.endpoint = endpoint;
  }
}

/** Thrown when the daemon answered but refused or did not apply the write. */
export class DaemonConfigRejectedError extends Error {
  readonly code = 'DAEMON_REJECTED';
  readonly key: string;
  readonly status: number;
  constructor(key: string, status: number, detail: string) {
    super(`The daemon refused to set ${key} (HTTP ${status}): ${detail}`);
    this.name = 'DaemonConfigRejectedError';
    this.key = key;
    this.status = status;
  }
}

export interface DaemonConfigRouterDeps {
  /** True when this process hosts the daemon (so local IS the daemon store). */
  readonly hostsDaemon: boolean;
  /** Explicit endpoint, required when the daemon runs on another machine. */
  readonly endpoint?: DaemonConfigEndpoint | null | undefined;
  /** Daemon home directory holding `detached-daemon.json`. */
  readonly daemonHomeDir?: string | undefined;
  /** Operator token for a discovered (rather than configured) daemon. */
  readonly token?: string | undefined;
  /**
   * Reads the control-plane binding out of the DAEMON's own config, so a
   * running daemon that left no runtime record is still discoverable. Returns
   * null when no daemon config exists.
   */
  readonly readDaemonBinding?: (() => ControlPlaneBinding | null) | undefined;
  /**
   * Read the daemon's whole resolved config through a connection this process
   * ALREADY holds, instead of rediscovering an address and dialling it.
   *
   * This is what keeps reads and writes on one resolution. Writes route through
   * the connected host's `config.set`; when this is supplied, reads route
   * through the same connection's `config.get`, so a value that was just
   * written is read back from the runtime that applied it. Without it the two
   * directions resolve the daemon independently and can disagree, a write that
   * succeeds and is then unreadable, which is what a whole session was lost to.
   *
   * Returns null when the connection holds no answer; discovery is then tried.
   */
  readonly readDaemonSnapshot?: (() => Promise<Record<string, unknown> | null>) | undefined;
  /** Injected for tests. */
  readonly readRuntimeRecord?: ((dir: string) => DetachedDaemonRuntimeHint | null) | undefined;
  /** Injected for tests: whether a recorded pid still exists. */
  readonly isProcessAlive?: ProcessAliveCheck | undefined;
  /**
   * Remove a runtime record proven stale, leaving a receipt. Injected for tests;
   * defaults to the real reaper.
   */
  readonly reapRuntimeRecord?: ((dir: string, record: DetachedDaemonRuntimeHint, reason: string) => void) | undefined;
  /** Told what was reaped and why, so a surface can say it out loud. */
  readonly onRuntimeRecordReaped?: ((event: { readonly baseUrl: string; readonly reason: string }) => void) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Request timeout for daemon calls, ms. */
  readonly timeoutMs?: number | undefined;
  /** Timeout for the liveness probe of an uncertain endpoint, ms. */
  readonly probeTimeoutMs?: number | undefined;
}

/** Decide where a write to `key` belongs. Pure, performs no I/O beyond the record read. */
export function resolveConfigWriteRoute(key: string, deps: DaemonConfigRouterDeps): ConfigWriteRoute {
  const scope = configKeyScope(key);
  if (scope !== 'daemon') {
    return { mode: 'local', scope, reason: describeConfigOwnership(key) };
  }
  if (deps.hostsDaemon) {
    return {
      mode: 'local',
      scope,
      reason: `${key} is daemon-owned and this process hosts the daemon, so its own store is the daemon's store.`,
    };
  }
  const endpoint = discoverDaemonEndpoint(deps);
  if (endpoint) {
    return { mode: 'daemon', scope: 'daemon', endpoint, reason: describeConfigOwnership(key) };
  }
  return {
    mode: 'local',
    scope,
    reason: `${key} is daemon-owned and no daemon is running or configured; `
      + 'the daemon config store is written directly and the daemon reads it at startup.',
  };
}

/**
 * Where the daemon is, in decreasing order of certainty:
 *
 *   1. an explicit endpoint, the only option when the daemon is on another
 *      machine, and always authoritative;
 *   2. the running-daemon record a surface writes when it SPAWNS a detached
 *      daemon, a HINT, validated here and never simply believed;
 *   3. the control-plane binding in the daemon's own config, derived (never a
 *      stored `baseUrl` string, which drifts, see control-plane-base-url.ts).
 *
 * (3) exists because (2) is not written by every launch: a daemon started in
 * the foreground leaves no record, and treating that as "no daemon" sent
 * daemon-owned writes to the local file while a daemon was live. That is the
 * exact silent-divergence this whole change removes, so it is not acceptable to
 * depend on the record alone.
 *
 * THE RECORD IS A HINT, NOT AN ADDRESS.
 *
 * It used to be returned as `certain: true`, never liveness-checked, and never
 * fallen through. One record left behind by a daemon that had exited made every
 * daemon-owned settings READ answer "unavailable" against a port nothing
 * listened on, for days, while a live daemon sat on another port with a
 * perfectly good control-plane binding two lines further down. So the record is
 * now validated before it is trusted, in two stages:
 *
 *   - pid alive, HERE, synchronously. A record naming a pid that no longer
 *     exists describes a daemon that is gone. It is REAPED (with a receipt) and
 *     discovery falls through to (3), which is how the live daemon is found.
 *   - the port answers, in the async probe below. A record survives the pid
 *     check but is still only `certain: false`, so nothing is reported
 *     unavailable until something has actually answered at that address. A pid
 *     can be recycled onto an unrelated process; only an answer proves a daemon.
 *
 * An explicit endpoint (1) stays `certain: true`: an operator naming an address
 * is asserting a daemon is there, and failing to reach it must be loud rather
 * than quietly downgraded to a local write.
 */
export function discoverDaemonEndpoint(deps: DaemonConfigRouterDeps): DaemonConfigEndpoint | null {
  if (deps.endpoint && deps.endpoint.baseUrl.trim()) return { ...deps.endpoint, certain: true };
  if (!deps.daemonHomeDir) return null;
  const read = deps.readRuntimeRecord ?? ((dir: string) => readDetachedDaemonRuntime(dir));
  const record = read(deps.daemonHomeDir);
  if (record) {
    const endpoint = validatedRecordEndpoint(record, deps);
    if (endpoint) return endpoint;
    // Reaped: fall through to the derived binding rather than returning null,
    // which is the whole point, the daemon is usually still running.
  }
  if (!deps.readDaemonBinding) return null;
  const binding = deps.readDaemonBinding();
  if (!binding) return null;
  return {
    baseUrl: deriveControlPlaneBaseUrl(binding, 'loopback'),
    token: deps.token,
    source: 'control-plane binding in the daemon config',
    certain: false,
  };
}

/** The base URL a runtime record points at (`0.0.0.0` means "reach me on loopback"). */
function recordBaseUrl(record: DetachedDaemonRuntimeHint): string {
  const host = record.host === '0.0.0.0' ? '127.0.0.1' : record.host;
  return `http://${host}:${record.port}`;
}

/**
 * Turn a runtime record into an endpoint, or reap it and return null.
 *
 * Returns an UNCERTAIN endpoint on success: the pid check proves a process
 * exists, not that it is this daemon answering on this port. The port probe
 * finishes the job.
 */
function validatedRecordEndpoint(
  record: DetachedDaemonRuntimeHint,
  deps: DaemonConfigRouterDeps,
): DaemonConfigEndpoint | null {
  if (!detachedDaemonProcessAlive(record, deps.isProcessAlive)) {
    reapRecord(
      record,
      deps,
      `the process it names (pid ${String(record.pid)}) no longer exists, so the daemon it described has exited`,
    );
    return null;
  }
  return {
    baseUrl: recordBaseUrl(record),
    token: deps.token,
    source: 'running-daemon record',
    certain: false,
  };
}

/** Reap a record proven stale, disclose it, and never throw doing so. */
function reapRecord(record: DetachedDaemonRuntimeHint, deps: DaemonConfigRouterDeps, reason: string): void {
  const dir = deps.daemonHomeDir;
  if (!dir) return;
  const reap = deps.reapRuntimeRecord
    ?? ((target: string, stale: DetachedDaemonRuntimeHint, why: string) => {
      reapDetachedDaemonRuntime(target, stale, why);
    });
  try {
    reap(dir, record, reason);
  } catch {
    // A record that could not be removed is still not trusted by this call;
    // the next one re-checks it. Failing to reap must not fail the read.
  }
  deps.onRuntimeRecordReaped?.({ baseUrl: recordBaseUrl(record), reason });
}

/**
 * Reap a record whose pid is alive but whose port answers nothing.
 *
 * This is the pid-reuse case: the recorded pid was recycled onto an unrelated
 * process, so liveness says "alive" while no daemon is there. Exported for the
 * read path, which discovers the non-answer rather than this module.
 */
export function reapUnansweringRuntimeRecord(deps: DaemonConfigRouterDeps, baseUrl: string): void {
  if (!deps.daemonHomeDir) return;
  const read = deps.readRuntimeRecord ?? ((dir: string) => readDetachedDaemonRuntime(dir));
  const record = read(deps.daemonHomeDir);
  if (!record || recordBaseUrl(record) !== baseUrl) return;
  reapRecord(record, deps, `nothing answered at ${baseUrl}, so the record no longer describes a reachable daemon`);
}

/**
 * The write route, with an UNCERTAIN endpoint probed first.
 *
 * A binding read out of configuration says where a daemon would listen, not
 * that one does. If nothing answers there, no daemon is running, and the local
 * daemon store is the correct destination, that is not a silent fallback, it
 * is the absence of a runtime to be unreachable. An endpoint that IS known
 * (explicit, or an observed running daemon) is never downgraded this way: it
 * must be reached or the write fails.
 */
export async function resolveLiveConfigWriteRoute(
  key: string,
  deps: DaemonConfigRouterDeps,
): Promise<ConfigWriteRoute> {
  let lastBaseUrl = '';
  // A record that named a daemon and then could not be found anywhere. Held so
  // the failure below stays LOUD: a record existing means a daemon was supposed
  // to be running, and quietly writing to a local file in that case is the
  // silent divergence this module exists to prevent.
  let reapedRecord: DaemonConfigEndpoint | null = null;

  // At most two attempts: when the first endpoint came from a runtime record
  // that does not answer, reaping it makes the NEXT discovery return the derived
  // control-plane binding, which is where a live daemon usually is. Not looking
  // there is how a daemon-owned setting was written to a file nothing reads
  // while the daemon was up on another port.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const route = resolveConfigWriteRoute(key, deps);
    if (route.mode !== 'daemon') {
      // No daemon address left at all. If a record had named one, that is a
      // failure to report, not a local write to perform.
      if (reapedRecord) break;
      return route;
    }
    if (route.endpoint.certain !== false) return route;
    lastBaseUrl = route.endpoint.baseUrl;
    if (await daemonAnswers(route.endpoint, deps)) {
      // It answered, so it is proven, not merely derived: an error reaching it
      // from here on is a real failure rather than an absent daemon.
      return { ...route, endpoint: { ...route.endpoint, certain: true } };
    }
    if (route.endpoint.source !== 'running-daemon record') break;
    reapedRecord = route.endpoint;
    reapUnansweringRuntimeRecord(deps, route.endpoint.baseUrl);
  }

  if (reapedRecord) {
    // A daemon was recorded as running and nothing answers for it anywhere,
    // neither at its recorded address nor at the address its own config derives.
    // Reported as an unreachable daemon so the write fails loudly.
    return {
      mode: 'daemon',
      scope: 'daemon',
      endpoint: { ...reapedRecord, certain: true },
      reason: describeConfigOwnership(key),
    };
  }
  return {
    mode: 'local',
    scope: 'daemon',
    reason: `${key} is daemon-owned; no daemon answered at ${lastBaseUrl}, so the daemon `
      + 'config store is written directly and the daemon reads it when it next starts.',
  };
}

/**
 * Ask the daemon whether it is actually there. Used only for an UNCERTAIN
 * endpoint (one derived from configuration rather than observed): a config
 * value describes where a daemon would listen, not that one does.
 */
async function daemonAnswers(endpoint: DaemonConfigEndpoint, deps: DaemonConfigRouterDeps): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/config`, {
      method: 'GET',
      headers: daemonHeaders(endpoint),
      signal: AbortSignal.timeout(deps.probeTimeoutMs ?? 2_000),
    });
    // A 401/403 still proves a daemon is listening, it answered.
    return response.status < 500;
  } catch {
    return false;
  }
}

/** What a completed config write did, and where the value actually landed. */
export interface ConfigWriteOutcome {
  readonly key: string;
  readonly scope: ConfigScope;
  /** Which runtime applied it. */
  readonly appliedBy: 'daemon' | 'local';
  /** Absolute file path, or the daemon base URL that applied it. */
  readonly persistedTo: string;
  /** The value the owning runtime reports holding AFTER the write. */
  readonly value: unknown;
  readonly reason: string;
}

/** The narrow local writer this module needs, satisfied by ConfigManager. */
export interface LocalConfigWriter {
  setDynamic(key: string, value: unknown): void;
  get(key: string): unknown;
  getConfigPath(): string;
  getDaemonTierPath?(): string | null;
}

/**
 * Apply a config write to whichever runtime owns the key. Throws
 * {@link DaemonConfigUnreachableError} rather than silently writing locally
 * when the daemon owns the key and cannot be reached.
 */
export async function applyConfigWrite(
  key: string,
  value: unknown,
  local: LocalConfigWriter,
  deps: DaemonConfigRouterDeps,
): Promise<ConfigWriteOutcome> {
  // The local branch is resolved and applied BEFORE any await, so a
  // client-owned write is still observable synchronously to the caller that
  // started it. Callers that fire this without awaiting (a keypress handler
  // toggling a display setting) would otherwise see the old value.
  const immediate = resolveConfigWriteRoute(key, deps);
  if (immediate.mode === 'local') return writeLocally(key, value, local, immediate);

  const route = await resolveLiveConfigWriteRoute(key, deps);
  if (route.mode === 'local') return writeLocally(key, value, local, route);
  const applied = await postDaemonConfig(key, value, route.endpoint, deps);
  return {
    key,
    scope: 'daemon',
    appliedBy: 'daemon',
    persistedTo: applied.persistedTo ?? route.endpoint.baseUrl,
    value: applied.value,
    reason: route.reason,
  };
}

function writeLocally(
  key: string,
  value: unknown,
  local: LocalConfigWriter,
  route: Extract<ConfigWriteRoute, { mode: 'local' }>,
): ConfigWriteOutcome {
  local.setDynamic(key, value);
  const persistedTo = route.scope === 'daemon'
    ? (local.getDaemonTierPath?.() ?? local.getConfigPath())
    : local.getConfigPath();
  return {
    key,
    scope: route.scope,
    appliedBy: 'local',
    persistedTo,
    value: local.get(key),
    reason: route.reason,
  };
}

interface DaemonConfigSetResponse {
  readonly value: unknown;
  readonly persistedTo?: string | undefined;
}

async function postDaemonConfig(
  key: string,
  value: unknown,
  endpoint: DaemonConfigEndpoint,
  deps: DaemonConfigRouterDeps,
): Promise<DaemonConfigSetResponse> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/config`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: daemonHeaders(endpoint),
      body: JSON.stringify({ key, value }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new DaemonConfigUnreachableError(key, endpoint.baseUrl, describeCause(error));
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new DaemonConfigRejectedError(key, response.status, text.slice(0, 400) || response.statusText);
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      value: parsed['value'],
      persistedTo: typeof parsed['persistedTo'] === 'string' ? parsed['persistedTo'] : undefined,
    };
  } catch {
    throw new DaemonConfigRejectedError(key, response.status, 'the daemon returned a non-JSON response');
  }
}

/**
 * Read the daemon's full config THROUGH the daemon. Clients must not open the
 * daemon's settings file: it may not be on this machine, and even when it is,
 * reading the file misses anything the running daemon holds but has not yet
 * flushed. Throws when the daemon is unreachable, an honest failure beats a
 * stale local answer.
 */
export async function readDaemonConfig(
  endpoint: DaemonConfigEndpoint,
  deps: Pick<DaemonConfigRouterDeps, 'fetchImpl' | 'timeoutMs'> = {},
): Promise<Record<string, unknown>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/config`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: daemonHeaders(endpoint),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new DaemonConfigUnreachableError('(config read)', endpoint.baseUrl, describeCause(error));
  }
  if (!response.ok) {
    throw new DaemonConfigRejectedError('(config read)', response.status, response.statusText);
  }
  return await response.json() as Record<string, unknown>;
}

function daemonHeaders(endpoint: DaemonConfigEndpoint): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.token) headers['authorization'] = `Bearer ${endpoint.token}`;
  return headers;
}

function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
