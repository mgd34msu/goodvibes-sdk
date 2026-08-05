/**
 * daemon-config-read.ts — reading config by OWNERSHIP, the other half of the
 * routing table in daemon-config-route.ts.
 *
 * Correct write routing with wrong read routing is still a system that lies.
 * The failure that produced this module: a daemon-owned setting was written,
 * the user asked a client to confirm it, the client read its OWN store, saw
 * nothing there, and reported the setting as not set.
 *
 * So reads follow the same rule writes do:
 *   - daemon-owned key, daemon reachable  → the daemon's LIVE value.
 *   - daemon-owned key, this process IS the daemon, or none is running → the
 *     local config manager, which resolves the daemon store.
 *   - daemon-owned key, a daemon is running but unreachable → `unavailable`.
 *     NEVER a default and never a stale local mirror: a default presented as
 *     the current setting is indistinguishable from a lie.
 *   - client-owned / user-level key → the local config manager.
 *
 * Batching matters. A settings listing covers hundreds of keys, so the daemon
 * is asked ONCE (`GET /config` returns the whole resolved config) and every
 * daemon-owned key is read out of that one snapshot.
 */

import { configKeyScope, describeConfigOwnership, type ConfigScope } from './config-ownership.js';
import { readDotPath } from './shared-config-tier.js';
import {
  DaemonConfigUnreachableError,
  discoverDaemonEndpoint,
  readDaemonConfig,
  reapUnansweringRuntimeRecord,
  type DaemonConfigEndpoint,
  type DaemonConfigRouterDeps,
} from './daemon-config-route.js';

/** Where a read for `key` must go. Mirrors the write route exactly. */
export type ConfigReadRoute =
  | { readonly mode: 'local'; readonly scope: ConfigScope; readonly reason: string }
  | { readonly mode: 'daemon'; readonly scope: 'daemon'; readonly endpoint: DaemonConfigEndpoint; readonly reason: string };

/** The narrow local reader this module needs — satisfied by ConfigManager. */
export interface LocalConfigReader {
  get(key: string): unknown;
  getConfigPath(): string;
  getDaemonTierPath?(): string | null;
}

/** One key's effective value, and the store it actually came from. */
export interface EffectiveConfigEntry {
  readonly key: string;
  readonly scope: ConfigScope;
  /** Which runtime answered. */
  readonly source: 'daemon' | 'local';
  /**
   * `ok` — `value` is the live value from the owning runtime.
   * `unavailable` — the owning runtime could not be reached; there is NO value,
   * deliberately, rather than a default that would read as the current setting.
   */
  readonly status: 'ok' | 'unavailable';
  readonly value?: unknown;
  /** Absolute file path, or the daemon base URL that answered. */
  readonly store: string;
  readonly reason: string;
  readonly error?: string;
}

/** Decide where a read for `key` belongs. Same ownership rules as writes. */
export function resolveConfigReadRoute(key: string, deps: DaemonConfigRouterDeps): ConfigReadRoute {
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
  // A connection this process already holds IS the daemon route, and outranks
  // discovery. Without this the route said "local" while the snapshot loader
  // was quite happy to answer from the connected host — the two halves of one
  // read disagreeing, which is the asymmetry this module exists to remove.
  if (deps.readDaemonSnapshot) {
    return {
      mode: 'daemon',
      scope: 'daemon',
      endpoint: {
        baseUrl: 'the connected host',
        source: 'the connection this process already holds',
        certain: true,
      },
      reason: describeConfigOwnership(key),
    };
  }
  const endpoint = discoverDaemonEndpoint(deps);
  if (endpoint) return { mode: 'daemon', scope: 'daemon', endpoint, reason: describeConfigOwnership(key) };
  return {
    mode: 'local',
    scope,
    reason: `${key} is daemon-owned and no daemon is running; the local daemon config store is `
      + 'the store the daemon will read at startup.',
  };
}

/**
 * A one-shot cache of the daemon's resolved config, so a listing over hundreds
 * of keys costs one HTTP call. `error` is set when the daemon was expected but
 * did not answer — every daemon-owned key in that listing then reports
 * `unavailable` instead of silently degrading to a local default.
 */
export interface DaemonConfigSnapshot {
  readonly endpoint: DaemonConfigEndpoint | null;
  readonly config: Record<string, unknown> | null;
  readonly error: string | null;
}

/**
 * Fetch the daemon's config once. Never throws — the error is reported per key.
 *
 * A connection this process already holds is used FIRST when one was supplied
 * (`readDaemonSnapshot`). That is what puts reads and writes on one resolution:
 * writes go out over the connected host's `config.set`, so reads must come back
 * from that same host, or a setting can be written successfully and then read
 * as missing. Address discovery is the path for a process that holds no
 * connection, not a second opinion for one that does.
 */
export async function loadDaemonConfigSnapshot(deps: DaemonConfigRouterDeps): Promise<DaemonConfigSnapshot> {
  if (deps.hostsDaemon) return { endpoint: null, config: null, error: null };
  if (deps.readDaemonSnapshot) {
    const connected: DaemonConfigEndpoint = {
      baseUrl: 'the connected host',
      source: 'the connection this process already holds',
      certain: true,
    };
    try {
      const config = await deps.readDaemonSnapshot();
      // No snapshot means the connection could not answer. That is a genuine
      // failure of a host we are connected to, not an absent daemon.
      if (config === null) {
        return { endpoint: connected, config: null, error: 'the connected host returned no configuration snapshot' };
      }
      return { endpoint: connected, config, error: null };
    } catch (error) {
      return { endpoint: connected, config: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
  // A record that named a daemon which could not be found anywhere. Held so the
  // answer below stays an honest `unavailable` rather than a local value
  // presented as the daemon's: a record existing means a daemon was supposed to
  // be running.
  let reapedRecord: { endpoint: DaemonConfigEndpoint; error: string } | null = null;

  // Two attempts at most, and the second only happens when the first was a
  // runtime record that did not answer. Reaping that record makes the very next
  // discovery return the DERIVED control-plane binding, which is where the live
  // daemon usually is — falling back to the local store without looking there
  // is what made a running daemon look absent for days.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endpoint = discoverDaemonEndpoint(deps);
    if (!endpoint) break;
    try {
      return { endpoint, config: await readDaemonConfig(endpoint, deps), error: null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // An endpoint merely DERIVED from configuration describes where a daemon
      // would listen. Nothing answering there means no daemon is running, so the
      // local daemon store is the honest answer — not an error. A KNOWN daemon
      // that does not answer is a genuine failure and stays one.
      if (endpoint.certain !== false) return { endpoint, config: null, error: detail };
      // A running-daemon record that got this far had a live pid and still did
      // not answer — a recycled pid, or a daemon that died without cleaning up.
      if (endpoint.source !== 'running-daemon record') break;
      reapedRecord = { endpoint, error: detail };
      reapUnansweringRuntimeRecord(deps, endpoint.baseUrl);
    }
  }
  // Nothing answered anywhere, and a record said a daemon should be running:
  // report it unreachable. A local value shown as the daemon's current setting
  // is indistinguishable from a lie.
  if (reapedRecord) return { endpoint: reapedRecord.endpoint, config: null, error: reapedRecord.error };
  return { endpoint: null, config: null, error: null };
}

/**
 * Read one key from whichever runtime owns it. Throws
 * {@link DaemonConfigUnreachableError} when the daemon owns the key and cannot
 * be reached — the caller must not be handed a default it would present as the
 * current setting. Use {@link readEffectiveConfig} when a per-key
 * `unavailable` is more useful than an exception (listings).
 */
export async function readConfigValue(
  key: string,
  local: LocalConfigReader,
  deps: DaemonConfigRouterDeps,
): Promise<EffectiveConfigEntry> {
  const route = resolveConfigReadRoute(key, deps);
  if (route.mode === 'local') return localEntry(key, route.scope, route.reason, local);
  const snapshot = await loadDaemonConfigSnapshot(deps);
  if (snapshot.endpoint === null) return localEntry(key, 'daemon', route.reason, local);
  if (snapshot.error !== null) {
    throw new DaemonConfigUnreachableError(key, snapshot.endpoint.baseUrl, snapshot.error);
  }
  return daemonEntry(key, snapshot.endpoint, snapshot.config, route.reason);
}

/**
 * Read many keys at once, resolving each by ownership. One daemon round-trip
 * for the whole set. Every entry names the store it came from, so a listing can
 * show WHY the same key name reads differently in two places — the question
 * nobody could answer before.
 */
export async function readEffectiveConfig(
  keys: readonly string[],
  local: LocalConfigReader,
  deps: DaemonConfigRouterDeps,
): Promise<readonly EffectiveConfigEntry[]> {
  const needsDaemon = keys.some((key) => resolveConfigReadRoute(key, deps).mode === 'daemon');
  const snapshot = needsDaemon
    ? await loadDaemonConfigSnapshot(deps)
    : { endpoint: null, config: null, error: null } satisfies DaemonConfigSnapshot;

  return keys.map((key) => entryFromSnapshot(key, snapshot, local, deps));
}

/**
 * A synchronous, ownership-aware view of config.
 *
 * The daemon is asked ONCE up front, then `get(key)` answers immediately —
 * daemon-owned keys from the daemon's live config, everything else from the
 * local manager. That shape matters: the existing describe/list code paths take
 * a plain `{ get(key) }` reader and are synchronous all the way down, so this
 * drops straight in without turning a settings listing into an async cascade.
 *
 * When the daemon was expected and did not answer, `unavailable` lists the keys
 * whose value is genuinely unknown and `get` returns `undefined` for them. A
 * caller MUST check `unavailable` before presenting a value as "the current
 * setting" — that is the whole point.
 */
export interface EffectiveConfigView {
  get(key: string): unknown;
  /** Where `key` resolves from, and whether the answer is trustworthy. */
  describe(key: string): EffectiveConfigEntry;
  /** Daemon-owned keys whose live value could not be read. */
  readonly unavailable: ReadonlySet<string>;
  /** The daemon's reachability error, or null. */
  readonly daemonError: string | null;
  /** Base URL of the daemon consulted, or null when none was. */
  readonly daemonBaseUrl: string | null;
}

/** Build an {@link EffectiveConfigView}: one daemon round-trip, then sync reads. */
export async function createEffectiveConfigView(
  local: LocalConfigReader,
  deps: DaemonConfigRouterDeps,
): Promise<EffectiveConfigView> {
  const snapshot = await loadDaemonConfigSnapshot(deps);
  const unavailable = new Set<string>();

  const describe = (key: string): EffectiveConfigEntry => {
    const entry = entryFromSnapshot(key, snapshot, local, deps);
    if (entry.status === 'unavailable') unavailable.add(key);
    return entry;
  };

  return {
    get: (key) => describe(key).value,
    describe,
    unavailable,
    daemonError: snapshot.error,
    daemonBaseUrl: snapshot.endpoint?.baseUrl ?? null,
  };
}

/**
 * One key's entry, decided by the SNAPSHOT rather than by re-running discovery.
 *
 * Re-resolving the route per key was a real bug: loading the snapshot can REAP a
 * stale runtime record, so a second resolution sees a different world from the
 * one the snapshot was taken in — and a daemon that had just been proven
 * unreachable came back as a local value marked `ok`. The snapshot is the
 * verdict; the route only decides ownership.
 */
function entryFromSnapshot(
  key: string,
  snapshot: DaemonConfigSnapshot,
  local: LocalConfigReader,
  deps: DaemonConfigRouterDeps,
): EffectiveConfigEntry {
  const scope = configKeyScope(key);
  if (scope !== 'daemon') return localEntry(key, scope, describeConfigOwnership(key), local);
  if (deps.hostsDaemon) {
    return localEntry(
      key,
      scope,
      `${key} is daemon-owned and this process hosts the daemon, so its own store is the daemon's store.`,
      local,
    );
  }
  const reason = describeConfigOwnership(key);
  // No daemon answered anywhere: the local daemon tier is the store the daemon
  // reads at startup, which is the honest answer rather than an error.
  if (snapshot.endpoint === null) return localEntry(key, 'daemon', reason, local);
  if (snapshot.error !== null) {
    return {
      key,
      scope: 'daemon',
      source: 'daemon',
      status: 'unavailable',
      store: snapshot.endpoint.baseUrl,
      reason,
      error: `The daemon at ${snapshot.endpoint.baseUrl} could not be reached (${snapshot.error}), `
        + 'so its current value for this key is unknown.',
    };
  }
  return daemonEntry(key, snapshot.endpoint, snapshot.config, reason);
}

function localEntry(
  key: string,
  scope: ConfigScope,
  reason: string,
  local: LocalConfigReader,
): EffectiveConfigEntry {
  const store = scope === 'daemon'
    ? (local.getDaemonTierPath?.() ?? local.getConfigPath())
    : local.getConfigPath();
  return { key, scope, source: 'local', status: 'ok', value: local.get(key), store, reason };
}

function daemonEntry(
  key: string,
  endpoint: DaemonConfigEndpoint,
  config: Record<string, unknown> | null,
  reason: string,
): EffectiveConfigEntry {
  const hit = readDotPath(config ?? {}, key);
  return {
    key,
    scope: 'daemon',
    source: 'daemon',
    status: 'ok',
    value: hit.value,
    store: endpoint.baseUrl,
    reason,
  };
}
