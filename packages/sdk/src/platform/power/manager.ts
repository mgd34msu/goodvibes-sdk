/**
 * power/manager.ts — sleep ownership policy over the platform seam.
 *
 * Three responsibilities, per the recorded ruling:
 *
 * 1. AUTOMATIC work inhibition: while real work runs (a running turn, an
 *    active agent/fleet node, a schedule about to fire — callers hold/release
 *    named work holds), an idle+sleep inhibitor is held, hard time-capped
 *    (honest, configurable cap) and released when work drains. State is
 *    always inspectable as "held because X".
 * 2. SLEEP-EDGE honesty: on PrepareForSleep(true) every registered checkpoint
 *    callback runs (checkpoint what's checkpointable); on wake the catch-up
 *    callbacks run (re-arm timers, reconnect, deliver missed-run receipts
 *    through each job's own path).
 * 3. THE OWNER TOGGLE (keep-awake): daemon-held, INDEPENDENT of work state —
 *    it survives surfaces closing; covers idle + sleep + lid-switch classes
 *    where grantable and states the split honestly where the lid-switch block
 *    is refused ("idle sleep blocked; lid-close suspend is controlled by your
 *    OS here"). NO timers, NO AC-only sub-options — the always-visible chip
 *    (served from getState over the contract) is the safety mechanism.
 */
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from './types.js';

const WORK_CLASSES: readonly PowerInhibitClass[] = ['idle', 'sleep'];
const KEEP_AWAKE_CLASSES: readonly PowerInhibitClass[] = ['idle', 'sleep', 'handle-lid-switch'];
/** The ruling's honest-split line when a lid-switch block is not grantable. */
export const LID_SWITCH_HONEST_SPLIT = 'idle sleep blocked; lid-close suspend is controlled by your OS here';

export interface PowerInhibitorView {
  readonly held: boolean;
  readonly grantedClasses: readonly PowerInhibitClass[];
  readonly deniedClasses: readonly PowerInhibitClass[];
}

/** The full state the contract serves (surfaces render the chip from this). */
export interface PowerState {
  readonly platform: string;
  readonly work: PowerInhibitorView & {
    /** The live reasons the inhibitor is held ("held because X"). */
    readonly reasons: readonly string[];
    readonly heldSince: number | null;
    readonly capMinutes: number;
    /** When the hard cap will force-release the WORK inhibitor (never the toggle). */
    readonly capExpiresAt: number | null;
    /** True when the cap fired and released a still-working inhibitor (honest). */
    readonly capExpired: boolean;
  };
  readonly keepAwake: PowerInhibitorView & {
    readonly enabled: boolean;
    /** The honest-split note when part of the requested coverage was refused. */
    readonly note: string | null;
  };
}

export interface PowerSleepEdgeHooks {
  /** Checkpoint what's checkpointable — runs on PrepareForSleep(true). */
  readonly onSleep?: (() => void | Promise<void>) | undefined;
  /** Catch-up: re-arm timers, reconnect, deliver missed receipts — runs on wake. */
  readonly onWake?: (() => void | Promise<void>) | undefined;
}

export interface PowerManagerOptions {
  readonly seam: PowerPlatformSeam;
  /** Live config reads (power.* keys); absent keys use the shipped defaults. */
  readonly readConfig?: ((key: string) => unknown) | undefined;
  /** Persist the keep-awake toggle (power.keepAwake) when set over the wire. */
  readonly writeConfig?: ((key: string, value: boolean) => void) | undefined;
  /** Emits the state-change event surfaces subscribe the chip to. */
  readonly onStateChanged?: ((state: PowerState) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_WORK_CAP_MINUTES = 180;

export class PowerManager {
  private readonly workReasons = new Map<string, string>();
  private workHandle: PowerInhibitHandle | null = null;
  private workHeldSince: number | null = null;
  private workCapTimer: ReturnType<typeof setTimeout> | null = null;
  private workCapExpired = false;
  private keepAwakeHandle: PowerInhibitHandle | null = null;
  private keepAwakeEnabled = false;
  private readonly sleepHooks: PowerSleepEdgeHooks[] = [];
  private unsubscribeSleepEdge: (() => void) | null = null;
  /** Serializes acquire/release transitions so async seam calls never race. */
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly options: PowerManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private readBool(key: string, fallback: boolean): boolean {
    const value = this.options.readConfig?.(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  private capMinutes(): number {
    const value = this.options.readConfig?.('power.workInhibitMaxMinutes');
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_WORK_CAP_MINUTES;
  }

  /** Start: apply the persisted keep-awake toggle and watch the sleep edge. */
  async start(): Promise<void> {
    if (this.options.seam.onPrepareForSleep) {
      this.unsubscribeSleepEdge = this.options.seam.onPrepareForSleep((sleeping) => {
        void this.handleSleepEdge(sleeping);
      });
    }
    if (this.readBool('power.keepAwake', false)) {
      await this.setKeepAwake(true, { persist: false });
    }
  }

  async stop(): Promise<void> {
    this.unsubscribeSleepEdge?.();
    this.unsubscribeSleepEdge = null;
    if (this.workCapTimer) clearTimeout(this.workCapTimer);
    await this.enqueue(async () => {
      await this.workHandle?.release();
      this.workHandle = null;
      await this.keepAwakeHandle?.release();
      this.keepAwakeHandle = null;
    });
  }

  /** Register sleep-edge hooks (checkpoint on sleep, catch-up on wake). */
  onSleepEdge(hooks: PowerSleepEdgeHooks): () => void {
    this.sleepHooks.push(hooks);
    return () => {
      const index = this.sleepHooks.indexOf(hooks);
      if (index >= 0) this.sleepHooks.splice(index, 1);
    };
  }

  /**
   * Hold the work inhibitor for a named piece of real work. Idempotent per id;
   * the state lists every live reason. No-op when power.inhibitWhileWorking
   * is off or the platform has no inhibitor support.
   */
  holdWork(id: string, reason: string): void {
    if (!this.readBool('power.inhibitWhileWorking', true)) return;
    this.workReasons.set(id, reason);
    void this.enqueue(() => this.reconcileWork());
  }

  /** Release one named work hold; the inhibitor drops when the last drains. */
  releaseWork(id: string): void {
    if (!this.workReasons.delete(id)) return;
    void this.enqueue(() => this.reconcileWork());
  }

  /**
   * The owner toggle: daemon-held keep-awake, independent of work state.
   * Persisted (power.keepAwake) so it survives restarts and surface closes.
   */
  async setKeepAwake(enabled: boolean, options: { persist?: boolean } = {}): Promise<PowerState> {
    this.keepAwakeEnabled = enabled;
    if (options.persist !== false) {
      try {
        this.options.writeConfig?.('power.keepAwake', enabled);
      } catch (error) {
        logger.warn('[power] keep-awake persist failed', { error: summarizeError(error) });
      }
    }
    await this.enqueue(async () => {
      if (enabled && !this.keepAwakeHandle) {
        this.keepAwakeHandle = await this.options.seam.inhibit({
          classes: KEEP_AWAKE_CLASSES,
          who: 'goodvibes keep-awake',
          why: 'owner keep-awake toggle: stay reachable after work finishes',
        });
      } else if (!enabled && this.keepAwakeHandle) {
        await this.keepAwakeHandle.release();
        this.keepAwakeHandle = null;
      }
    });
    this.emitState();
    return this.getState();
  }

  /** The state the contract serves; surfaces render the always-visible chip from it. */
  getState(): PowerState {
    const capMinutes = this.capMinutes();
    const keepAwakeDenied = this.keepAwakeHandle?.deniedClasses ?? [];
    return {
      platform: this.options.seam.platform,
      work: {
        held: this.workHandle !== null,
        grantedClasses: this.workHandle?.grantedClasses ?? [],
        deniedClasses: this.workHandle?.deniedClasses ?? [],
        reasons: [...this.workReasons.values()],
        heldSince: this.workHeldSince,
        capMinutes,
        capExpiresAt: this.workHeldSince !== null ? this.workHeldSince + capMinutes * 60_000 : null,
        capExpired: this.workCapExpired,
      },
      keepAwake: {
        enabled: this.keepAwakeEnabled,
        held: this.keepAwakeHandle !== null,
        grantedClasses: this.keepAwakeHandle?.grantedClasses ?? [],
        deniedClasses: keepAwakeDenied,
        note: this.keepAwakeHandle && keepAwakeDenied.includes('handle-lid-switch')
          ? LID_SWITCH_HONEST_SPLIT
          : null,
      },
    };
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    this.transition = this.transition.then(step).catch((error) => {
      logger.warn('[power] inhibitor transition failed', { error: summarizeError(error) });
    });
    return this.transition;
  }

  private async reconcileWork(): Promise<void> {
    const shouldHold = this.workReasons.size > 0;
    if (shouldHold && !this.workHandle) {
      this.workHandle = await this.options.seam.inhibit({
        classes: WORK_CLASSES,
        who: 'goodvibes work',
        why: [...this.workReasons.values()].join('; ') || 'work running',
      });
      if (this.workHandle) {
        this.workHeldSince = this.now();
        this.workCapExpired = false;
        this.armWorkCap();
      }
    } else if (!shouldHold && this.workHandle) {
      await this.workHandle.release();
      this.workHandle = null;
      this.workHeldSince = null;
      if (this.workCapTimer) {
        clearTimeout(this.workCapTimer);
        this.workCapTimer = null;
      }
    }
    this.emitState();
  }

  /** The hard cap: a wedged hold cannot pin the host awake forever. */
  private armWorkCap(): void {
    if (this.workCapTimer) clearTimeout(this.workCapTimer);
    this.workCapTimer = setTimeout(() => {
      this.workCapTimer = null;
      this.workCapExpired = true;
      logger.warn('[power] work inhibitor hard cap reached; releasing (work holds remain listed honestly)', {
        capMinutes: this.capMinutes(),
        reasons: [...this.workReasons.values()],
      });
      void this.enqueue(async () => {
        await this.workHandle?.release();
        this.workHandle = null;
        this.workHeldSince = null;
        this.emitState();
      });
    }, this.capMinutes() * 60_000);
    (this.workCapTimer as { unref?: () => void }).unref?.();
  }

  private async handleSleepEdge(sleeping: boolean): Promise<void> {
    for (const hooks of [...this.sleepHooks]) {
      try {
        if (sleeping) await hooks.onSleep?.();
        else await hooks.onWake?.();
      } catch (error) {
        logger.warn('[power] sleep-edge hook failed', { sleeping, error: summarizeError(error) });
      }
    }
    this.emitState();
  }

  private emitState(): void {
    try {
      this.options.onStateChanged?.(this.getState());
    } catch (error) {
      logger.warn('[power] state-change emit failed', { error: summarizeError(error) });
    }
  }
}
