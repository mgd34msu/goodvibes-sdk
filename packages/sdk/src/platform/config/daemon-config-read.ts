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

/** Fetch the daemon's config once. Never throws — the error is reported per key. */
export async function loadDaemonConfigSnapshot(deps: DaemonConfigRouterDeps): Promise<DaemonConfigSnapshot> {
  if (deps.hostsDaemon) return { endpoint: null, config: null, error: null };
  const endpoint = discoverDaemonEndpoint(deps);
  if (!endpoint) return { endpoint: null, config: null, error: null };
  try {
    return { endpoint, config: await readDaemonConfig(endpoint, deps), error: null };
  } catch (error) {
    // An endpoint merely DERIVED from configuration describes where a daemon
    // would listen. Nothing answering there means no daemon is running, so the
    // local daemon store is the honest answer — not an error. A KNOWN daemon
    // that does not answer is a genuine failure and stays one.
    if (endpoint.certain === false) return { endpoint: null, config: null, error: null };
    return { endpoint, config: null, error: error instanceof Error ? error.message : String(error) };
  }
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
    throw new DaemonConfigUnreachableError(key, route.endpoint.baseUrl, snapshot.error);
  }
  return daemonEntry(key, route.endpoint, snapshot.config, route.reason);
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

  return keys.map((key) => {
    const route = resolveConfigReadRoute(key, deps);
    // No daemon answered at a merely-derived address: read locally, honestly.
    if (route.mode === 'daemon' && snapshot.endpoint === null) {
      return localEntry(key, 'daemon', route.reason, local);
    }
    if (route.mode === 'local') return localEntry(key, route.scope, route.reason, local);
    if (snapshot.error !== null) {
      return {
        key,
        scope: 'daemon' as const,
        source: 'daemon' as const,
        status: 'unavailable' as const,
        store: route.endpoint.baseUrl,
        reason: route.reason,
        error: `The daemon at ${route.endpoint.baseUrl} could not be reached (${snapshot.error}), `
          + 'so its current value for this key is unknown.',
      };
    }
    return daemonEntry(key, route.endpoint, snapshot.config, route.reason);
  });
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
    const route = resolveConfigReadRoute(key, deps);
    if (route.mode === 'daemon' && snapshot.endpoint === null) {
      return localEntry(key, 'daemon', route.reason, local);
    }
    if (route.mode === 'local') return localEntry(key, route.scope, route.reason, local);
    if (snapshot.error !== null) {
      unavailable.add(key);
      return {
        key,
        scope: 'daemon',
        source: 'daemon',
        status: 'unavailable',
        store: route.endpoint.baseUrl,
        reason: route.reason,
        error: `The daemon at ${route.endpoint.baseUrl} could not be reached (${snapshot.error}), `
          + 'so its current value for this key is unknown.',
      };
    }
    return daemonEntry(key, route.endpoint, snapshot.config, route.reason);
  };

  return {
    get: (key) => describe(key).value,
    describe,
    unavailable,
    daemonError: snapshot.error,
    daemonBaseUrl: snapshot.endpoint?.baseUrl ?? null,
  };
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
