/**
 * schema-domain-fleet.ts — the fleet config domain (`fleet.*`).
 *
 * `fleet.maxSize` is the ONE agent ceiling ("Maximum fleet size", owner-named
 * 2026-07-13): native spawned agents, ACP-hosted rows, and elastic fixers all
 * count against it — no per-path sibling caps, ever. It renamed from the
 * legacy `orchestration.maxActiveAgents` (invisible key migration with a
 * one-line receipt; spawn refusals name this key). The cap counts
 * RESPONSIBILITY, not visibility: only agents the daemon spawned/hosts count
 * (see runtime/orchestration/fleet-count.ts).
 */
import { numRange, type ConfigSettingDefinition } from './schema-shared.js';

/** Fleet policy (`fleet.*`). */
export interface FleetConfig {
  maxSize: number;
}
declare module './schema-types.js' {
  interface GoodVibesConfig {
    fleet: FleetConfig;
  }
}

export const fleetConfigDefaults: { fleet: FleetConfig } = {
  fleet: { maxSize: 8 },
};

export const fleetConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'fleet.maxSize',
    type: 'number',
    default: 8,
    description:
      'Maximum fleet size — the one ceiling on agents this daemon is responsible for: native spawned agents, ACP-hosted agents, and elastic fix-task agents all count against it. Externally-launched agents merely observed on the host never count. Renamed from orchestration.maxActiveAgents.',
    ...numRange(1, 20),
  },
];
