/**
 * fleet-count.ts — the RESPONSIBILITY-counting seam for the one fleet ceiling
 * (`fleet.maxSize`).
 *
 * One fleet, one cap: native spawned agents, ACP-hosted rows, and elastic
 * fixers (which spawn through the same native AgentManager) all count against
 * the same ceiling. The cap counts RESPONSIBILITY, not visibility (owner
 * rider, 2026-07-13): this interface accepts ONLY owned sources — agents the
 * daemon spawned or hosts. Externally-launched agents observed on the host
 * have no seam here BY CONSTRUCTION; when the observed-row capability ships
 * (the following surface round), its rows are structurally unable to enter
 * this count.
 */
import { FLEET_MAX_SIZE_KEY } from './spawn-policy.js';
import { fleetConfigDefaults } from '../../config/schema-domain-fleet.js';
import type { FleetCapacityProbe } from '../../orchestration/elastic-pool.js';

/** The OWNED agent sources — and only those — that count against fleet.maxSize. */
export interface OwnedAgentSources {
  /** Active (pending/running) agents the daemon's AgentManager spawned — including elastic fixers, which spawn through it. */
  countNativeActive(): number;
  /** Live ACP-hosted agent sessions this daemon hosts. Absent when no ACP host is composed. */
  countAcpHosted?: (() => number) | undefined;
}

/** Agents the daemon is responsible for right now. */
export function countOwnedActiveAgents(sources: OwnedAgentSources): number {
  return sources.countNativeActive() + (sources.countAcpHosted?.() ?? 0);
}

/** Build the live fleet-capacity probe the elastic pool gates claims against. */
export function fleetCapacityProbeFrom(deps: {
  readonly readConfig: (key: string) => unknown;
  readonly sources: OwnedAgentSources;
}): FleetCapacityProbe {
  const raw = deps.readConfig(FLEET_MAX_SIZE_KEY);
  const maxSize = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? raw
    : fleetConfigDefaults.fleet.maxSize;
  return {
    active: countOwnedActiveAgents(deps.sources),
    maxSize,
    capKey: FLEET_MAX_SIZE_KEY,
  };
}

/** Runtime factory: the probe over the daemon's real owned sources. */
export function makeRuntimeFleetProbe(deps: {
  readonly readConfig: (key: string) => unknown;
  readonly agentManager: { list(): ReadonlyArray<{ status: string }> };
  readonly acpHost: { list(): ReadonlyArray<unknown> };
}): () => FleetCapacityProbe {
  return () => fleetCapacityProbeFrom({
    readConfig: deps.readConfig,
    sources: {
      countNativeActive: () => deps.agentManager.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length,
      countAcpHosted: () => deps.acpHost.list().length,
    },
  });
}
