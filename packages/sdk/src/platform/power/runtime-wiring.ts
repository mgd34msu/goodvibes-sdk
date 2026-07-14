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
  /** Live config subscription (ConfigManager.subscribe shape) so power.keepAwake changes apply live. */
  readonly subscribeConfig?: ((key: string, cb: (newValue: unknown) => void) => () => void) | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /** Checkpoint hook for PrepareForSleep(true) — checkpoint what's checkpointable. */
  readonly sleepCheckpoint?: (() => void | Promise<void>) | undefined;
  /** Catch-up hooks for wake: re-arm timers, reconnect, deliver missed receipts. */
  readonly wakeCatchUp?: ReadonlyArray<() => void | Promise<void>> | undefined;
  /** Injectable seam override (tests / future macOS IOKit wiring). */
  readonly seam?: PowerPlatformSeam | undefined;
}

/**
 * The real host power seam for the current OS: Linux logind (which spawns the
 * systemd-inhibit inhibitor children and the read-only sleep-edge dbus-monitor
 * watcher) or the honest unavailable seam elsewhere. Spawning a real
 * sleep-edge watcher is a host-level side effect, so only the standalone
 * daemon opts into it — the generic runtime-services factory defaults to the
 * unavailable seam (no spawn) for test determinism, exactly like the
 * observe-external-agents host scan.
 */
export function createHostPowerSeam(): PowerPlatformSeam {
  return osPlatform() === 'linux'
    ? createLinuxLogindSeam()
    : createUnavailablePowerSeam(`no power seam for ${osPlatform()} yet`);
}

/** Compose and start the runtime's PowerManager. Never throws; never blocks startup. */
export function wireRuntimePower(input: RuntimePowerWiringInput): PowerManager {
  const seam = input.seam ?? createHostPowerSeam();
  const manager = new PowerManager({
    seam,
    readConfig: input.readConfig,
    writeConfig: input.writeConfig,
    subscribeConfig: input.subscribeConfig,
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
