/**
 * routes/register-w3-s2.ts
 *
 * Single composite entry point for the fleet.*, checkpoints.*, sessions.search
 * verb-registration calls (see CHANGELOG 1.0.0), so ../../runtime/services.ts —
 * already at its line-cap ceiling — only needs one import and one call
 * instead of three of each. See routes/fleet.ts, routes/checkpoints.ts, and
 * routes/session-search.ts for what each registration actually does and why
 * it's a catalog.register(descriptor, handler) call rather than a daemon-sdk
 * REST route or a router.ts change.
 *
 * Call once, at RuntimeServices construction time, after processRegistry,
 * workspaceCheckpointManager, and sessionBroker all exist (processRegistry
 * is constructed last of the three, so the call site is right after it).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import { registerFleetGatewayMethods, type FleetQueryOnlyRegistry } from './fleet.js';
import { registerCheckpointGatewayMethods, type CheckpointsGatewayManager } from './checkpoints.js';
import { registerSessionSearchGatewayMethod, type SessionSearchBroker } from './session-search.js';

export interface W3S2GatewayDeps {
  readonly processRegistry: FleetQueryOnlyRegistry;
  readonly workspaceCheckpointManager: CheckpointsGatewayManager;
  readonly sessionBroker: SessionSearchBroker;
}

export function registerW3S2GatewayMethods(catalog: GatewayMethodCatalog, deps: W3S2GatewayDeps): void {
  registerFleetGatewayMethods(catalog, deps.processRegistry);
  registerCheckpointGatewayMethods(catalog, deps.workspaceCheckpointManager);
  registerSessionSearchGatewayMethod(catalog, deps.sessionBroker);
}
