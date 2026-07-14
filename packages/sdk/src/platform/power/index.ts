/**
 * power/ — sleep ownership: automatic work inhibition, sleep-edge honesty,
 * and the owner's keep-awake toggle (see manager.ts for the ruling's shape).
 */
export { PowerManager, LID_SWITCH_HONEST_SPLIT } from './manager.js';
export type { PowerState, PowerInhibitorView, PowerManagerOptions, PowerSleepEdgeHooks } from './manager.js';
export { createLinuxLogindSeam, reapOrphanedInhibitors } from './linux-logind.js';
export type { OrphanReaperDeps, SleepWatchSpawner } from './linux-logind.js';
export { bindPowerWorkSignals } from './work-signals.js';
export { wireRuntimePower, createHostPowerSeam } from './runtime-wiring.js';
export type { RuntimePowerWiringInput } from './runtime-wiring.js';
export type { PowerWorkSignalBus } from './work-signals.js';
export { createUnavailablePowerSeam } from './types.js';
export type { PowerPlatformSeam, PowerInhibitHandle, PowerInhibitClass } from './types.js';
