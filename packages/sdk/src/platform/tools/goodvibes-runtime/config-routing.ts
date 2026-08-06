/**
 * config-routing.ts — the ownership-aware read and write path used by the
 * `goodvibes_settings` and `goodvibes_context` tools.
 *
 * A setting has exactly one owning runtime (see `config/config-ownership.ts`).
 * The tools must therefore READ and WRITE through that runtime, not through
 * whichever process happens to be holding the model conversation:
 *
 *   - daemon-owned key (`surfaces.*`, control-plane binding, watchers, device
 *     pairing, provisioning, retention) → the daemon's config.
 *   - client-owned key (rendering, transcript display, this installation's own
 *     lifecycle) → this client's own config.
 *   - user-level key → the cross-client shared tier.
 *
 * Both directions matter and they failed together. A Telegram bot username was
 * written into the agent's own settings file, reported as a success, and
 * configured nothing, because Telegram runs in the daemon. When the same value
 * was later asked for, the agent read its own store, found nothing, and said the
 * setting was not set — after it had been set. A write that routes correctly
 * paired with a read that does not is still a system that reports fiction.
 *
 * So: one source of truth per key, read live, and every reported value carries
 * the store it came from. When the owning runtime exists but cannot be reached,
 * that is stated as a failure. A default presented as the current setting is
 * indistinguishable from a lie, so it is never presented as one.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey } from '../../config/schema.js';
import type { ConfigManager } from '../../config/manager.js';
import { configKeyScope, describeConfigOwnership, isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import {
  applyConfigWrite,
  type DaemonConfigRouterDeps,
} from '../../config/daemon-config-route.js';
import { loadDaemonConfigSnapshot } from '../../config/daemon-config-read.js';
import { DEFAULT_CONFIG_SNAPSHOT } from '../../config/manager-bootstrap.js';
import { persistSharedKey } from '../../config/shared-config-tier.js';

/**
 * Host-supplied routing facts.
 *
 * Deliberately the router's OWN dependency shape with `hostsDaemon` relaxed to
 * optional, rather than a parallel hand-copied field list. A host builds these
 * once (the agent does it in `config/daemon-config-routing.ts`) and hands the
 * same object to both the tools and its own config paths, so there is one
 * routing table. Enumerating the fields here instead would silently drop any
 * the router later grows — and a dropped discovery hook is not a type error,
 * it is a daemon that looks absent while it is running.
 */
export type ConfigRoutingOptions =
  Omit<DaemonConfigRouterDeps, 'hostsDaemon'>
  & {
    readonly hostsDaemon?: boolean | undefined;
    /**
     * The surface whose store owns CLIENT-owned keys for this turn, when that is
     * not the host's own surface.
     *
     * A daemon-hosted session runs inside the host process but belongs to the
     * surface that asked for it. Client-owned keys — rendering, transcript
     * display, wake-word selection — are that surface's, and they live in that
     * surface's file. Without this the host's own ConfigManager answered, and a
     * hosted AGENT conversation read and wrote `~/.goodvibes/tui/settings.json`
     * for its whole life: asked to enable the wake word, it wrote the TUI's
     * store, read the value back out of the same store, and reported success,
     * while the live agent process went on reading a file nobody had touched.
     *
     * Only the FILE is redirected, never a whole ConfigManager: constructing one
     * for another surface runs that surface's migrations and shared-config
     * bootstrap, which is a non-owner rewriting a store it does not own.
     */
    readonly clientOwnedStore?: ClientOwnedStore | undefined;
  };

/** The originating surface's own settings file, for client-owned keys. */
export interface ClientOwnedStore {
  /** Surface root — `agent`, `tui`, `webui`. Reported so a value names its owner. */
  readonly surface: string;
  /** Absolute path to that surface's `settings.json`. */
  readonly settingsPath: string;
}

/** Where a reported value actually came from. */
export interface ConfigValueOrigin {
  /** `daemon` = read live over the control plane; `file` = read from a store. */
  readonly readFrom: 'daemon' | 'file' | 'memory';
  /** Absolute path or daemon base URL. */
  readonly source: string;
  /** Which runtime owns the key. */
  readonly scope: 'daemon' | 'client' | 'user';
  /** Plain-language ownership statement, for the user-facing report. */
  readonly ownership: string;
}

/** A successfully resolved read. */
export interface RoutedConfigRead extends ConfigValueOrigin {
  readonly key: string;
  readonly value: unknown;
  readonly available: true;
}

/** A read that could not be answered honestly. */
export interface UnavailableConfigRead extends Pick<ConfigValueOrigin, 'scope' | 'ownership'> {
  readonly key: string;
  readonly available: false;
  /** Why no value can be reported, in words the user can act on. */
  readonly reason: string;
  readonly source: string;
}

export type ConfigReadResult = RoutedConfigRead | UnavailableConfigRead;

/** A completed, verified write. */
export interface RoutedConfigWrite {
  readonly key: string;
  readonly scope: 'daemon' | 'client' | 'user';
  readonly ownership: string;
  /** Which runtime applied it. */
  readonly appliedBy: 'daemon' | 'local';
  /** The file or endpoint the value is stored in. */
  readonly persistedTo: string;
  /** The value the OWNING store reports holding after the write. */
  readonly value: unknown;
}

/**
 * Fill in the routing deps the daemon router needs. The daemon home is derived
 * from the daemon config store's own directory, so a host that configured
 * `GOODVIBES_DAEMON_HOME` gets that home without having to repeat it here.
 */
export function resolveRouterDeps(
  configManager: Pick<ConfigManager, 'getDaemonTierPath'>,
  options: ConfigRoutingOptions = {},
): DaemonConfigRouterDeps {
  const tierPath = configManager.getDaemonTierPath();
  const daemonHomeDir = options.daemonHomeDir ?? (tierPath ? dirname(tierPath) : undefined);
  // Everything the host supplied passes through untouched; only the two facts
  // this layer can derive on its own are filled in.
  return {
    ...options,
    hostsDaemon: options.hostsDaemon === true,
    ...(daemonHomeDir !== undefined ? { daemonHomeDir } : {}),
  };
}

/**
 * The store a LOCAL write to `key` lands in. `applyConfigWrite` reports the
 * daemon tier for daemon-owned keys and the surface file otherwise; user-level
 * keys ride the shared tier, so that case is resolved here rather than reporting
 * a surface path the value is not in.
 */
export function localStorePathForKey(
  configManager: Pick<ConfigManager, 'getConfigPath' | 'getDaemonTierPath' | 'getSharedTierPath'>,
  key: string,
  options: ConfigRoutingOptions = {},
): string {
  const scope = configKeyScope(key);
  if (scope === 'daemon') return configManager.getDaemonTierPath() ?? configManager.getConfigPath();
  if (scope === 'user') return configManager.getSharedTierPath() ?? configManager.getConfigPath();
  // A client-owned key belongs to the surface this turn is FOR, which is not
  // always the surface this process is.
  return options.clientOwnedStore?.settingsPath ?? configManager.getConfigPath();
}

/**
 * A client-owned key's value from the originating surface's own file.
 *
 * Absent means absent: the answer falls back to the SCHEMA DEFAULT, never to the
 * host's stored value. The host is a different surface with its own explicit
 * settings, and reporting one surface's choice as another's is the whole defect
 * — it is how a hosted agent turn was told the TUI's wake-word setting was its
 * own.
 */
function readClientOwnedValue(store: ClientOwnedStore, key: string): unknown {
  const onDisk = readKeyFromFile(store.settingsPath, key);
  if (onDisk.present) return onDisk.value;
  return readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value;
}

/** True when this key's owner is the originating surface's file, not the host's. */
function usesClientOwnedStore(key: string, options: ConfigRoutingOptions): boolean {
  return options.clientOwnedStore !== undefined && configKeyScope(key) === 'client';
}

/**
 * Apply a write to the runtime that owns the key, then confirm the OWNING store
 * holds it.
 *
 * The read-back is the point. `configManager.get()` after a set reports the
 * in-process object, so it says "yes, that's the value" even when the bytes
 * never landed, landed in a store nothing reads, or will be shadowed on reload.
 * Here the value is re-read from the file (or from the daemon that applied it)
 * and a write that did not stick is returned as a failure.
 *
 * @throws {Error} when the value cannot be confirmed in the owning store, and
 *   whatever `applyConfigWrite` throws when the daemon is unreachable or refuses.
 */
export async function applyRoutedConfigWrite(
  configManager: ConfigManager,
  key: ConfigKey,
  value: unknown,
  options: ConfigRoutingOptions = {},
): Promise<RoutedConfigWrite> {
  // A client-owned key for a turn that belongs to ANOTHER surface is written to
  // that surface's own file, and to nothing else. The host's ConfigManager is
  // not consulted and not mutated: it describes a different surface, and its
  // in-memory object answering this write is what made a hosted agent turn
  // believe it had changed the agent when it had changed the TUI.
  //
  // Only the one key is persisted (persistSharedKey merges), so nothing else in
  // the originating surface's file is disturbed, no migration runs, and the live
  // surface picks the change up through the config file watcher it already has.
  if (usesClientOwnedStore(key, options)) {
    const store = options.clientOwnedStore!;
    persistSharedKey(store.settingsPath, key, value);
    const onDisk = readKeyFromFile(store.settingsPath, key);
    if (!onDisk.present || !valuesMatch(onDisk.value, value)) {
      throw new Error(
        `${key} was written to ${store.settingsPath}, the ${store.surface} surface's own store, but reading it `
        + 'back does not show the requested value. The setting is NOT applied.',
      );
    }
    return {
      key,
      scope: 'client',
      ownership: describeConfigOwnership(key),
      appliedBy: 'local',
      persistedTo: store.settingsPath,
      value: onDisk.value,
    };
  }

  const deps = resolveRouterDeps(configManager, options);
  const outcome = await applyConfigWrite(key, value, {
    setDynamic: (k, v) => { configManager.setDynamic(k as ConfigKey, v); },
    get: (k) => configManager.get(k as ConfigKey),
    getConfigPath: () => configManager.getConfigPath(),
    getDaemonTierPath: () => configManager.getDaemonTierPath(),
  }, deps);

  if (outcome.appliedBy === 'daemon') {
    // The daemon answered with the value it now holds. Trust that over the local
    // object, which never saw this write at all.
    if (!valuesMatch(outcome.value, value)) {
      throw new Error(
        `${key} was sent to the daemon at ${outcome.persistedTo} but the daemon reports `
        + `${JSON.stringify(outcome.value)} rather than the requested value. The setting is NOT applied.`,
      );
    }
    return {
      key,
      scope: 'daemon',
      ownership: describeConfigOwnership(key),
      appliedBy: 'daemon',
      persistedTo: outcome.persistedTo,
      value: outcome.value,
    };
  }

  const persistedTo = localStorePathForKey(configManager, key);
  const onDisk = readKeyFromFile(persistedTo, key);
  if (!onDisk.present || !valuesMatch(onDisk.value, value)) {
    throw new Error(
      `${key} was applied in memory but is NOT in ${persistedTo}, which is the store the runtime that acts on `
      + 'this key reads. The running host may behave as if the change never happened.',
    );
  }
  const projectPath = configManager.getProjectConfigPath?.();
  const shadow = projectPath ? readKeyFromFile(projectPath, key) : { present: false, value: undefined };
  if (shadow.present && !valuesMatch(shadow.value, value)) {
    throw new Error(
      `${key} was written to ${persistedTo}, but a project overlay at ${projectPath} sets it to `
      + `${JSON.stringify(shadow.value)} and wins on reload. The setting will NOT take effect.`,
    );
  }
  return {
    key,
    scope: outcome.scope,
    ownership: describeConfigOwnership(key),
    appliedBy: 'local',
    persistedTo,
    value: onDisk.value,
  };
}

/**
 * Read `key` from the runtime that owns it, and say where the answer came from.
 *
 * A daemon-owned key is read live over the control plane when a daemon is
 * running, because a running daemon may hold state it has not flushed. With no
 * daemon running, the daemon's own store file is the answer — it is the same
 * store the daemon will read at startup. When a daemon IS expected and cannot be
 * reached, this returns `available: false` with the reason instead of the local
 * default: reporting a default as the current setting is the failure mode this
 * whole path exists to remove.
 */
export async function readRoutedConfigValue(
  configManager: ConfigManager,
  key: ConfigKey,
  options: ConfigRoutingOptions = {},
): Promise<ConfigReadResult> {
  const scope = configKeyScope(key);
  const ownership = describeConfigOwnership(key);
  if (scope !== 'daemon') {
    return {
      key,
      value: usesClientOwnedStore(key, options)
        ? readClientOwnedValue(options.clientOwnedStore!, key)
        : configManager.get(key),
      available: true,
      readFrom: 'file',
      source: localStorePathForKey(configManager, key, options),
      scope,
      ownership,
    };
  }

  const deps = resolveRouterDeps(configManager, options);
  // ONE resolution, shared with writes: loadDaemonConfigSnapshot prefers a
  // connection this process already holds, validates a running-daemon record
  // before trusting it, and reaps a stale one. Re-deriving the endpoint here is
  // what let reads and writes disagree about where the daemon was.
  const snapshot = await loadDaemonConfigSnapshot(deps);
  if (snapshot.endpoint === null) {
    // Either this process IS the daemon, or no daemon is running. Both make the
    // local daemon tier the owning store, and ConfigManager already overlays it.
    return {
      key,
      value: configManager.get(key),
      available: true,
      readFrom: 'file',
      source: configManager.getDaemonTierPath() ?? configManager.getConfigPath(),
      scope,
      ownership,
    };
  }

  if (snapshot.error !== null || snapshot.config === null) {
    return {
      key,
      available: false,
      scope,
      ownership,
      source: snapshot.endpoint.baseUrl,
      reason: `${key} is daemon-owned and the daemon at ${snapshot.endpoint.baseUrl} could not be read `
        + `(${snapshot.error ?? 'no configuration was returned'}). `
        + 'No value is reported for it, because this host\'s copy would be a guess, not the setting.',
    };
  }
  const found = readDotPath(snapshot.config, key);
  return {
    key,
    value: found.present ? found.value : configManager.get(key),
    available: true,
    readFrom: 'daemon',
    source: snapshot.endpoint.baseUrl,
    scope,
    ownership,
  };
}

/**
 * Read many keys at once, fetching the daemon's config a single time. Used by
 * the settings LIST view so daemon-owned rows carry daemon values and
 * client-owned rows carry local ones, each labelled with its store.
 */
export async function readRoutedConfigValues(
  configManager: ConfigManager,
  keys: readonly ConfigKey[],
  options: ConfigRoutingOptions = {},
): Promise<ConfigReadResult[]> {
  const daemonKeys = keys.filter((key) => isDaemonOwnedConfigKey(key));
  if (daemonKeys.length === 0) {
    return keys.map((key) => localRead(configManager, key, options));
  }

  const deps = resolveRouterDeps(configManager, options);
  // Same single resolution the one-key read uses, for the same reason.
  const snapshot = await loadDaemonConfigSnapshot(deps);
  const endpoint = snapshot.endpoint;
  if (!endpoint) return keys.map((key) => localRead(configManager, key, options));

  const remote = snapshot.config;
  const failure = snapshot.error;

  return keys.map((key): ConfigReadResult => {
    if (!isDaemonOwnedConfigKey(key)) return localRead(configManager, key, options);
    const ownership = describeConfigOwnership(key);
    if (!remote) {
      return {
        key,
        available: false,
        scope: 'daemon',
        ownership,
        source: endpoint.baseUrl,
        reason: `The daemon at ${endpoint.baseUrl} could not be read (${failure ?? 'unknown error'}), `
          + 'so its settings are not reported. The values shown by this host would be guesses.',
      };
    }
    const found = readDotPath(remote, key);
    return {
      key,
      value: found.present ? found.value : configManager.get(key),
      available: true,
      readFrom: 'daemon',
      source: endpoint.baseUrl,
      scope: 'daemon',
      ownership,
    };
  });
}

function localRead(
  configManager: ConfigManager,
  key: ConfigKey,
  options: ConfigRoutingOptions = {},
): RoutedConfigRead {
  return {
    key,
    value: usesClientOwnedStore(key, options)
      ? readClientOwnedValue(options.clientOwnedStore!, key)
      : configManager.get(key),
    available: true,
    readFrom: 'file',
    source: localStorePathForKey(configManager, key, options),
    scope: configKeyScope(key),
    ownership: describeConfigOwnership(key),
  };
}

function readKeyFromFile(path: string, key: string): { present: boolean; value: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { present: false, value: undefined };
  }
  return readDotPath(parsed, key);
}

function readDotPath(root: unknown, key: string): { present: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const part of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor) || !(part in cursor)) {
      return { present: false, value: undefined };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { present: true, value: cursor };
}

function valuesMatch(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
