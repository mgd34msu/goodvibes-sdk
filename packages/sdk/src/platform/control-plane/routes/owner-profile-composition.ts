/**
 * routes/owner-profile-composition.ts
 *
 * Builds the one owner-profile store this process has, attaches the `profile.*`
 * verb handlers to it, and plugs it into every consumer seam. Same shape as
 * push-composition.ts / browser-composition.ts / calendar-composition.ts: the
 * registrar calls one function and gets back a teardown.
 *
 * ## The load is synchronous, and finishes before this returns
 *
 * `registerGatewayVerbGroups` is synchronous, so an awaited load would ripple
 * through the whole composition root, but starting one and letting this
 * function return was worse. It left a window in which the profile existed and
 * had not been read, and "your profile has not been loaded yet" is not one of
 * §4.4's three states. Below the verb layer it was worse still: the config
 * fallback was attached but resolved nothing, so `checkin.quietHours` read as
 * unset and a first turn landing in that window got no open-tier block, with
 * nothing logged to connect a check-in firing at the wrong hour to a restart.
 *
 * `store.loadSync()` closes it outright. By the time this returns, the state is
 * loaded, disabled, or unavailable with a reason, one of the three, always.
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
import { installOccasions, type OccasionsInstallDeps } from './occasions-composition.js';
import type { PersonalCaptureHolder } from '../../personal-capture/index.js';
import { logger } from '../../utils/logger.js';

/** What the composition needs from the runtime graph. */
export interface OwnerProfileCompositionDeps {
  /** Reads the `profile.*` policy and receives the consumer read fallback. */
  readonly configManager: Pick<ConfigManager, 'get' | 'attachProfileFallback'>;
  /** `--daemon-home`, when the host parsed one. Absent ⇒ env, then `homeDir`. */
  readonly daemonHome?: string | undefined;
  /**
   * The home directory the RUNTIME is actually using, `runtimeServices
   * .homeDirectory`, not the login user's.
   *
   * A runtime constructed with an injected home (a test suite, an isolated
   * daemon, a second instance under a scratch root) had no way to say so here:
   * the resolver fell through to the login home and this composition read the
   * profile of whoever was logged in. That is how the daemon test suite came to
   * read the owner's real profile. Threaded through to the resolver's `homeDir`
   * option so an injected home decides the file, in the same position the login
   * home occupied, `profile.path` and `--daemon-home` still win over it.
   */
  readonly homeDir?: string | undefined;
  /**
   * What the occasions loop needs, when this process is running one.
   *
   * Composed HERE rather than beside this, because occasions are lines in the
   * same document: the store built below is the one thing that owns that file,
   * and a second reader would be a second projection of it, disagreeing with
   * the first for as long as one of them had not noticed a hand edit. Absent,
   * a narrow embed, a conformance harness, and the `occasions.*` verbs stay
   * cataloged-but-unhandled, the same graceful degrade every other optional
   * group here uses.
   */
  readonly occasions?: OccasionsInstallDeps | undefined;
  /**
   * The holder the agent tool registry was built around, filled here with the
   * store and service this composition just created.
   *
   * Late-bound rather than passed into the tool registry directly because the
   * two compositions cannot be reordered: the tool registry is built before the
   * gateway verb groups, and both orders are load-bearing for other reasons.
   * The `profile` capture tool therefore exists from the start and becomes able
   * to write the moment this runs, and reports plainly, rather than throwing,
   * on the narrow window before it.
   *
   * Filled ONLY when the occasions loop is also composed: a port with a profile
   * store and no occasions service could take a fact and silently not take a
   * trip, which is the half-working state this whole change exists to end.
   */
  readonly personalCapture?: Pick<PersonalCaptureHolder, 'setPort'> | undefined;
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
    // GOODVIBES_DAEMON_HOME, then the runtime's own home directory (falling
    // back to the login home only when the runtime never injected one).
    // Deliberately not a second computation of that order here: the
    // daemon-home round has already been paid for once by exactly that kind of
    // duplicate.
    path: resolveOwnerProfilePath({
      override: config.get('profile.path'),
      ...(deps.daemonHome === undefined ? {} : { daemonHomeArg: deps.daemonHome }),
      ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
    }),
    enabled: config.get('profile.enabled'),
    reloadThrottleMs: config.get('profile.reloadThrottleMs'),
  });

  // All three read live, per call, so each is a real toggle rather than a
  // restart-only one, the same treatment consumerFallback and injectOpenTier
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

  // Synchronously, and before this function returns. An async initial load left
  // a window in which the profile existed but had not been read: every verb
  // answered "your profile has not been loaded yet", which §4.4 does not
  // sanction as a state, and, with nothing logged, `checkin.quietHours` read
  // as UNSET and the first turn's open-tier block rendered empty. A readiness
  // promise could not have closed the second half, because `ConfigManager.get()`
  // is synchronous and a fallback reader has nothing to await with. One small
  // file read at boot, on the path that already reads settings.json the same
  // way, removes the window instead of making it awaitable.
  const occasions = deps.occasions === undefined
    ? undefined
    : installOccasions(catalog, store, deps.occasions);

  // Hand the capture tool its store and service. Both or neither, see the dep's
  // comment: a port that could record a fact but not a trip is exactly the
  // half-working state being corrected.
  if (occasions && deps.personalCapture) {
    deps.personalCapture.setPort({ occasions: occasions.service, profile: store });
  }

  const state = store.loadSync();
  // Counts and names only; the store's own logging never carries a value.
  logger.debug('owner-profile: initial load', { kind: state.kind, path: state.path });
  store.watch();

  return {
    store,
    dispose: (): void => {
      store.unwatch();
      uninstallConsumers();
    },
  };
}
