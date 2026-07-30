/**
 * routes/occasions-composition.ts
 *
 * Builds the one occasions service this process has, attaches the `occasions.*`
 * verb handlers to it, and hands back a teardown. Same shape as
 * owner-profile-composition.ts: the registrar calls one function.
 *
 * ## It is composed over the owner-profile store, not beside it
 *
 * Occasions live in the owner's profile, so this takes the store that already
 * owns that file rather than opening it a second time. A second reader would be
 * a second projection of the same document, disagreeing with the first for as
 * long as one of them had not noticed a hand edit.
 *
 * ## Delivery is bound, not invented
 *
 * The nudge goes out over the channel delivery router — the same substrate the
 * proactive check-in uses — with the target parsed by the router's own parser.
 * That includes the `agent` destination: the router carries a strategy for it,
 * and the agent product registers the sender that lands the message in its
 * conversation (`channels/delivery/strategies-agent.ts`). Nothing about this
 * file has to know which of the configured destinations is a transport and which
 * is another product.
 *
 * When no router is wired the service still runs and still records what is
 * outstanding; `occasions.pending` is then the only way a nudge is seen.
 *
 * ## Something has to run the sweep
 *
 * A loop that only runs when a verb asks it to is not proactive, and proactive
 * is the whole feature. So this arms a repeating timer, re-read from config on
 * every tick so `occasions.sweepIntervalMinutes` is a live setting rather than a
 * restart-only one.
 *
 * The timer is deliberately dumb, because the SWEEP is where the judgement is:
 * a tick inside quiet hours raises nothing and reaps anyway, and a tick on a day
 * an occasion has already been raised finds its open item not yet due. So the
 * interval decides how soon the first nudge lands and nothing else — it cannot
 * make the system nag. It is `unref`'d so it never holds the process open, and
 * a tick that overlaps a still-running one is skipped rather than queued.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { parseChannelDeliveryTarget } from '../../channels/delivery/types.js';
import type { ChannelDeliveryRouter } from '../../channels/delivery-router.js';
import type { OwnerProfileStore } from '../../owner-profile/index.js';
import { OccasionStateStore } from '../../occasions/state-store.js';
import { OccasionsService } from '../../occasions/service.js';
import { readOccasionsPolicy } from '../../occasions/policy.js';
import { startOccasionSweepTicker } from '../../occasions/ticker.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { registerOccasionsGatewayMethods } from './occasions.js';

/** What the composition needs from the runtime graph. */
export interface OccasionsCompositionDeps {
  /** The store that already owns the owner-profile file. */
  readonly ownerProfile: OwnerProfileStore;
  /** Reads the live `occasions.*` and `daemon.timezone` policy. */
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** Absolute path of the machine-owned state file. */
  readonly statePath: string;
  /** Where a nudge is delivered. Absent ⇒ pull-only, through `occasions.pending`. */
  readonly channelDeliveryRouter?: Pick<ChannelDeliveryRouter, 'deliver'> | undefined;
}

export interface OccasionsComposition {
  readonly service: OccasionsService;
  readonly state: OccasionStateStore;
  readonly dispose: () => Promise<void>;
}

export function composeOccasions(
  catalog: GatewayMethodCatalog,
  deps: OccasionsCompositionDeps,
): OccasionsComposition {
  const profile = deps.ownerProfile;
  const state = new OccasionStateStore(deps.statePath);
  const router = deps.channelDeliveryRouter;

  const service = new OccasionsService({
    // The three narrow reads, bound to the ONE store that owns the file. The
    // occasions reader deliberately cannot ask for an arbitrary section: the
    // profile store has no such call, and giving it one here would re-open the
    // enumerate-all hole its tier filter exists to close.
    profile: {
      importantDates: () => profile.importantDates(),
      plans: () => profile.plans(),
      person: (name) => profile.person(name),
    },
    writer: {
      append: (input) => profile.append(input),
      forget: (input) => profile.forget(input),
    },
    state,
    // Read live, per call, so every `occasions.*` setting is a real toggle
    // rather than a restart-only one. The keys are string-addressed because the
    // ConfigKey union is shrink-only and this narrows to it at the boundary.
    config: {
      get: (key: string): unknown => deps.configManager.get(key as ConfigKey),
      set: (): void => {
        // Settings are written through the ordinary config surface, which is
        // what puts them in the generated settings UIs. A second write path
        // here would be a second place for a default to drift.
      },
    },
    ...(router === undefined
      ? {}
      : {
        deliverer: {
          deliver: async ({ channel, nudge }) => router.deliver({
            target: parseChannelDeliveryTarget(channel),
            body: nudge.message,
            title: 'A date is coming up',
            jobId: 'occasions',
            runId: nudge.id,
            includeLinks: false,
          }),
        },
      }),
  });

  registerOccasionsGatewayMethods(catalog, service);

  // The repeating pass. Its rules and the reasoning behind them live in
  // occasions/ticker.ts, which takes an injected timer so they are testable by
  // advancing a counter rather than by waiting an hour.
  const ticker = startOccasionSweepTicker({
    sweep: async () => {
      const outcome = await service.sweep();
      // Counts and a hold reason only. A date, a person and a message never
      // reach a log at any level: this file's whole subject is closed tier.
      logger.debug('occasions: swept', {
        hold: outcome.hold,
        raised: outcome.nudge?.subjects.length ?? 0,
        conflicts: outcome.conflictMessages.length,
        delivered: outcome.delivered,
      });
      // A destination that went quiet is worth a warning even though the sweep
      // itself succeeded, and it is named by SURFACE rather than by the full
      // target: a target can carry a chat id, and an address is closed tier too.
      // The router has already logged each failure against its own strategy.
      const failed = outcome.deliveries.filter((entry) => entry.failure !== null);
      if (failed.length > 0) {
        logger.warn('occasions: a nudge destination did not accept the nudge', {
          surfaces: failed.map((entry) => entry.channel.split(':', 1)[0] ?? ''),
          delivered: outcome.delivered,
        });
      }
    },
    intervalMs: () => readOccasionsPolicy({
      get: (key) => deps.configManager.get(key as ConfigKey),
      set: () => undefined,
    }).sweepIntervalMinutes * 60_000,
    onError: (error) => {
      logger.warn('occasions: sweep failed', { error: summarizeError(error) });
    },
  });

  return {
    service,
    state,
    dispose: async (): Promise<void> => {
      ticker.stop();
      // Let every queued write finish before the process tears down. An
      // acknowledgement lost at shutdown means he is asked again about
      // something he already answered.
      await state.drain();
    },
  };
}

/**
 * What the gateway registrar has to hand when it installs this.
 *
 * Declared here rather than as an inline object at the call site so the
 * registrar's own file — which is at the repo's line-cap ceiling — carries one
 * line for this feature rather than a dozen, and so the reasoning about WHICH
 * pieces are needed lives beside the composition that needs them.
 */
export interface OccasionsInstallDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly shellPaths: { resolveUserPath(...segments: string[]): string };
  readonly channelDeliveryRouter?: Pick<ChannelDeliveryRouter, 'deliver'> | undefined;
  readonly disposal?: { add(label: string, dispose: () => void): void } | undefined;
}

/**
 * Compose the occasions loop and register its teardown.
 *
 * Called wherever the owner profile is composed, because the profile store is
 * the one thing it cannot do without. Everything else is optional: with no
 * delivery router it still reads, still answers and still records what is
 * outstanding, which is how the agent surface receives a nudge in any case.
 */
export function installOccasions(
  catalog: GatewayMethodCatalog,
  ownerProfile: OwnerProfileStore,
  deps: OccasionsInstallDeps,
): OccasionsComposition {
  const composition = composeOccasions(catalog, {
    ownerProfile,
    configManager: deps.configManager,
    statePath: deps.shellPaths.resolveUserPath('control-plane', 'occasions-state.json'),
    ...(deps.channelDeliveryRouter === undefined
      ? {}
      : { channelDeliveryRouter: deps.channelDeliveryRouter }),
  });
  deps.disposal?.add('occasions', () => void composition.dispose());
  return composition;
}
