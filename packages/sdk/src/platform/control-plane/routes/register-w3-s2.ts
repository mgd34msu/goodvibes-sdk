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
import { registerFleetGatewayMethods, type FleetQueryOnlyRegistry, type FleetAttemptsController } from './fleet.js';
import { registerCheckpointGatewayMethods, type CheckpointsGatewayManager, type CheckpointsEventSink } from './checkpoints.js';
import { registerSessionSearchGatewayMethod, type SessionSearchBroker } from './session-search.js';
import { createEventEnvelope } from '../../runtime/events/index.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../../runtime/events/index.js';
import type { WorkspaceEvent } from '../../../events/workspace.js';

export interface W3S2GatewayDeps {
  readonly processRegistry: FleetQueryOnlyRegistry;
  readonly workspaceCheckpointManager: CheckpointsGatewayManager;
  readonly sessionBroker: SessionSearchBroker;
  /**
   * Optional runtime event bus. When present, checkpoints.revertHunk's receipt
   * (HUNK_REVERTED) fans out on the workspace domain; absent → the verb still
   * works, it just emits no event (graceful degrade, like every runtimeBus-gated
   * source in register-gateway-verb-groups).
   */
  readonly runtimeBus?: Pick<RuntimeEventBus, 'emit'> | undefined;
  /**
   * Optional best-of-N controller (the orchestration engine's held-merge
   * methods). When present, the fleet.attempts.* verbs are registered; absent →
   * they stay cataloged-but-unhandled (graceful degrade for embeds with no
   * orchestration engine).
   */
  readonly attemptsController?: FleetAttemptsController | undefined;
}

export function registerW3S2GatewayMethods(catalog: GatewayMethodCatalog, deps: W3S2GatewayDeps): void {
  registerFleetGatewayMethods(catalog, deps.processRegistry, deps.attemptsController);
  const bus = deps.runtimeBus;
  const checkpointsEmit: CheckpointsEventSink | undefined = bus
    ? (event: WorkspaceEvent, sessionId: string): void => {
      const envelope = createEventEnvelope(event.type, event, { sessionId, source: 'checkpoints-revert-hunk' });
      bus.emit<'workspace'>('workspace', envelope as RuntimeEventEnvelope<WorkspaceEvent['type'], WorkspaceEvent>);
    }
    : undefined;
  registerCheckpointGatewayMethods(catalog, deps.workspaceCheckpointManager, checkpointsEmit);
  registerSessionSearchGatewayMethod(catalog, deps.sessionBroker);
}
