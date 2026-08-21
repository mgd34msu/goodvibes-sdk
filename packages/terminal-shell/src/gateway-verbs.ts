/**
 * gateway-verbs.ts, attach handlers for every ws-only gateway verb group, and
 * build the archive-aware fleet registry, in one shared place both daemon
 * front-ends consume.
 *
 * The GatewayMethodCatalog's builtin DESCRIPTORS make fleet.* (including the
 * archive verbs), checkpoints.*, sessions.search, and push.* appear in the
 * contract, but a descriptor without an attached handler answers
 * 501 "Gateway method is not invokable" over both websocket and HTTP invoke.
 * A composition root that registers those descriptors but never calls the SDK's
 * registration entry point ships exactly that 501 for the whole ws-only family
 *, the regression this package exists to make impossible to reintroduce
 * independently in each front-end. `attachWsOnlyGatewayVerbHandlers` binds the
 * descriptors and their handlers together, and the conformance helper in
 * ./conformance.ts gates that no descriptor is ever left handler-less.
 *
 * This module is a thin, dependency-injected wrapper over the SDK's own
 * registration entry points. Front-ends pass their concrete managers in; the
 * package owns the wiring so it cannot drift between them.
 */
import {
  registerGatewayVerbGroups,
  type GatewayMethodCatalog,
  type GatewayVerbGroupDeps,
} from '@pellux/goodvibes-sdk/platform/control-plane';
import {
  createProcessRegistry,
  withFleetArchive,
  type ArchivableProcessRegistry,
  type ProcessRegistryDeps,
} from '@pellux/goodvibes-sdk/platform/runtime/fleet';
import { ObservedAgentSource } from '@pellux/goodvibes-sdk/platform/runtime/fleet/observed';
import { computeUsageCostUsd, type ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';

/**
 * Attach handlers for the ws-only gateway verb groups (fleet.* / checkpoints.* /
 * sessions.search / push.*) onto an existing catalog. Descriptors and handlers
 * are registered together, so a verb can never be descriptor-present but
 * handler-absent (the 501 regression class).
 *
 * Call once, at composition time, after the injected managers all exist. The
 * dependency shape (`GatewayVerbGroupDeps`) is owned by the SDK; this wrapper
 * exists so each front-end has a single named call site instead of reaching
 * into the SDK's registration internals directly and diverging.
 */
export function attachWsOnlyGatewayVerbHandlers(
  gatewayMethods: GatewayMethodCatalog,
  deps: GatewayVerbGroupDeps,
): void {
  registerGatewayVerbGroups(gatewayMethods, deps);
}

/**
 * Build the one shared, archive-aware process registry that aggregates a
 * front-end's runtime managers (agents, WRFC chains, workflows, watchers,
 * background processes). Constructed once per composition, not per consumer,
 * so the coalesced tick and the agent-activity side-table are shared, not
 * duplicated. Archive-aware: finished agent/swarm subtrees can be moved out of
 * the live fleet view into a session-scoped archive (see the SDK's
 * fleet/archive.ts).
 *
 * This is the registry the fleet.* gateway verbs above query, so building it
 * here keeps the registry and its verb handlers on the same shared seam.
 */
export function createArchivableFleetRegistry(deps: ProcessRegistryDeps): ArchivableProcessRegistry {
  return withFleetArchive(createProcessRegistry(deps));
}

export interface FleetServicesDeps
  extends Omit<ProcessRegistryDeps, 'observedAgents' | 'priceUsage'> {
  /**
   * Turns on the observed foreign-agent source: externally-launched coding-agent
   * sessions observed read-only on the host fold in as 'observed-external' rows
   * (visibility + steer; never counted against fleet.maxSize, never stopped).
   * The host that owns the scan sets it; a front-end reading that host's
   * snapshot leaves it off so nothing double-scans. Absence ⇒ a quiet empty set.
   */
  readonly observeExternalAgents?: boolean | undefined;
  /** Backs the honest pricing resolver folded into `priceUsage` below. */
  readonly providerRegistry: Pick<ProviderRegistry, 'resolveModelPricing'>;
}

/**
 * The archive-aware fleet registry plus the two decisions every front-end makes
 * around it: whether this process observes foreign agents, and how a row's
 * usage becomes money.
 */
export function createFleetServices(
  deps: FleetServicesDeps,
): { processRegistry: ArchivableProcessRegistry } {
  const { observeExternalAgents, providerRegistry, ...registryDeps } = deps;
  const observedAgents = observeExternalAgents ? new ObservedAgentSource() : undefined;
  const processRegistry = createArchivableFleetRegistry({
    ...registryDeps,
    observedAgents,
    // Honest-unpriced through the ONE pricing resolver (manual -> registration
    // -> provider-served -> catalog -> unknown); unknown/subscription yields
    // null, never $0.
    priceUsage: (model, usage) => (model ? computeUsageCostUsd(providerRegistry.resolveModelPricing(model), usage) : null),
  });
  return { processRegistry };
}

export type { GatewayVerbGroupDeps, ProcessRegistryDeps, ArchivableProcessRegistry };
