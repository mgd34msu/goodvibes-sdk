/**
 * power/runtime-wiring.ts — one-call composition of sleep ownership for the
 * runtime-services root: pick the platform seam (Linux logind on linux; the
 * honest unavailable seam elsewhere until the macOS IOKit seam lands), start
 * the PowerManager (which re-applies a persisted keep-awake toggle), bind the
 * bus work signals (turns / agents / scheduled runs), register the sleep-edge
 * hooks, and broadcast every state change as runtime.ops
 * OPS_POWER_STATE_CHANGED for the always-visible chip.
 */
import { platform as osPlatform } from 'node:os';
import { PowerManager, type PowerSleepEdgeHooks } from './manager.js';
import { bindPowerWorkSignals, type PowerWorkSignalBus } from './work-signals.js';
import { createLinuxLogindSeam } from './linux-logind.js';
import { createUnavailablePowerSeam, type PowerPlatformSeam } from './types.js';
import { emitOpsPowerStateChanged } from '../runtime/emitters/ops.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

export interface RuntimePowerWiringInput {
  readonly readConfig: (key: string) => unknown;
  readonly writeConfig: (key: string, value: boolean) => void;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /** Checkpoint hook for PrepareForSleep(true) — checkpoint what's checkpointable. */
  readonly sleepCheckpoint?: (() => void | Promise<void>) | undefined;
  /** Catch-up hooks for wake: re-arm timers, reconnect, deliver missed receipts. */
  readonly wakeCatchUp?: ReadonlyArray<() => void | Promise<void>> | undefined;
  /** Injectable seam override (tests / future macOS IOKit wiring). */
  readonly seam?: PowerPlatformSeam | undefined;
}

/** Compose and start the runtime's PowerManager. Never throws; never blocks startup. */
export function wireRuntimePower(input: RuntimePowerWiringInput): PowerManager {
  const seam = input.seam ?? (osPlatform() === 'linux'
    ? createLinuxLogindSeam()
    : createUnavailablePowerSeam(`no power seam for ${osPlatform()} yet`));
  const manager = new PowerManager({
    seam,
    readConfig: input.readConfig,
    writeConfig: input.writeConfig,
    onStateChanged: input.runtimeBus
      ? (state) => {
        emitOpsPowerStateChanged(input.runtimeBus!, { sessionId: 'system', traceId: `power:${Date.now()}`, source: 'power-manager' }, {
          inhibited: state.work.held || state.keepAwake.held,
          keepAwake: state.keepAwake.enabled,
          workReasons: state.work.reasons,
          note: state.keepAwake.note ?? undefined,
        });
      }
      : undefined,
  });
  if (input.runtimeBus) {
    bindPowerWorkSignals(input.runtimeBus as unknown as PowerWorkSignalBus, manager);
  }
  const hooks: PowerSleepEdgeHooks = {
    onSleep: input.sleepCheckpoint,
    onWake: input.wakeCatchUp
      ? async () => {
        for (const hook of input.wakeCatchUp!) await hook();
      }
      : undefined,
  };
  if (hooks.onSleep || hooks.onWake) manager.onSleepEdge(hooks);
  void manager.start();
  return manager;
}
