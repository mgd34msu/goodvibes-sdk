/**
 * routes/owner-profile-composition.ts
 *
 * Builds the one owner-profile store this process has, attaches the `profile.*`
 * verb handlers to it, and plugs it into every consumer seam. Same shape as
 * push-composition.ts / browser-composition.ts / calendar-composition.ts: the
 * registrar calls one function and gets back a teardown.
 *
 * ## Why the load is not awaited
 *
 * `registerGatewayVerbGroups` is synchronous, and making it async to wait for a
 * file read would ripple through the whole composition root. The load is started
 * here and the watcher attached when it finishes. In the milliseconds before it
 * lands, every verb answers the store's own honest state — "Your profile has not
 * been loaded yet" — rather than an empty profile, which is exactly the
 * distinction §4.4 insists on: never answer "I know nothing about you" when the
 * truth is "I have not read the file yet".
 *
 * ## Why the config reads are closures
 *
 * `profile.consumerFallback` and `profile.injectOpenTier` are read through
 * predicates evaluated at use, not snapshotted at construction, so both are live
 * toggles instead of restart-only ones. `profile.enabled` and `profile.path` are
 * necessarily construction-time: they decide whether a file is opened and which
 * one, and changing either genuinely needs the store rebuilt.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { ConfigManager } from '../../config/manager.js';
import { OwnerProfileStore, resolveOwnerProfilePath } from '../../owner-profile/index.js';
import { installOwnerProfileConsumers } from '../../owner-profile/consumers.js';
import { registerOwnerProfileGatewayMethods } from './owner-profile.js';
import { logger } from '../../utils/logger.js';

/** What the composition needs from the runtime graph. */
export interface OwnerProfileCompositionDeps {
  /** Reads the `profile.*` policy and receives the consumer read fallback. */
  readonly configManager: Pick<ConfigManager, 'get' | 'attachProfileFallback'>;
  /** `--daemon-home`, when the host parsed one. Absent ⇒ env, then `~/.goodvibes`. */
  readonly daemonHome?: string | undefined;
}

/** The store, and the one call that unwires everything this installed. */
export interface OwnerProfileComposition {
  readonly store: OwnerProfileStore;
  readonly dispose: () => void;
}

export function composeOwnerProfile(
  catalog: GatewayMethodCatalog,
  deps: OwnerProfileCompositionDeps,
): OwnerProfileComposition {
  const config = deps.configManager;
  const store = new OwnerProfileStore({
    // One resolver, honouring `profile.path`, then `--daemon-home`, then
    // GOODVIBES_DAEMON_HOME, then `~/.goodvibes/daemon/`. Deliberately not a
    // second computation of that order here: the daemon-home round has already
    // been paid for once by exactly that kind of duplicate.
    path: resolveOwnerProfilePath({
      override: config.get('profile.path'),
      ...(deps.daemonHome === undefined ? {} : { daemonHomeArg: deps.daemonHome }),
    }),
    enabled: config.get('profile.enabled'),
    reloadThrottleMs: config.get('profile.reloadThrottleMs'),
  });

  // All three read live, per call, so each is a real toggle rather than a
  // restart-only one — the same treatment consumerFallback and injectOpenTier
  // already get below.
  registerOwnerProfileGatewayMethods(catalog, store, {
    autonomousWrites: () => config.get('profile.autonomousWrites'),
    discloseWrites: () => config.get('profile.discloseWrites'),
    discloseClosedTierReads: () => config.get('profile.discloseClosedTierReads'),
  });
  const uninstallConsumers = installOwnerProfileConsumers(store, {
    attachProfileFallback: (reader) => config.attachProfileFallback(reader),
    consumerFallbackEnabled: () => config.get('profile.consumerFallback'),
    injectOpenTierEnabled: () => config.get('profile.injectOpenTier'),
  });

  void store.load().then((state) => {
    // Counts and names only; the store's own logging never carries a value.
    logger.debug('owner-profile: initial load', { kind: state.kind, path: state.path });
    store.watch();
  });

  return {
    store,
    dispose: (): void => {
      store.unwatch();
      uninstallConsumers();
    },
  };
}
